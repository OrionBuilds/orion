/**
 * clara-sms-responder — generates and sends Clara's reply to an inbound SMS.
 *
 * Invoked (fire-and-forget) by `twilio-sms-inbound` when the receiving number
 * is routed to Clara (`twilio_numbers.sms_route = 'clara'`). Internal-only:
 * requires the service-role key as a bearer token.
 *
 * Guardrails run BEFORE any reply is generated:
 *   1. STOP/opt-out keywords  → record in `dnc_numbers`, never reply
 *   2. Number already on the org's DNC list → never reply
 *   3. Quiet hours (phone_settings) → skip
 *   4. Per-contact daily cap → skip
 *   5. Org-wide daily model-call ceiling (a text flood can't run up unbounded spend)
 *   6. Prompt-injection screen on the inbound text (hard match: pass along, no model call)
 *
 * Voice: Clara wears the audience identity for the number texted (the owner's work line vs the
 * company's published line), carries the public-safe company reference, and NEVER answers money,
 * contract, pricing or scope: those get a named holding line and the owner is texted the sender's
 * number (deterministic regex, independent of what the model says).
 *
 * Kill switch: set the number's `sms_route` to 'user' and Clara stops replying.
 */
import { meteredFetch } from "../_shared/ai-usage.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getTwilioEnvCreds, sendTwilioSms } from "../_shared/twilio.ts";
import {
  ANTHROPIC_API_VERSION,
  CLARA_MODEL_LIGHT,
  getAnthropicMessagesUrl,
} from "../_shared/claraConfig.ts";
import { detectPromptInjection } from "../_shared/clara/injection.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { notifyDeps, companyKnowledge } from "../_shared/clara/runtime.ts";
import { names } from "../_shared/clara/persona.ts";
import { SMS_SCHEMA, audienceFor, escalationText, finalReply, smsSystemPrompt } from "../_shared/clara/sms.ts";

/** Max Clara replies to one contact per rolling day. */
const DAILY_REPLY_CAP = 20;
/** How much thread history to give the model. */
const THREAD_WINDOW = 12;

const OPT_OUT_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt-out"];
const OPT_IN_WORDS = ["start", "unstop", "yes"];

