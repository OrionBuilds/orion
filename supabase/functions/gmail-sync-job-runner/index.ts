import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { processGmailMessage, GMAIL_API_URL } from "../_shared/gmail-helpers.ts";
import {
  enqueueDueIncrementalJobs, findSyncState, getMailboxToken, resolveJobMailbox, saveSyncState, type GmailMailbox,
} from "../_shared/gmail-mailbox.ts";
import { BACKFILL_BUDGET_MS, isBackfillableEmail, runGmailContactBackfill } from "../_shared/contact-backfill.ts";
import { isCronRequest, isServiceRoleRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_JOBS_PER_RUN = 5;
const MAX_RETRY_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;
// The cron call (pg_net) gives up after 60 s and the platform stops the run with it, so stop well
// inside that and resume on the next tick.
const FULL_SYNC_BUDGET_MS = 40_000;
// One cron call may do several jobs but must end inside the 60 s pg_net window: stop taking jobs once
// the run has used this much, and take only a few contact backfills per tick (a bulk contact import
// queues many; they drain over successive ticks).
const RUN_BUDGET_MS = 48_000;
const MAX_BACKFILLS_PER_RUN = 3;
const FULL_JOB_TYPES = ["initial", "full_resync", "contact_backfill"];
const RUNNER_ID = crypto.randomUUID();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Cron/edge-only (verify_jwt=false): pg_cron sends X-Cron-Secret; edge callers send the service-role key.
  if (!isCronRequest(req) && !isServiceRoleRequest(req)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing environment variables");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const staleCutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
    await supabase
      .from("gmail_sync_jobs")
      .update({
        status: "retry",
        locked_at: null,
        locked_by: null,
        last_error: "Lock expired (stale runner)",
        updated_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .lt("locked_at", staleCutoff);
    // A first sync that was cut off is not a failure: don't let the cut-offs use up its attempts.
    await supabase
      .from("gmail_sync_jobs")
      .update({ attempts: 0, status: "queued", run_at: new Date().toISOString() })
      .eq("status", "retry")
      .in("job_type", FULL_JOB_TYPES)
      .eq("last_error", "Lock expired (stale runner)");

    const now = new Date().toISOString();

    // Regular jobs first; contact backfills are fetched separately so a bulk import's backlog can never
    // crowd out the first sync or incremental jobs.
    const runnable = () => supabase
      .from("gmail_sync_jobs")
      .select("*")
      .in("status", ["queued", "retry"])
      .lte("run_at", now)
      .lt("attempts", MAX_RETRY_ATTEMPTS)
      .is("locked_at", null)
      .order("run_at", { ascending: true });
    const { data: regularJobs } = await runnable().neq("job_type", "contact_backfill").limit(MAX_JOBS_PER_RUN);
    const { data: backfillJobs } = await runnable().eq("job_type", "contact_backfill").limit(MAX_BACKFILLS_PER_RUN);
    const jobs = [...(regularJobs ?? []), ...(backfillJobs ?? [])];

    if (!jobs || jobs.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No jobs to process", processed: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: Array<{ jobId: string; status: string; detail?: string }> = [];

    const runDeadline = Date.now() + RUN_BUDGET_MS;
    let backfillsTaken = 0;

    for (const job of jobs) {
      if (Date.now() > runDeadline - 8_000) break; // leave the rest queued for the next tick
      if (job.job_type === "contact_backfill" && ++backfillsTaken > MAX_BACKFILLS_PER_RUN) continue;
      const jobBudgetMs = Math.max(5_000, Math.min(FULL_SYNC_BUDGET_MS, runDeadline - Date.now() - 8_000));
      const lockTime = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabase
        .from("gmail_sync_jobs")
        .update({
          status: "running",
          locked_at: lockTime,
          locked_by: RUNNER_ID,
          attempts: (job.attempts || 0) + 1,
          updated_at: lockTime,
        })
        .eq("id", job.id)
        .in("status", ["queued", "retry"])
        .is("locked_at", null)
        .select("id")
        .maybeSingle();

      if (claimError || !claimed) {
        results.push({ jobId: job.id, status: "skipped", detail: "Could not acquire lock" });
        continue;
      }

      try {
        // The mailbox (Google connection) this job belongs to; a legacy job without one runs on the user's primary.
        const mb = await resolveJobMailbox(supabase, job);
        if (!mb) throw new Error("Gmail not connected");
        if (FULL_JOB_TYPES.includes(job.job_type)) {
          const startToken = (job.payload as { pageToken?: string } | null)?.pageToken;
          const payload = (job.payload as Record<string, unknown>) ?? {};
          const { complete, pageToken, stats } = job.job_type === "contact_backfill"
            ? await runContactBackfill(supabase, mb, job.id, payload, jobBudgetMs)
            : await runFullSync(supabase, mb, startToken, job.id, payload, jobBudgetMs);
          if (!complete) {
            // Ran out of time budget with mail left: that's progress, not a failure. Put the job
            // back (no attempt spent) with the Gmail page it reached, and the next cron tick carries on
            // from there (messages with no matching contact are skipped, so they can't mark progress).
            await supabase
              .from("gmail_sync_jobs")
              .update({
                payload: { ...((job.payload as Record<string, unknown>) ?? {}), pageToken, stats },
                status: "queued",
                attempts: 0,
                last_error: null,
                run_at: new Date().toISOString(),
                locked_at: null,
                locked_by: null,
                updated_at: new Date().toISOString(),
              })
              .eq("id", job.id);
            results.push({ jobId: job.id, status: "partial", detail: "Time budget reached; continuing next run" });
            continue;
          }
        } else if (job.job_type === "incremental") {
          await runIncrementalSync(supabase, mb);
        } else {
          throw new Error(`Unknown job type: ${job.job_type}`);
        }

        await supabase
          .from("gmail_sync_jobs")
          .update({
            status: "done",
            last_error: null,
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);

        results.push({ jobId: job.id, status: "done" });
      } catch (jobErr) {
        const errMsg = (jobErr as Error).message;
        const attempts = (job.attempts || 0) + 1;

        if (attempts >= MAX_RETRY_ATTEMPTS) {
          await supabase
            .from("gmail_sync_jobs")
            .update({
              status: "failed",
              last_error: errMsg,
              locked_at: null,
              locked_by: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id);

          results.push({ jobId: job.id, status: "failed", detail: errMsg });
        } else {
          const backoffMs = Math.pow(2, attempts) * 30_000;
          const retryAt = new Date(Date.now() + backoffMs).toISOString();

          await supabase
            .from("gmail_sync_jobs")
            .update({
              status: "retry",
              last_error: errMsg,
              run_at: retryAt,
              locked_at: null,
              locked_by: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id);

          results.push({ jobId: job.id, status: "retry", detail: `Retry at ${retryAt}` });
        }
      }
    }

    // Keep every mailbox that finished its first sync polling: one incremental job per connection.
    await enqueueDueIncrementalJobs(supabase);

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("gmail-sync-job-runner error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/**
 * History backfill for one contact: everything to or from that address in the last year. Stores
 * through processGmailMessage, so only active contacts' mail is kept and existing messages are skipped.
 */
async function runContactBackfill(
  supabase: SupabaseClient,
  mb: GmailMailbox,
  jobId: string,
  payload: Record<string, unknown>,
  budgetMs: number,
): Promise<{ complete: boolean; pageToken?: string; stats?: unknown }> {
  const orgId = mb.orgId;
  const userId = mb.userId;
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!isBackfillableEmail(email)) return { complete: true, stats: { stage: "skipped", reason: "no valid address" } };

  const accessToken = await getMailboxToken(supabase, mb);

  return await runGmailContactBackfill({
    gmailApiUrl: GMAIL_API_URL,
    accessToken,
    email,
    startToken: (payload.pageToken as string | undefined) ?? undefined,
    budgetMs: Math.min(budgetMs, BACKFILL_BUDGET_MS),
    storedIds: async (ids) => {
      const { data } = await supabase.from("messages").select("external_id").eq("organization_id", orgId).in("external_id", ids);
      return new Set((data ?? []).map((m: { external_id: string }) => m.external_id));
    },
    processMessage: async (msg) => {
      const r = await processGmailMessage(supabase, msg, orgId, userId, { connectionId: mb.connectionId, email: mb.email }, "contact_backfill");
      return r.processed;
    },
    onProgress: async ({ pageToken, stats }) => {
      await supabase.from("gmail_sync_jobs")
        .update({ payload: { ...payload, pageToken, stats }, updated_at: new Date().toISOString() })
        .eq("id", jobId);
    },
  });
}

async function runFullSync(
  supabase: SupabaseClient,
  mb: GmailMailbox,
  startToken?: string,
  jobId?: string,
  prevPayload: Record<string, unknown> = {},
  budgetMs: number = FULL_SYNC_BUDGET_MS
): Promise<{ complete: boolean; pageToken?: string; stats?: unknown }> {
  const orgId = mb.orgId;
  const userId = mb.userId;
  // Progress goes into the job's payload so a run that dies silently still shows where it got to.
  const stats: Record<string, unknown> & { stage: string; pages: number; listed: number; fetched: number; stored: number; noContact: number; httpFail: Record<string, number>; errors: number; lastError: string; startedAt: string } = { stage: "start", pages: 0, listed: 0, fetched: 0, stored: 0, noContact: 0, httpFail: {} as Record<string, number>, errors: 0, lastError: "", startedAt: new Date().toISOString() };
  const report = async (pageToken?: string) => {
    if (!jobId) return;
    try {
      await supabase.from("gmail_sync_jobs").update({ payload: { ...prevPayload, pageToken: pageToken ?? startToken, stats }, updated_at: new Date().toISOString() }).eq("id", jobId);
    } catch { /* diagnostics only */ }
  };
  await report();
  const deadline = Date.now() + budgetMs;
  await saveSyncState(supabase, mb, { sync_status: "syncing", error_message: null, updated_at: new Date().toISOString() });

  stats.stage = "token";
  await report();
  const accessToken = await getMailboxToken(supabase, mb);
  stats.stage = "listing";
  await report();

  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  // Only conversations with contacts in the OS are synced, so ask Gmail for exactly that mail instead of
  // downloading everything and discarding most of it.
  const { data: contactRows } = await supabase
    .from("contacts")
    .select("email")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .not("email", "is", null);
  const addrs = [...new Set((contactRows ?? []).map((c: { email: string | null }) => (c.email ?? "").trim().toLowerCase()).filter((e: string) => /^[^\s@<>()"]+@[^\s@<>()"]+$/.test(e)))].sort();
  const after = `after:${Math.floor(oneYearAgo.getTime() / 1000)}`;
  const people = addrs.map((a) => `from:${a} OR to:${a}`).join(" OR ");
  // Past ~60 contacts the query gets unwieldy: fall back to listing everything (each message is still
  // matched against the contacts before anything is stored, so the result is the same, just slower).
  const query = addrs.length === 0 ? null : addrs.length <= 60 ? `${after} (${people})` : after;
  // A saved page token only fits the query that produced it.
  const querySig = `${addrs.length}:${addrs.join(",").length}:${addrs[0] ?? ""}:${addrs[addrs.length - 1] ?? ""}`;
  if (((prevPayload as { stats?: { querySig?: string } }).stats?.querySig) !== querySig) startToken = undefined;
  stats.querySig = querySig;
  if (query === null) {
    // No contacts with an email address yet: nothing to sync.
    stats.stage = "no-contacts";
  }

  let nextPageToken: string | undefined = query === null ? undefined : startToken;

  do {
    const thisPage = nextPageToken;
    if (query === null) break;
    let listUrl = `${GMAIL_API_URL}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500`;
    if (nextPageToken) listUrl += `&pageToken=${nextPageToken}`;

    const listResponse = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20000),
    });

    if (!listResponse.ok) { stats.lastError = `list ${listResponse.status}`; await report(thisPage); throw new Error(`Failed to fetch messages list (${listResponse.status})`); }

    const listData = await listResponse.json();
    const messageRefs: Array<{ id: string }> = listData.messages || [];
    stats.pages++; stats.listed += messageRefs.length; stats.stage = "processing";
    await report(thisPage);
    nextPageToken = listData.nextPageToken;

    // One existence query per page instead of one per message.
    const { data: have } = await supabase
      .from("messages")
      .select("external_id")
      .eq("organization_id", orgId)
      .in("external_id", messageRefs.map((r) => r.id));
    const stored = new Set((have ?? []).map((m: { external_id: string }) => m.external_id));

    const todo = messageRefs.filter((r) => !stored.has(r.id));
    for (let i = 0; i < todo.length; i += 10) {
      if (Date.now() > deadline) return { complete: false, pageToken: thisPage, stats };
      await Promise.all(todo.slice(i, i + 10).map(async (ref) => {
        try {
          const msgRes = await fetch(
            `${GMAIL_API_URL}/users/me/messages/${ref.id}`,
            { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) }
          );
          if (!msgRes.ok) { const k = String(msgRes.status); stats.httpFail[k] = (stats.httpFail[k] ?? 0) + 1; return; }
          const msgData = await msgRes.json();
          stats.fetched++;
          const r = await processGmailMessage(supabase, msgData, orgId, userId, { connectionId: mb.connectionId, email: mb.email }, "full_sync_job");
          if (r.processed) stats.stored++; else stats.noContact++;
        } catch (e) {
          stats.errors++; stats.lastError = (e as Error).message.slice(0, 200);
          console.error("[gmail-sync-job-runner] message failed:", ref.id, (e as Error).message);
        }
      }));
      await report(thisPage);
    }
  } while (nextPageToken);

  const profileRes = await fetch(`${GMAIL_API_URL}/users/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  let historyId: string | null = null;
  if (profileRes.ok) {
    const profile = await profileRes.json();
    historyId = String(profile.historyId);
  }

  const now = new Date().toISOString();
  await saveSyncState(supabase, mb, {
    sync_status: "idle",
    last_full_sync_at: now,
    last_incremental_sync_at: now,
    history_id: historyId,
    error_message: null,
    updated_at: now,
  });

  // user_connected_accounts mirrors the primary account only
  if (mb.isPrimary) {
    await supabase
      .from("user_connected_accounts")
      .update({ last_synced_at: now })
      .eq("user_id", userId)
      .eq("provider", "google_gmail");
  }
  return { complete: true };
}

async function runIncrementalSync(
  supabase: SupabaseClient,
  mb: GmailMailbox,
) {
  const orgId = mb.orgId;
  const userId = mb.userId;
  const syncState = await findSyncState(supabase, mb);

  if (!syncState?.history_id) {
    throw new Error("No history_id, need initial sync first");
  }

  await saveSyncState(supabase, mb, { sync_status: "syncing", error_message: null, updated_at: new Date().toISOString() });

  const accessToken = await getMailboxToken(supabase, mb);

  let addedIds = new Set<string>();
  let deletedIds = new Set<string>();
  let nextPageToken: string | undefined;
  let latestHistoryId = syncState.history_id;

  do {
    let url = `${GMAIL_API_URL}/users/me/history?startHistoryId=${syncState.history_id}&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=500`;
    if (nextPageToken) url += `&pageToken=${nextPageToken}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 404) {
      throw new Error("History expired, need full resync");
    }
    if (!res.ok) throw new Error(`History API failed: ${res.status}`);

    const data = await res.json();
    for (const record of data.history || []) {
      if (record.messagesAdded) {
        for (const a of record.messagesAdded) {
          if (a.message?.id) addedIds.add(a.message.id);
        }
      }
      if (record.messagesDeleted) {
        for (const d of record.messagesDeleted) {
          if (d.message?.id) deletedIds.add(d.message.id);
        }
      }
    }

    if (data.historyId) latestHistoryId = data.historyId;
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  for (const id of deletedIds) addedIds.delete(id);

  for (const gmailMsgId of addedIds) {
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("external_id", gmailMsgId)
      .limit(1)
      .maybeSingle();

    if (existing) continue;

    const msgRes = await fetch(
      `${GMAIL_API_URL}/users/me/messages/${gmailMsgId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!msgRes.ok) continue;

    const msgData = await msgRes.json();
    await processGmailMessage(supabase, msgData, orgId, userId, { connectionId: mb.connectionId, email: mb.email }, "incremental_job");
  }

  for (const gmailMsgId of deletedIds) {
    await supabase
      .from("messages")
      .update({ hidden_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("external_id", gmailMsgId);
  }

  const now = new Date().toISOString();
  await saveSyncState(supabase, mb, {
    history_id: latestHistoryId,
    last_incremental_sync_at: now,
    sync_status: "idle",
    error_message: null,
    updated_at: now,
  });

  // user_connected_accounts mirrors the primary account only
  if (mb.isPrimary) {
    await supabase
      .from("user_connected_accounts")
      .update({ last_synced_at: now })
      .eq("user_id", userId)
      .eq("provider", "google_gmail");
  }
}
