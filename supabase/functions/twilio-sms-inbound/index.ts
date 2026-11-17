/**
 * twilio-sms-inbound — Twilio inbound SMS / MMS webhook.
 *
 * Configured per-number in the Twilio Console (Phone Numbers → A Number →
 * Messaging webhook → this URL, HTTP POST). Twilio sends form-urlencoded
 * params: From, To, Body, MessageSid, NumMedia, MediaUrl0, MediaContentType0…
 *
 * Routes the message based on twilio_numbers.sms_route:
 *   - 'clara'  → leaves it for Clara's auto-reply path (clara picks it up
 *                from messages with metadata.rail='twilio')
 *   - 'user'   → drops it into assigned_user_id's inbox (just stores; no auto-reply)
 *
 * Returns a minimal TwiML response so Twilio considers the webhook handled.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getTwilioEnvCreds,
  sendTwilioSms,
  verifyTwilioWebhookSignature,
} from "../_shared/twilio.ts";
import { denoEnv, functionsBase, publicUrl } from "../_shared/clara/webhook.ts";
import { handleOwnerSms } from "../_shared/clara/owner-sms.ts";
import { isOwner } from "../_shared/clara/phones.ts";
import { holdDeps, ownerCtx, sendAndLogSms } from "../_shared/clara/runtime.ts";
import { ownerTurn } from "../_shared/clara/owner-turn.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Twilio-Signature",
};

const TWIML_EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const rawBody = await req.text();
    const params = parseFormUrlEncoded(rawBody);

    // Require a valid Twilio signature — FAIL CLOSED. Twilio always signs inbound
    // webhooks with the account auth token, so a missing header or missing creds
    // means the request is forged (previously verification was skipped when the
    // header was absent, allowing forged inbound SMS into any org).
    const creds = getTwilioEnvCreds();
    const signature = req.headers.get("X-Twilio-Signature") ?? "";
    // Twilio signs the URL it was configured with; the runtime may report an internal host, so accept
    // either the URL as seen or the public functions URL rebuilt from config.
    if (
      !creds ||
      !signature ||
      !((await verifyTwilioWebhookSignature(req.url, params, signature, creds.authToken)) ||
        (await verifyTwilioWebhookSignature(publicUrl(req, "twilio-sms-inbound"), params, signature, creds.authToken)))
    ) {
      console.warn("[twilio-sms-inbound] rejected: missing or invalid signature for", req.url);
      return twimlResponse(TWIML_EMPTY, 403);
    }

    const from = params.From;
    const to = params.To;
    const text = params.Body ?? "";
    const messageSid = params.MessageSid ?? null;
    const numMedia = parseInt(params.NumMedia ?? "0", 10);
    const mediaUrls: string[] = [];
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      if (url) mediaUrls.push(url);
    }

    if (!from || !to) return twimlResponse(TWIML_EMPTY, 200);

    // Look up the twilio_numbers row for the destination number
    const { data: numberRow } = await supabase
      .from("twilio_numbers")
      .select("id, org_id, sms_route, assigned_user_id, department_id")
      .eq("phone_number", to)
      .maybeSingle();

    if (!numberRow) {
      console.warn("[twilio-sms-inbound] no twilio_numbers row for", to);
      return twimlResponse(TWIML_EMPTY, 200);
    }

    const orgId = numberRow.org_id as string;

    // ── Owner split ──────────────────────────────────────────────────────────
    // Placed BEFORE any contact/conversation write, on purpose. the owner's texts are commands, not
    // leads: "restart friday", "raise clara calls 200", "friday dials", "sitrep". Filing those as
    // CRM conversations would bury real prospects under the owner's own ops traffic, and answering
    // them with clara-sms-responder — a customer auto-reply that knows none of those verbs — would
    // be worse than not answering at all.
    //
    // The command surface lives in the CLARA app (resolveByPhone → sitrep/dials/repair/routing), so
    // an owner message is relayed there verbatim and this function stops. If the relay fails, the
    // owner is TOLD; a restart command that silently evaporates is the failure mode this estate has
    // spent the most time removing.
    if (isOwnerNumber(from)) {
      // OWNER_SMS_MODE=native handles the owner in the OS (hold replies first, then an honest
      // queue). Default is now "native": the CLARA app is retired (2026-10-22), so relaying owner
      // texts to the retired Clara host would fail. Setting OWNER_SMS_MODE=relay is only a legacy
      // escape hatch and requires the old app to be running again.
      if ((Deno.env.get("OWNER_SMS_MODE") ?? "native") === "native") {
        // Acknowledge Twilio now; the work can take longer than its 15 s budget. The outcome goes back as a text.
        const task = (async () => {
          const reply = await handleOwnerSms(
            supabase,
            { body: text, messageSid },
            {
              hold: holdDeps(supabase, denoEnv, to, functionsBase(denoEnv), orgId),
              run: async (t) => (await ownerTurn(supabase, denoEnv, ownerCtx(supabase, denoEnv, { orgId, claraNumber: to, channel: "sms", ownerVerified: true }), t)).reply,
            },
          ).catch((e) => { console.error("[twilio-sms-inbound] owner handler failed:", e); return "I hit a snag handling that and haven't done anything. Please try again."; });
          if (reply) await sendAndLogSms(supabase, denoEnv, orgId, to, from, reply, "owner_reply");
        })();
        const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (rt?.waitUntil) rt.waitUntil(task); else await task;
        return twimlResponse(TWIML_EMPTY, 200);
      }
      const relayed = await relayToClara({ From: from, Body: text, MessageSid: messageSid ?? "" });
      if (!relayed.ok) {
        console.error("[twilio-sms-inbound] owner relay failed:", relayed.error);
        await sendOwnerFallbackSms(from, to, relayed.error ?? "unknown error").catch((e) =>
          console.error("[twilio-sms-inbound] could not even send the fallback:", e),
        );
      }
      return twimlResponse(TWIML_EMPTY, 200);
    }

    // Resolve the contact by phone.
    // Normalized lookup, not an exact string match: Twilio delivers E.164 while
    // hand-entered contacts hold national format, and the mismatch was silently
    // creating duplicate "Unknown +1..." contacts for people already in the CRM.
    const { data: matchedId } = await supabase
      .rpc("find_contact_id_by_phone", { p_org: orgId, p_phone: from });

    // Contacts are made only when a lead books, fills a form or is added by hand, never from an
    // inbound text: a text from an unknown number is not logged (conversations need a contact).
    const contactId = (matchedId as string | null) ?? undefined;
    if (!contactId) {
      console.log("[twilio-sms-inbound] text from a number with no contact; not logged");
      return twimlResponse(TWIML_EMPTY, 200);
    }

    // Find or create conversation
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id, assigned_user_id")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .neq("status", "closed")
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let conversationId = existingConv?.id as string | undefined;
    if (!conversationId) {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert({
          organization_id: orgId,
          contact_id: contactId,
          department_id: numberRow.department_id,
          // Every conversation row in the table had channel NULL because no writer set it,
          // so anything filtering or routing by channel silently matched nothing.
          channel: "sms",
          status: "open",
          unread_count: 0,
          assigned_user_id:
            numberRow.sms_route === "user" ? numberRow.assigned_user_id : null,
        })
        .select("id")
        .single();
      conversationId = newConv?.id;
    } else if (
      numberRow.sms_route === "user" &&
      numberRow.assigned_user_id &&
      !existingConv?.assigned_user_id
    ) {
      // The number is owned by a user but this open thread was unassigned
      // (e.g. created earlier by a clara-routed number or a workflow) — hand it
      // to the number's owner. Never steal an already-assigned thread.
      await supabase
        .from("conversations")
        .update({ assigned_user_id: numberRow.assigned_user_id })
        .eq("id", conversationId)
        .is("assigned_user_id", null);
    }

    if (!conversationId) return twimlResponse(TWIML_EMPTY, 200);

    const sentAt = new Date().toISOString();

    const { data: insertedMsg } = await supabase.from("messages").insert({
      organization_id: orgId,
      conversation_id: conversationId,
      contact_id: contactId,
      channel: "sms",
      direction: "inbound",
      body: text,
      media_urls: mediaUrls.length > 0 ? mediaUrls : null,
      sender_identifier: from,
      metadata: {
        from_number: from,
        to_number: to,
        rail: "twilio",
        provider_message_id: messageSid,
        sms_route: numberRow.sms_route,
      },
      status: "delivered",
      delivery_status: "delivered",
      external_id: messageSid,
      sent_at: sentAt,
    }).select("id").maybeSingle();

    await supabase
      .from("conversations")
      .update({
        last_message_at: sentAt,
        unread_count: 1,
      })
      .eq("id", conversationId);

    // Clara-routed numbers get an AI reply. Fire it without blocking the TwiML
    // response so Twilio isn't kept waiting on a model call.
    if (numberRow.sms_route === "clara" && text.trim()) {
      const task = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/clara-sms-responder`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          orgId,
          contactId,
          conversationId,
          messageId: (insertedMsg as { id: string } | null)?.id ?? null,
          fromNumber: from,
          toNumber: to,
          body: text,
        }),
      }).catch((e) => console.error("[twilio-sms-inbound] clara dispatch failed:", e));

      // Keep the worker alive until the reply is sent.
      const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(task);
      else await task;
    }

    return twimlResponse(TWIML_EMPTY, 200);
  } catch (e) {
    console.error("[twilio-sms-inbound] error:", e);
    return twimlResponse(TWIML_EMPTY, 200);
  }
});

// ── Owner relay helpers ────────────────────────────────────────────────────

/** Last 10 digits, so (555) 010-0100 and +15550100100 compare equal. */
function phoneKey(raw: string): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

