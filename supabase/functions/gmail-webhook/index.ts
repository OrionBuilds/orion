import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { processGmailMessage, GMAIL_API_URL } from "../_shared/gmail-helpers.ts";
import { claimSyncLock, findSyncState, getMailboxToken, mapPushToMailbox, saveSyncState } from "../_shared/gmail-mailbox.ts";
import { verifyGoogleIdToken } from "../_shared/google-jwt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Google Pub/Sub push OIDC verification.
  //
  // Configured correctly, GCP attaches Authorization: Bearer <RS256 JWT> to every push,
  // where iss = accounts.google.com, email = the service account attached to the
  // subscription, and (optionally) aud = the configured audience string. Without any of
  // that config, this endpoint has NO authentication - anyone reaching the URL could POST
  // a Pub/Sub-shaped body with any emailAddress and trigger a Gmail history fetch against
  // that user's tokens.
  //
  // Rolled out in two stages so a mid-flight configuration change does not silently break
  // live inbound mail sync (4 active watches at rollout time). Enforcement is off by
  // default. To enable:
  //
  //   1. Configure the Pub/Sub subscription in GCP with a service account for OIDC and,
  //      recommended, an `audience` set to this function URL.
  //   2. Set the following as Supabase function secrets:
  //        GMAIL_PUBSUB_SERVICE_ACCOUNT   the email of that service account
  //        GMAIL_PUBSUB_AUDIENCE          optional; the audience string above
  //   3. Confirm from function logs that the "would allow" path is being taken - real
  //      pushes should log `token verified for <email>`.
  //   4. Set GMAIL_PUBSUB_ENFORCE=true to start returning 401 to unauthenticated pushes.
  //
  // Until (4), missing/invalid tokens are logged but the request is allowed through, which
  // preserves current behaviour. This is intentionally NOT the "return true when env is
  // missing" fail-open pattern - enforcement is a separate explicit flag, and the code
  // always attempts verification and logs the outcome.
  const enforce = Deno.env.get("GMAIL_PUBSUB_ENFORCE") === "true";
  const expectedEmail = Deno.env.get("GMAIL_PUBSUB_SERVICE_ACCOUNT") || undefined;
  const expectedAudience = Deno.env.get("GMAIL_PUBSUB_AUDIENCE") || undefined;
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    console.warn("[gmail-webhook] no Bearer token on request", { enforce });
    if (enforce) return new Response("Unauthorized", { status: 401 });
  } else {
    const verifyResult = await verifyGoogleIdToken(token, {
      expectedEmail,
      expectedAudience,
    });
    if (!verifyResult.valid) {
      console.warn(`[gmail-webhook] token rejected: ${verifyResult.reason}`, { enforce });
      if (enforce) return new Response("Unauthorized", { status: 401 });
    } else {
      console.log(`[gmail-webhook] token verified for ${verifyResult.claims?.email ?? "(no email claim)"}`);
    }
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response("Missing config", { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const messageData = body?.message?.data;
    if (!messageData) {
      return new Response("OK", { status: 200 });
    }

    let notification: { emailAddress: string; historyId: string };
    try {
      notification = JSON.parse(atob(messageData));
    } catch {
      console.error("Failed to decode Pub/Sub message data");
      return new Response("OK", { status: 200 });
    }

    const { emailAddress, historyId: newHistoryId } = notification;
    if (!emailAddress || !newHistoryId) {
      return new Response("OK", { status: 200 });
    }

    // Map the pushed address to its connection (case-insensitive, org-wide). One Google account connected by two OS users
    // (e.g. a shared agent mailbox) yields two candidates; take the oldest deterministically instead of failing closed.
    const mapped = await mapPushToMailbox(supabase, emailAddress);

    if (!mapped) {
      console.log(`No token found for ${emailAddress}`);
      return new Response("OK", { status: 200 });
    }

    if (mapped.candidates > 1) {
      console.warn(
        `${emailAddress} is connected by ${mapped.candidates} users; syncing the oldest connection (org ${mapped.mailbox.orgId}, user ${mapped.mailbox.userId})`
      );
    }

    const mailbox = mapped.mailbox;
    const orgId = mailbox.orgId;
    const userId = mailbox.userId;
    const messageMailbox = { connectionId: mailbox.connectionId, email: mailbox.email };

    // History id, lock and watch are per mailbox: another account of the same user is untouched.
    const syncState = await findSyncState(supabase, mailbox);

    const storedHistoryId = syncState?.history_id;
    if (!storedHistoryId) {
      await saveSyncState(supabase, mailbox, { history_id: newHistoryId, sync_status: "idle", updated_at: new Date().toISOString() });
      return new Response("OK", { status: 200 });
    }

    if (syncState?.sync_status === "syncing") {
      console.log(`Skipping webhook for ${emailAddress}: sync already in progress`);
      return new Response("OK", { status: 200 });
    }

    if (!(await claimSyncLock(supabase, mailbox))) {
      console.log(`Could not acquire sync lock for ${emailAddress}`);
      return new Response("OK", { status: 200 });
    }

    const accessToken = await getMailboxToken(supabase, mailbox);

    const historyUrl = `${GMAIL_API_URL}/users/me/history?startHistoryId=${storedHistoryId}&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved&maxResults=500`;

    const historyRes = await fetch(historyUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });

    if (historyRes.status === 404) {
      await saveSyncState(supabase, mailbox, {
        history_id: newHistoryId,
        sync_status: "idle",
        error_message: "History expired, need full resync",
        updated_at: new Date().toISOString(),
      });
      return new Response("OK", { status: 200 });
    }

    if (!historyRes.ok) {
      console.error("History list failed:", historyRes.status);
      await saveSyncState(supabase, mailbox, {
        sync_status: "error",
        error_message: `History fetch failed: ${historyRes.status}`,
        updated_at: new Date().toISOString(),
      });
      return new Response("OK", { status: 200 });
    }

    const historyData = await historyRes.json();
    const historyRecords = historyData.history || [];

    const processedMessageIds = new Set<string>();
    let processedCount = 0;

    for (const record of historyRecords) {
      if (record.messagesAdded) {
        for (const added of record.messagesAdded) {
          const gmailMsgId = added.message?.id;
          if (!gmailMsgId || processedMessageIds.has(gmailMsgId)) continue;
          processedMessageIds.add(gmailMsgId);

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

          if (existing) continue;

          const msgRes = await fetch(
            `${GMAIL_API_URL}/users/me/messages/${gmailMsgId}`,
            { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) }
          );

          if (!msgRes.ok) continue;

          const msgData = await msgRes.json();
          const result = await processGmailMessage(
            supabase,
            msgData,
            orgId,
            userId,
            messageMailbox,
            "push"
          );

          if (result.processed) processedCount++;
        }
      }

      if (record.messagesDeleted) {
        for (const deleted of record.messagesDeleted) {
          const gmailMsgId = deleted.message?.id;
          if (!gmailMsgId) continue;

          await supabase
            .from("messages")
            .update({ hidden_at: new Date().toISOString() })
            .eq("organization_id", orgId)
            .eq("external_id", gmailMsgId);
        }
      }
    }

    const now = new Date().toISOString();
    await saveSyncState(supabase, mailbox, {
      history_id: historyData.historyId || newHistoryId,
      last_incremental_sync_at: now,
      sync_status: "idle",
      error_message: null,
      updated_at: now,
    });

    // user_connected_accounts mirrors the primary account only
    if (mailbox.isPrimary) {
      await supabase
        .from("user_connected_accounts")
        .update({ last_synced_at: now })
        .eq("user_id", userId)
        .eq("provider", "google_gmail");
    }

    console.log(`Processed ${processedCount} messages for ${emailAddress}`);
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("gmail-webhook error:", err);
    return new Response("Internal error", { status: 500 });
  }
});
