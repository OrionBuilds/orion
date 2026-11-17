import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { processGmailMessage, GMAIL_API_URL } from "../_shared/gmail-helpers.ts";
import {
  enqueueMailboxJob, findSyncState, getMailboxToken, listGmailMailboxes, resolveGmailMailbox, saveSyncState,
  type GmailMailbox,
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
      const { error: authError } = await anonClient.auth.getUser(token);
      if (authError) {
        return new Response(
          JSON.stringify({ error: "Invalid or expired token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const reqBody = await req.json().catch(() => ({}));
    const { org_id: orgId, user_id: userId, connection_id: connectionId } = reqBody;

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
      if (!one) return json({ error: "Gmail account not found" }, 404);
      mailboxes = [one];
    } else {
      mailboxes = await listGmailMailboxes(supabase, userId, orgId);
    }
    if (mailboxes.length === 0) return json({ error: "Gmail not connected" }, 400);

    const results: Array<{ connection_id: string; email: string; status: number; body: Record<string, unknown> }> = [];
    for (const mb of mailboxes) {
      try {
        results.push({ connection_id: mb.connectionId, email: mb.email, ...(await syncMailbox(supabase, mb)) });
      } catch (error) {
        console.error(`Gmail incremental sync error for ${mb.email}:`, error);
        await saveSyncState(supabase, mb, { sync_status: "error", error_message: (error as Error).message, updated_at: new Date().toISOString() });
        results.push({ connection_id: mb.connectionId, email: mb.email, status: 500, body: { error: (error as Error).message } });
      }
    }

    // One account: the response is exactly what it always was.
    if (results.length === 1) return json(results[0].body, results[0].status);
    const sum = (k: string) => results.reduce((n, r) => n + (Number(r.body[k]) || 0), 0);
    return json({
      success: results.some((r) => r.body.success === true),
      processed: sum("processed"), skipped: sum("skipped"), deleted: sum("deleted"),
      mailboxes: results.map((r) => ({ connection_id: r.connection_id, email: r.email, status: r.status, ...r.body })),
    });
  } catch (error) {
    console.error("Gmail incremental sync error:", error);
    return json({ error: (error as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** One incremental pass over ONE mailbox: its own history id, lock and token. Returns the HTTP-shaped outcome. */
async function syncMailbox(
  supabase: SupabaseClient,
  mb: GmailMailbox,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const orgId = mb.orgId;
  const userId = mb.userId;
  const mailbox = { connectionId: mb.connectionId, email: mb.email };

  const syncState = await findSyncState(supabase, mb);

  if (!syncState?.history_id) {
    return { status: 400, body: { error: "No history_id found. Run initial sync first." } };
  }

  if (syncState.sync_status === "syncing") {
    return { status: 409, body: { error: "Sync already in progress", status: syncState.sync_status } };
  }

  await saveSyncState(supabase, mb, { sync_status: "syncing", error_message: null, updated_at: new Date().toISOString() });

  const accessToken = await getMailboxToken(supabase, mb);

  const allMessageIds = new Set<string>();
  const deletedMessageIds = new Set<string>();
  let nextPageToken: string | undefined;
  let latestHistoryId = syncState.history_id;

  do {
    let url = `${GMAIL_API_URL}/users/me/history?startHistoryId=${syncState.history_id}&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=500`;
    if (nextPageToken) {
      url += `&pageToken=${nextPageToken}`;
    }

    const historyRes = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (historyRes.status === 404) {
      const now = new Date().toISOString();
      await saveSyncState(supabase, mb, {
        sync_status: "idle",
        error_message: "History expired. Queuing full resync.",
        updated_at: now,
      });

      await enqueueMailboxJob(supabase, mb, "full_resync");

      return { status: 200, body: { success: false, error: "History expired, full resync queued" } };
    }

    if (!historyRes.ok) {
      throw new Error(`History API failed: ${historyRes.status}`);
    }

    const historyData = await historyRes.json();
    const records = historyData.history || [];

    for (const record of records) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          if (added.message?.id) allMessageIds.add(added.message.id);
        }
      }
      if (record.messagesDeleted) {
        for (const deleted of record.messagesDeleted) {
          if (deleted.message?.id) deletedMessageIds.add(deleted.message.id);
        }
      }
    }

    if (historyData.historyId) {
      latestHistoryId = historyData.historyId;
    }
    nextPageToken = historyData.nextPageToken;
  } while (nextPageToken);

  for (const id of deletedMessageIds) {
    allMessageIds.delete(id);
  }

  let processedCount = 0;
  let skippedCount = 0;

  for (const gmailMsgId of allMessageIds) {
    // Scoped to the org and capped at one row: external_id is not globally
    // unique, and maybeSingle() ERRORS on >1 match — that error used to read
    // as "not found" and append yet another copy on every sync.
    const { data: existing } = await supabase
      .from("messages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("external_id", gmailMsgId)
      .limit(1)
      .maybeSingle();

    if (existing) {
      skippedCount++;
      continue;
    }

    const msgRes = await fetch(
      `${GMAIL_API_URL}/users/me/messages/${gmailMsgId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!msgRes.ok) {
      skippedCount++;
      continue;
    }

    const msgData = await msgRes.json();
    const result = await processGmailMessage(supabase, msgData, orgId, userId, mailbox, "incremental_poll");

    if (result.processed) {
      processedCount++;
    } else {
      skippedCount++;
    }
  }

  let deletedCount = 0;
  for (const gmailMsgId of deletedMessageIds) {
    const { data: hidden } = await supabase
      .from("messages")
      .update({ hidden_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("external_id", gmailMsgId)
      .select("id");

    if (hidden && hidden.length > 0) deletedCount++;
  }

  if (processedCount > 0) {
    try {
      await supabase.from("notifications").insert({
        user_id: userId,
        type: "email",
        title: "New Email Received",
        body: processedCount === 1
          ? "You have 1 new email"
          : `You have ${processedCount} new emails`,
        link: "/conversations",
        metadata: { count: processedCount },
      });
    } catch {}
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

  return { status: 200, body: { success: true, processed: processedCount, skipped: skippedCount, deleted: deletedCount, historyId: latestHistoryId } };
}