interface Payload {
  orgId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  fromNumber: string; // the client
  toNumber: string;   // our Clara number
  body: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${serviceKey}`) return new Response("forbidden", { status: 403 });

  let p: Payload;
  try {
    p = await req.json();
  } catch {
    return jsonRes({ error: "invalid json" }, 400);
  }
  if (!p.orgId || !p.contactId || !p.conversationId || !p.toNumber || !p.fromNumber) {
    return jsonRes({ error: "missing fields" }, 400);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const inbound = (p.body ?? "").trim();
  const normalized = inbound.toLowerCase().replace(/[^a-z-]/g, "");

  // ── Guardrail 1: opt-out / opt-in keywords ──────────────────────────────
  if (OPT_OUT_WORDS.includes(normalized)) {
    await supabase.from("dnc_numbers").insert({
      org_id: p.orgId,
      phone_number: p.fromNumber,
      reason: "SMS opt-out keyword",
    });
    return jsonRes({ ok: true, skipped: "opted_out" });
  }
  if (OPT_IN_WORDS.includes(normalized)) {
    await supabase.from("dnc_numbers")
      .delete().eq("org_id", p.orgId).eq("phone_number", p.fromNumber);
    // fall through and reply normally
  }

  // ── Guardrail 2: already on the DNC list ────────────────────────────────
  const { data: dnc } = await supabase
    .from("dnc_numbers").select("id")
    .eq("org_id", p.orgId).eq("phone_number", p.fromNumber).maybeSingle();
  if (dnc) return jsonRes({ ok: true, skipped: "dnc" });

  // ── Guardrail 3: quiet hours ────────────────────────────────────────────
  const { data: settings } = await supabase
    .from("phone_settings")
    .select("quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, business_name, opt_out_language, auto_append_opt_out")
    .eq("org_id", p.orgId)
    .maybeSingle();

  if (settings?.quiet_hours_enabled && settings.quiet_hours_start && settings.quiet_hours_end) {
    if (isWithinQuietHours(settings.quiet_hours_start, settings.quiet_hours_end, settings.quiet_hours_timezone)) {
      return jsonRes({ ok: true, skipped: "quiet_hours" });
    }
  }

  // ── Guardrail 4: per-contact daily cap ──────────────────────────────────
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", p.conversationId)
    .eq("direction", "outbound")
    .eq("sender_name", "Clara")
    .gte("sent_at", dayAgo);
  if ((count ?? 0) >= DAILY_REPLY_CAP) {
    return jsonRes({ ok: true, skipped: "daily_cap" });
  }

  // ── Guardrail 5: org-wide daily model-call ceiling ──────────────────────────
  const cap = Number(Deno.env.get("CLARA_SMS_DAILY_CAP") ?? "") || 300;
  const { data: used } = await supabase.rpc("clara_usage_incr", { p_org: p.orgId, p_purpose: "sms" });
  const env = { get: (k: string) => Deno.env.get(k) };
  const nm = names(env);
  const nDeps = notifyDeps(supabase, env, p.orgId, p.toNumber);
  if (typeof used === "number" && used > cap) {
    await notifyOwner(supabase, {
      kind: "job.call_cap", priority: "critical", category: "production",
      text: `⏸ I've stopped auto-replying to inbound SMS — ${used - 1} model calls today (cap ${cap}).`,
      dedupeKey: `clara:callcap:sms:${new Date().toISOString().slice(0, 10)}`,
    }, nDeps).catch(() => {});
    return jsonRes({ ok: true, skipped: "call_cap" });
  }

  // ── Guardrail 6: prompt-injection screen ────────────────────────────────────
  const verdict = detectPromptInjection(inbound, env);
  if (verdict.triggered) {
    await notifyOwner(supabase, {
      kind: "injection.detected", priority: "critical", category: "security",
      text: `Possible prompt injection in an SMS from ${p.fromNumber}: ${verdict.reasons.join(", ")}.`,
      dedupeKey: `injection:sms:${p.fromNumber}:${new Date().toISOString().slice(0, 10)}`,
    }, nDeps).catch(() => {});
  }

  // ── Build context ───────────────────────────────────────────────────────
  const { data: contact } = await supabase
    .from("contacts").select("first_name, last_name, email, company")
    .eq("id", p.contactId).maybeSingle();

  const { data: history } = await supabase
    .from("messages")
    .select("direction, body, sent_at")
    .eq("conversation_id", p.conversationId)
    .eq("channel", "sms")
    .order("sent_at", { ascending: false })
    .limit(THREAD_WINDOW);

  const thread = ((history as { direction: string; body: string }[] | null) ?? [])
    .slice()
    .reverse()
    .filter((m) => (m.body ?? "").trim().length > 0)
    .map((m) => ({
      role: m.direction === "inbound" ? "user" as const : "assistant" as const,
      content: m.body,
    }));
  // The model needs the newest inbound message last.
  if (thread.length === 0 || thread[thread.length - 1].content !== inbound) {
    thread.push({ role: "user", content: inbound });
  }

  const contactName = [contact?.first_name, contact?.last_name]
    .filter((x) => x && x !== "Unknown").join(" ").trim();
  const audience = audienceFor(env, p.toNumber);
  const systemPrompt = smsSystemPrompt(env, {
    audience, contactName, company: contact?.company ?? undefined,
    knowledge: await companyKnowledge(supabase, p.orgId),
  });

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) return jsonRes({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  let modelOut: { reply: string; escalate?: boolean; wantsOwner?: boolean } = { reply: "" };
  if (!verdict.hardBlock) {
    try {
      const res = await meteredFetch({ source: "clara-sms-responder", agent: "clara" })(getAnthropicMessagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": anthropicKey.trim(), "anthropic-version": ANTHROPIC_API_VERSION },
        // Short, high-volume SMS replies run on the light (Haiku) tier, schema-constrained.
        body: JSON.stringify({
          model: CLARA_MODEL_LIGHT, max_tokens: 400, system: systemPrompt, messages: thread,
          output_config: { format: { type: "json_schema", schema: SMS_SCHEMA } },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        console.error("[clara-sms-responder] Anthropic error:", res.status, (await res.text()).slice(0, 300));
        return jsonRes({ ok: false, error: "model_error" }, 502);
      }
      const j = await res.json() as { content?: { type: string; text?: string }[] };
      const m = (j.content?.find((b) => b.type === "text")?.text ?? "").match(/\{[\s\S]*\}/);
      if (m) modelOut = JSON.parse(m[0]);
    } catch (e) {
      console.error("[clara-sms-responder] Anthropic call failed:", e);
      return jsonRes({ ok: false, error: "model_call_failed" }, 502);
    }
  }

  const fr = verdict.hardBlock
    ? { text: "Got it — I'll pass this along.", escalated: false, askOwner: false }
    : finalReply(modelOut, inbound, nm.ownerFirst);
  const reply = fr.text;
  if (!reply) return jsonRes({ ok: true, skipped: "empty_reply" });

  if (fr.askOwner) {
    const who = contactName ? `${contactName}${contact?.company ? ` (${contact.company})` : ""}` : p.fromNumber;
    await notifyOwner(supabase, {
      kind: "work_line.text", priority: "critical", category: "revenue",
      text: escalationText(who, p.fromNumber, inbound, fr.escalated),
      dedupeKey: `sms-escalation:${p.messageId ?? p.fromNumber + inbound.slice(0, 30)}`,
    }, nDeps).catch(() => {});
  }

  // ── Send + log ──────────────────────────────────────────────────────────
  const creds = getTwilioEnvCreds();
  if (!creds) return jsonRes({ error: "Twilio not configured" }, 400);

  const result = await sendTwilioSms({
    accountSid: creds.accountSid,
    authToken: creds.authToken,
    to: p.fromNumber,
    from: p.toNumber,
    body: reply,
  });

  const sentAt = new Date().toISOString();
  await supabase.from("messages").insert({
    organization_id: p.orgId,
    conversation_id: p.conversationId,
    contact_id: p.contactId,
    channel: "sms",
    direction: "outbound",
    body: reply,
    message_type: "text",
    sender_name: "Clara",
    sender_identifier: p.toNumber,
    metadata: {
      from_number: p.toNumber,
      to_number: p.fromNumber,
      rail: "twilio",
      source: "clara_sms",
      provider_message_id: result.sid ?? null,
      error: result.ok ? undefined : result.error,
    },
    status: result.ok ? "sent" : "failed",
    delivery_status: result.ok ? (result.providerStatus ?? "queued") : "failed",
    external_id: result.sid ?? null,
    sent_at: sentAt,
  });

  await supabase.from("conversations")
    .update({ last_message_at: sentAt })
    .eq("id", p.conversationId);

  return jsonRes({ ok: result.ok, sid: result.sid, reply });
});

/** Quiet hours may wrap past midnight (e.g. 21:00 → 08:00). */
function isWithinQuietHours(start: string, end: string, tz: string | null): boolean {
  const now = new Date();
  let hhmm: string;
  try {
    hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now);
  } catch {
    hhmm = now.toISOString().slice(11, 16);
  }
  const cur = toMinutes(hhmm);
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

function toMinutes(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
