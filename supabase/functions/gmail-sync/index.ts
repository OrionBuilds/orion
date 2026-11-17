import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { processGmailMessage, GMAIL_API_URL } from "../_shared/gmail-helpers.ts";
import {
  getMailboxToken, listGmailMailboxes, markInitialJobsDone, resolveGmailMailbox, saveSyncState, type GmailMailbox,
} from "../_shared/gmail-mailbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const reqBody = await req.json().catch(() => ({}));
  const { org_id: orgId, user_id: userId, connection_id: connectionId } = reqBody;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing environment variables");
    }

    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") || "";
    const isServiceRole = token === serviceRoleKey;

    if (!isServiceRole) {
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: "Missing authorization" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user: caller }, error: authError } = await anonClient.auth.getUser(token);
      if (authError || !caller) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // The body carries the mailbox to sync, so a valid token alone is not
      // enough — without this any authenticated user could kick off a full
      // 365-day sync for somebody else's mailbox.
      if (userId && userId !== caller.id) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (!orgId || !userId) {
      return new Response(
        JSON.stringify({ error: "Missing org_id or user_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // One mailbox when the caller names a connection; otherwise every Gmail mailbox of the user (a one-account user has exactly one).
    let mailboxes: GmailMailbox[];
    if (connectionId) {
      const one = await resolveGmailMailbox(supabase, userId, orgId, { connectionId });
      if (!one) {
        return new Response(
          JSON.stringify({ error: "Gmail account not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      mailboxes = [one];
    } else {
      mailboxes = await listGmailMailboxes(supabase, userId, orgId);
    }

    if (mailboxes.length === 0) {
      return new Response(
        JSON.stringify({ error: "Gmail not connected" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const daysBack = (reqBody.days_back as number) || 365;
    const results: Array<Record<string, unknown>> = [];
    for (const mb of mailboxes) {
      try {
        results.push({ connection_id: mb.connectionId, email: mb.email, ...(await syncMailbox(supabase, mb, daysBack)) });
      } catch (err) {
        await saveSyncState(supabase, mb, { sync_status: "error", error_message: (err as Error).message, updated_at: new Date().toISOString() });
        if (mailboxes.length === 1) throw err;
        console.error(`Gmail sync error for ${mb.email}:`, err);
        results.push({ connection_id: mb.connectionId, email: mb.email, error: (err as Error).message });
      }
    }

    if (results.length === 1) {
      const { connection_id: _c, email: _e, ...single } = results[0];
      return new Response(
        JSON.stringify({ success: true, ...single }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const sum = (k: string) => results.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    return new Response(
      JSON.stringify({ success: results.some((r) => !r.error), processed: sum("processed"), skipped: sum("skipped"), total: sum("total"), mailboxes: results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Gmail sync error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/** First sync of ONE mailbox (its own token, history id, lock and job). */
async function syncMailbox(
  supabase: SupabaseClient,
  mb: GmailMailbox,
  daysBack: number,
): Promise<{ processed: number; skipped: number; total: number; historyId: string | null }> {
  const orgId = mb.orgId;
  const userId = mb.userId;
  const mailbox = { connectionId: mb.connectionId, email: mb.email };

  await saveSyncState(supabase, mb, { sync_status: "syncing", error_message: null, updated_at: new Date().toISOString() });

  let currentAccessToken = await getMailboxToken(supabase, mb);
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const query = `after:${Math.floor(since.getTime() / 1000)}`;

  let processedCount = 0;
  let skippedCount = 0;
  let nextPageToken: string | undefined;
  let totalFetched = 0;
  const MAX_MESSAGES = 5000;
  const TOKEN_REFRESH_INTERVAL = 500;
  let messagesSinceRefresh = 0;

  // GET with the current token; one refresh-and-retry on 401.
  const getAuthed = async (url: string): Promise<Response> => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${currentAccessToken}` }, signal: AbortSignal.timeout(15000) });
    if (res.status !== 401) return res;
    currentAccessToken = await getMailboxToken(supabase, mb);
    messagesSinceRefresh = 0;
    return await fetch(url, { headers: { Authorization: `Bearer ${currentAccessToken}` }, signal: AbortSignal.timeout(15000) });
  };

  do {
    let listUrl = `${GMAIL_API_URL}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=500`;
    if (nextPageToken) listUrl += `&pageToken=${nextPageToken}`;

    const listResponse = await getAuthed(listUrl);
    if (!listResponse.ok) throw new Error("Failed to fetch messages list");

    const listData = await listResponse.json();
    const messageRefs: Array<{ id: string }> = listData.messages || [];
    nextPageToken = listData.nextPageToken;
    totalFetched += messageRefs.length;

    for (const ref of messageRefs) {
      if (totalFetched > MAX_MESSAGES) break;

      if (messagesSinceRefresh >= TOKEN_REFRESH_INTERVAL) {
        try {
          currentAccessToken = await getMailboxToken(supabase, mb);
          messagesSinceRefresh = 0;
        } catch {
          console.warn("Mid-sync token refresh failed, continuing with current token");
        }
      }

      // Scoped to the org and capped at one row: external_id is not globally
      // unique, and maybeSingle() ERRORS on >1 match — that error used to read
      // as "not found" and append yet another copy on every sync.
      const { data: existingMessage } = await supabase
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("external_id", ref.id)
        .limit(1)
        .maybeSingle();

      if (existingMessage) {
        skippedCount++;
        continue;
      }

      const msgResponse = await getAuthed(`${GMAIL_API_URL}/users/me/messages/${ref.id}`);
      if (!msgResponse.ok) continue;

      const msgData = await msgResponse.json();
      const result = await processGmailMessage(supabase, msgData, orgId, userId, mailbox, "initial_sync");
      if (result.processed) processedCount++; else skippedCount++;
      messagesSinceRefresh++;
    }

    if (totalFetched >= MAX_MESSAGES) {
      console.warn(`Gmail sync capped at ${MAX_MESSAGES} messages`);
      break;
    }
  } while (nextPageToken);

  const profileRes = await fetch(`${GMAIL_API_URL}/users/me/profile`, {
    headers: { Authorization: `Bearer ${currentAccessToken}` },
    signal: AbortSignal.timeout(15000),
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

  await markInitialJobsDone(supabase, mb);

  return { processed: processedCount, skipped: skippedCount, total: totalFetched, historyId };
}
