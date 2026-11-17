import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { getValidAccessToken, graphFetch, listMsConnections, msConfig } from "../_shared/ms-graph.ts";
import { nextConnectionId, processGraphMessage, type GraphMessage } from "../_shared/ms-mail.ts";
import { BACKFILL_BUDGET_MS, isBackfillableEmail, runGraphContactBackfill } from "../_shared/contact-backfill.ts";

const MAX_JOBS_PER_RUN = 3;
const MAX_RETRY_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;
// The cron call (pg_net) is cut off after 60 s and the run with it: stop taking jobs well inside that.
const RUN_BUDGET_MS = 48_000;
const RUNNER_ID = crypto.randomUUID();
const PREFER = 'outlook.body-content-type="text", IdType="ImmutableId"';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/**
 * Backfills one contact's email history for a connected Microsoft mailbox (queued by the contacts
 * trigger, migration 20261031300000). Searches Inbox and Sent Items for the address and stores matches
 * through processGraphMessage, so the contacts-only rule and de-duplication stay in one place.
 * Cron-only (verify_jwt=false). Resumable: each run stops at its budget and the saved folder / nextLink
 * picks up on the next tick; a cut-off run does not use up an attempt.
 * A user may have several mailboxes: the job walks every active one in turn (primary first), the current one is
 * kept in payload.connection_id, and each stored message is stamped with the mailbox it came from.
 */
Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const cfg = msConfig();
  if (!cfg) return json({ error: "MS_OAUTH_* not configured" }, 500);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const now = () => new Date().toISOString();

  // A run that was cut off is not a failure: free its lock without spending an attempt.
  await supabase.from("outlook_backfill_jobs")
    .update({ status: "queued", attempts: 0, locked_at: null, locked_by: null, last_error: "Lock expired (stale runner)", run_at: now(), updated_at: now() })
    .eq("status", "running")
    .lt("locked_at", new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString());

  const { data: jobs } = await supabase.from("outlook_backfill_jobs")
    .select("*")
    .in("status", ["queued", "retry"])
    .lte("run_at", now())
    .lt("attempts", MAX_RETRY_ATTEMPTS)
    .is("locked_at", null)
    .order("run_at", { ascending: true })
    .limit(MAX_JOBS_PER_RUN);

  if (!jobs || jobs.length === 0) return json({ success: true, processed: 0 });

  const runDeadline = Date.now() + RUN_BUDGET_MS;
  const results: unknown[] = [];

  for (const job of jobs) {
    if (Date.now() > runDeadline - 8_000) break; // leave the rest queued for the next tick
    const budgetMs = Math.max(5_000, Math.min(BACKFILL_BUDGET_MS, runDeadline - Date.now() - 8_000));

    const { data: claimed } = await supabase.from("outlook_backfill_jobs")
      .update({ status: "running", locked_at: now(), locked_by: RUNNER_ID, attempts: (job.attempts ?? 0) + 1, updated_at: now() })
      .eq("id", job.id).in("status", ["queued", "retry"]).is("locked_at", null)
      .select("id").maybeSingle();
    if (!claimed) { results.push({ id: job.id, status: "skipped" }); continue; }

    const payload = (job.payload ?? {}) as { folder?: string; pageToken?: string; connection_id?: string };
    try {
      if (!isBackfillableEmail(job.email)) {
        await supabase.from("outlook_backfill_jobs")
          .update({ status: "done", locked_at: null, locked_by: null, last_error: "no valid address", updated_at: now() }).eq("id", job.id);
        results.push({ id: job.id, status: "skipped" });
        continue;
      }

      const active = (await listMsConnections(supabase, job.user_id)).filter((c) => c.connection_status === "active");
      const conn = active.find((c) => c.id === payload.connection_id) ?? active[0];
      if (!conn) throw new Error("Microsoft is not connected for this mailbox");
      const token = await getValidAccessToken(supabase, job.user_id, { cfg, connectionId: conn.id });
      const ctx = { orgId: job.organization_id, userId: job.user_id, mailboxEmail: conn.email, syncSource: "contact_backfill", connectionId: conn.id };

      const r = await runGraphContactBackfill({
        email: job.email,
        startFolder: payload.folder,
        startToken: payload.pageToken,
        budgetMs,
        graphGet: (url) => graphFetch(token, url, { headers: { Prefer: PREFER } }),
        processMessage: async (m) => (await processGraphMessage(supabase, m as unknown as GraphMessage, ctx)).processed,
        onProgress: async ({ folder, pageToken, stats }) => {
          await supabase.from("outlook_backfill_jobs")
            .update({ payload: { connection_id: conn.id, folder, pageToken, stats }, updated_at: now() }).eq("id", job.id);
        },
      });

      // Finished this mailbox: move on to the user's next one (fresh folder/page), done only after the last.
      const next = r.complete ? nextConnectionId(active.map((c) => c.id), conn.id) : null;
      await supabase.from("outlook_backfill_jobs").update(
        next
          ? { status: "queued", attempts: 0, payload: { connection_id: next }, last_error: null, run_at: now(), locked_at: null, locked_by: null, updated_at: now() }
        : r.complete
          ? { status: "done", payload: { stats: r.stats }, last_error: null, locked_at: null, locked_by: null, updated_at: now() }
          // Out of time with mail left: progress, not a failure. Back in the queue, no attempt spent.
          : { status: "queued", attempts: 0, payload: { connection_id: conn.id, folder: r.folder, pageToken: r.pageToken, stats: r.stats }, last_error: null, run_at: now(), locked_at: null, locked_by: null, updated_at: now() },
      ).eq("id", job.id);
      results.push({ id: job.id, status: r.complete && !next ? "done" : "partial", stored: r.stats.stored });
    } catch (e) {
      const msg = (e as Error).message;
      const attempts = (job.attempts ?? 0) + 1;
      console.error(`[microsoft-mail-backfill] ${job.id}: ${msg}`);
      await supabase.from("outlook_backfill_jobs").update(
        attempts >= MAX_RETRY_ATTEMPTS
          ? { status: "failed", last_error: msg.slice(0, 500), locked_at: null, locked_by: null, updated_at: now() }
          : { status: "retry", last_error: msg.slice(0, 500), run_at: new Date(Date.now() + Math.pow(2, attempts) * 30_000).toISOString(), locked_at: null, locked_by: null, updated_at: now() },
      ).eq("id", job.id);
      results.push({ id: job.id, status: attempts >= MAX_RETRY_ATTEMPTS ? "failed" : "retry", error: msg });
    }
  }
  return json({ success: true, processed: results.length, results });
});
