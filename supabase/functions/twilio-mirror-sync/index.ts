/**
 * twilio-mirror-sync — mirrors traffic on externally-operated numbers into the
 * Conversations module (read-only).
 *
 * Externally-operated AI agents (e.g. Friday) keep their Twilio numbers'
 * webhooks pointed at their own platforms, but send/receive through OUR
 * Twilio account — so every message and call is retrievable from the Twilio
 * REST API. This poller pulls that traffic and normalizes it into
 * contacts / conversations / messages so staff can see the client↔agent
 * conversation in the OS.
 *
 * Runs on pg_cron. Idempotent: messages dedupe on `external_id` (unique index
 * scoped to channel='sms'), calls dedupe on `call_logs.twilio_call_sid`.
 *
 * NOTE: Twilio exposes call METADATA only — the spoken content lives on the
 * external agent's platform, so calls surface as call events, not transcripts.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getTwilioEnvCreds } from "../_shared/twilio.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { isAllowedRecordingUrl, recordingPath } from "../_shared/clara/recordings.ts";

const TWILIO_API = "https://api.twilio.com/2010-04-01";
/** How far back to look on a number's very first sync. */
const FIRST_RUN_LOOKBACK_DAYS = 3;
/** Safety overlap so nothing is missed between runs. */
const OVERLAP_MINUTES = 5;

interface NumberRow {
  id: string;
  org_id: string;
  phone_number: string;
  agent_label: string | null;
  last_mirror_sync_at: string | null;
}

function basicAuth(sid: string, token: string): string {
  return "Basic " + btoa(`${sid}:${token}`);
}

/** Twilio's message status → our messages.delivery_status vocabulary. */
function mapDeliveryStatus(s: string | null): string | null {
  switch (s) {
    case "received": return "delivered";
    case "accepted":
    case "scheduled": return "queued";
    case "queued":
    case "sending":
    case "sent":
    case "delivered":
    case "read":
    case "undelivered":
    case "failed": return s;
    default: return null;
  }
}

function mapMessageStatus(twilioStatus: string | null, direction: "inbound" | "outbound"): string {
  if (direction === "inbound") return "delivered";
  switch (twilioStatus) {
    case "delivered": return "delivered";
    case "read": return "read";
    case "failed":
    case "undelivered": return "failed";
    case "queued":
    case "accepted":
    case "scheduled":
    case "sending": return "pending";
    default: return "sent";
  }
}