/**
 * Is this the owner texting? Driven by OWNER_PHONES (comma-separated, any format) plus the
 * OWNER_PHONE / OWNER_PERSONAL_PHONE / OWNER_WORK_PHONE numbers Clara's voice and notify paths use,
 * so one set of numbers identifies the owner on every channel.
 *
 * Fails CLOSED toward the CRM path: with the env unset, nothing is treated as an owner message and
 * every text goes through the normal contact/auto-reply flow. That is the safe direction — the
 * owner notices a missing reply within minutes, whereas the opposite default would route a
 * prospect's message into the command surface.
 */
function isOwnerNumber(from: string): boolean {
  if (isOwner(denoEnv, from)) return true;
  const raw = Deno.env.get("OWNER_PHONES") ?? "";
  const key = phoneKey(from);
  if (key.length !== 10) return false;
  return raw.split(",").map((p) => phoneKey(p)).filter((p) => p.length === 10).includes(key);
}

/** POST the message to CLARA's fail-closed relay, through Cloudflare Access. */
async function relayToClara(payload: { From: string; Body: string; MessageSid: string }): Promise<{ ok: boolean; error?: string }> {
  const base = (Deno.env.get("CLARA_URL") ?? "").replace(/\/+$/, "");
  const secret = (Deno.env.get("OS_SMS_RELAY_SECRET") ?? Deno.env.get("INTERAGENT_SHARED_SECRET") ?? "").trim();
  if (!secret) return { ok: false, error: "no relay secret configured" };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-os-relay-secret": secret,
  };
  // Clara's tunnel sits behind Cloudflare Access; the service token is how a machine gets through
  // it. Same pair clara-chat uses.
  const cfId = Deno.env.get("CLARA_CF_ACCESS_CLIENT_ID");
  const cfSecret = Deno.env.get("CLARA_CF_ACCESS_CLIENT_SECRET");
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }

  try {
    const r = await fetch(`${base}/api/channels/os-sms-relay`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 160);
      return { ok: false, error: `relay returned ${r.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    // A dead tunnel lands here — the single most likely failure, and the one that must be loud.
    return { ok: false, error: `relay unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Tell the owner his command did not run. Sent directly via the Twilio REST API rather than through
 * any of our own send paths, because the reason we are here is that our own paths are broken.
 */
async function sendOwnerFallbackSms(to: string, from: string, reason: string): Promise<void> {
  const creds = getTwilioEnvCreds();
  if (!creds) return;
  const body = `Clara is unreachable, so that command did NOT run (${reason.slice(0, 80)}). Voice and website chat are unaffected.`;
  const auth = btoa(`${creds.accountSid}:${creds.authToken}`);
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
}

function parseFormUrlEncoded(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return params;
}

function twimlResponse(xml: string, status: number): Response {
  return new Response(xml, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
}