async function twilioGet(
  url: string,
  sid: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const r = await fetch(url, { headers: { Authorization: basicAuth(sid, token) } });
  if (!r.ok) {
    console.error(`[twilio-mirror-sync] Twilio GET ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return null;
  }
  return await r.json();
}

/** Pull every page of a Twilio list resource (bounded). */
async function twilioList(
  path: string,
  sid: string,
  token: string,
  key: string,
  maxPages = 10,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let url: string | null = `${TWILIO_API}/Accounts/${encodeURIComponent(sid)}${path}`;
  let pages = 0;
  while (url && pages < maxPages) {
    const data = await twilioGet(url, sid, token);
    if (!data) break;
    const items = (data[key] as Record<string, unknown>[]) ?? [];
    out.push(...items);
    const next = data.next_page_uri as string | null;
    url = next ? `https://api.twilio.com${next}` : null;
    pages++;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Deployed verify_jwt=false. Its cron job used to authenticate with the PUBLIC anon key, so this
  // endpoint was effectively open. Callers verified before gating: pg_cron only.
  if (!isCronRequest(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const creds = getTwilioEnvCreds();
  if (!creds) return jsonRes({ error: "Twilio not configured" }, 400);

  // Normalized lookup, not an exact phone match: inbound numbers arrive as E.164
  // while hand-entered contacts hold national format, which created duplicates.
  const { data: numbers } = await supabase
    .from("twilio_numbers")
    .select("id, org_id, phone_number, agent_label, last_mirror_sync_at")
    .eq("sms_route", "external")
    .eq("status", "active");

  const rows = (numbers as NumberRow[] | null) ?? [];
  const summary: Record<string, unknown>[] = [];

  for (const num of rows) {
    try {
      const since = num.last_mirror_sync_at
        ? new Date(new Date(num.last_mirror_sync_at).getTime() - OVERLAP_MINUTES * 60_000)
        : new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000);
      // Twilio's date filters are day-granular; we filter precisely in code.
      const dayFilter = since.toISOString().slice(0, 10);
      const runStartedAt = new Date().toISOString();

      const smsCount = await mirrorMessages(supabase, creds, num, since, dayFilter);
      const callCount = await mirrorCalls(supabase, creds, num, since, dayFilter);
      // Recordings finish a little after the call, so look for them on every run, not only on first sight.
      const recCount = await attachMirroredRecordings(supabase, creds, num).catch((e) => {
        console.warn(`[twilio-mirror-sync] recordings for ${num.phone_number} failed:`, e instanceof Error ? e.message : e);
        return 0;
      });

      await supabase
        .from("twilio_numbers")
        .update({ last_mirror_sync_at: runStartedAt })
        .eq("id", num.id);

      summary.push({ number: num.phone_number, agent: num.agent_label, messages: smsCount, calls: callCount, recordings: recCount });
    } catch (e) {
      console.error(`[twilio-mirror-sync] ${num.phone_number} failed:`, e);
      summary.push({ number: num.phone_number, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return jsonRes({ ok: true, synced: summary });
});

async function mirrorMessages(
  supabase: ReturnType<typeof createClient>,
  creds: { accountSid: string; authToken: string },
  num: NumberRow,
  since: Date,
  dayFilter: string,
): Promise<number> {
  const q = `PageSize=100&${encodeURIComponent("DateSent>")}=${dayFilter}`;
  const inbound = await twilioList(`/Messages.json?To=${encodeURIComponent(num.phone_number)}&${q}`, creds.accountSid, creds.authToken, "messages");
  const outbound = await twilioList(`/Messages.json?From=${encodeURIComponent(num.phone_number)}&${q}`, creds.accountSid, creds.authToken, "messages");

  let inserted = 0;
  for (const m of [...inbound, ...outbound]) {
    const sid = m.sid as string;
    const to = m.to as string;
    const from = m.from as string;
    const sentAtRaw = (m.date_sent as string) || (m.date_created as string);
    const sentAt = sentAtRaw ? new Date(sentAtRaw) : null;
    if (!sid || !sentAt || sentAt < since) continue;

    const direction: "inbound" | "outbound" = to === num.phone_number ? "inbound" : "outbound";
    const clientNumber = direction === "inbound" ? from : to;
    if (!clientNumber) continue;

    // Already mirrored?
    const { data: existing } = await supabase
      .from("messages").select("id").eq("external_id", sid).maybeSingle();
    if (existing) continue;

    const contactId = await resolveContact(supabase, num.org_id, clientNumber);
    if (!contactId) continue;
    const conversationId = await resolveConversation(supabase, num.org_id, contactId, num.agent_label);
    if (!conversationId) continue;

    const twilioStatus = (m.status as string) ?? null;
    const mediaCount = Number(m.num_media ?? 0);

    const { error } = await supabase.from("messages").insert({
      organization_id: num.org_id,
      conversation_id: conversationId,
      contact_id: contactId,
      channel: "sms",
      direction,
      body: (m.body as string) ?? "",
      subject: null,
      message_type: "text",
      sender_name: direction === "outbound" ? (num.agent_label ?? "AI agent") : null,
      sender_identifier: clientNumber,
      metadata: {
        from_number: from,
        to_number: to,
        rail: "twilio",
        provider_message_id: sid,
        mirrored: true,
        agent_label: num.agent_label,
        num_media: mediaCount,
      },
      status: mapMessageStatus(twilioStatus, direction),
      delivery_status: mapDeliveryStatus(twilioStatus),
      external_id: sid,
      sent_at: sentAt.toISOString(),
    });

    // 23505 = raced with another run; harmless.
    if (error && error.code !== "23505") {
      console.error("[twilio-mirror-sync] message insert failed:", error.message);
      continue;
    }
    if (!error) {
      inserted++;
      await supabase.from("conversations")
        .update({ last_message_at: sentAt.toISOString() })
        .eq("id", conversationId);
    }
  }
  return inserted;
}

async function mirrorCalls(
  supabase: ReturnType<typeof createClient>,
  creds: { accountSid: string; authToken: string },
  num: NumberRow,
  since: Date,
  dayFilter: string,
): Promise<number> {
  const q = `PageSize=100&${encodeURIComponent("StartTime>")}=${dayFilter}`;
  const inbound = await twilioList(`/Calls.json?To=${encodeURIComponent(num.phone_number)}&${q}`, creds.accountSid, creds.authToken, "calls");
  const outbound = await twilioList(`/Calls.json?From=${encodeURIComponent(num.phone_number)}&${q}`, creds.accountSid, creds.authToken, "calls");

  let inserted = 0;
  for (const c of [...inbound, ...outbound]) {
    const sid = c.sid as string;
    const to = c.to as string;
    const from = c.from as string;
    const startedRaw = (c.start_time as string) || (c.date_created as string);
    const startedAt = startedRaw ? new Date(startedRaw) : null;
    if (!sid || !startedAt || startedAt < since) continue;

    const direction: "inbound" | "outbound" = to === num.phone_number ? "inbound" : "outbound";
    const clientNumber = direction === "inbound" ? from : to;
    if (!clientNumber) continue;

    const { data: existingCall } = await supabase
      .from("call_logs").select("id").eq("twilio_call_sid", sid).maybeSingle();
    if (existingCall) continue;

    const contactId = await resolveContact(supabase, num.org_id, clientNumber);
    if (!contactId) continue;
    const conversationId = await resolveConversation(supabase, num.org_id, contactId, num.agent_label);
    if (!conversationId) continue;

    const duration = Number(c.duration ?? 0) || 0;
    const status = (c.status as string) ?? "completed";

    const { error: callErr } = await supabase.from("call_logs").insert({
      organization_id: num.org_id,
      conversation_id: conversationId,
      contact_id: contactId,
      twilio_call_sid: sid,
      direction,
      from_number: from,
      to_number: to,
      duration,
      status,
    });
    if (callErr && callErr.code !== "23505") {
      console.error("[twilio-mirror-sync] call_logs insert failed:", callErr.message);
      continue;
    }

    // Surface the call in the thread as an event (Twilio has no transcript).
    const label = num.agent_label ?? "AI agent";
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const pretty = duration >= 60 ? `${mins}m ${secs}s` : `${secs}s`;
    await supabase.from("messages").insert({
      organization_id: num.org_id,
      conversation_id: conversationId,
      contact_id: contactId,
      channel: "voice",
      direction: "system",
      message_type: "call_event",
      body: `${direction === "inbound" ? "Inbound" : "Outbound"} call with ${label} — ${pretty} (${status})`,
      sender_name: label,
      sender_identifier: clientNumber,
      metadata: {
        from_number: from,
        to_number: to,
        rail: "twilio",
        mirrored: true,
        agent_label: num.agent_label,
        call_sid: sid,
        duration_seconds: duration,
        call_status: status,
      },
      status: "delivered",
      sent_at: startedAt.toISOString(),
    });

    inserted++;
    await supabase.from("conversations")
      .update({ last_message_at: startedAt.toISOString() })
      .eq("id", conversationId);
  }
  return inserted;
}

/** Find the contact for the client's phone number. Never creates one: contacts come from bookings, forms or manual entry. */
async function resolveContact(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  phone: string,
): Promise<string | null> {
  const { data: matchedId } = await supabase
    .rpc("find_contact_id_by_phone", { p_org: orgId, p_phone: phone });
  return (matchedId as string | null) ?? null;
}

/**
 * One thread per (contact, external agent) so each agent's conversations
 * with the same client stay separate.
 */
async function resolveConversation(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  contactId: string,
  agentLabel: string | null,
): Promise<string | null> {
  const label = agentLabel ?? "AI agent";
  const { data: existing } = await supabase
    .from("conversations").select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("provider", "external_agent")
    .filter("conversation_metadata->>assistant_name", "eq", label)
    .neq("status", "closed")
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as string;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      // channel was never set by any writer, so the column was NULL on every row and the
      // real value only existed inside conversation_metadata.channel_type below.
      channel: "sms",
      status: "open",
      unread_count: 0,
      provider: "external_agent",
      conversation_metadata: { assistant_name: label, channel_type: "sms", read_only: true },
    })
    .select("id")
    .single();
  if (error) {
    console.error("[twilio-mirror-sync] conversation insert failed:", error.message);
    return null;
  }
  return (created as { id: string }).id;
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const RECORDING_LOOKBACK_DAYS = 3;
const RECORDINGS_PER_RUN = 3;

/**
 * Mirrored calls were only ever copied as metadata, so a recording the carrier made never showed up.
 * Twilio keeps it against the CallSid: pull it into the private call-recordings bucket and mark the
 * call; the call-recording-backfill job then adds the Play message and the transcript.
 */
async function attachMirroredRecordings(
  supabase: ReturnType<typeof createClient>,
  creds: { accountSid: string; authToken: string },
  num: NumberRow,
): Promise<number> {
  const cutoff = new Date(Date.now() - RECORDING_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: calls } = await supabase.from("call_logs")
    .select("twilio_call_sid")
    .eq("organization_id", num.org_id)
    .is("recording_path", null)
    .gte("created_at", cutoff)
    .or(`from_number.eq.${num.phone_number},to_number.eq.${num.phone_number}`)
    .order("created_at", { ascending: false })
    .limit(RECORDINGS_PER_RUN);

  let attached = 0;
  for (const c of (calls ?? []) as { twilio_call_sid: string }[]) {
    const sid = c.twilio_call_sid;
    const recs = await twilioList(`/Calls/${encodeURIComponent(sid)}/Recordings.json`, creds.accountSid, creds.authToken, "recordings", 1);
    const done = recs.find((r) => r.status === "completed" && typeof r.uri === "string");
    if (!done) continue;
    const url = `https://api.twilio.com${(done.uri as string).replace(/\.json$/, "")}`;
    if (!isAllowedRecordingUrl(url)) continue;
    const res = await fetch(`${url}.mp3`, { headers: { Authorization: "Basic " + btoa(`${creds.accountSid}:${creds.authToken}`) } });
    if (!res.ok) { console.warn(`[twilio-mirror-sync] recording download ${res.status} for ${sid}`); continue; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = recordingPath(num.org_id, sid);
    const { error } = await supabase.storage.from("call-recordings").upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
    if (error) { console.warn(`[twilio-mirror-sync] recording upload failed for ${sid}: ${error.message}`); continue; }
    const secs = Number(done.duration ?? 0) || null;
    await supabase.from("call_logs").update({ recording_path: path, recording_duration_seconds: secs, transcript_status: "pending" }).eq("twilio_call_sid", sid);
    attached++;
  }
  return attached;
}
