/**
 * Twilio REST calls Clara's voice flows need (ported from CLARA's channels.ts): place a call,
 * move a live call to new TwiML, hang up, delete a hold queue. SMS goes through the existing
 * sendTwilioSms in ../twilio.ts.
 *
 * Every function takes the credentials explicitly so tests never touch the environment.
 */
const API = "https://api.twilio.com/2010-04-01";

export interface TwilioAuth { accountSid: string; authToken: string }

type F = typeof fetch;
const basic = (a: TwilioAuth) => "Basic " + btoa(`${a.accountSid}:${a.authToken}`);
const base = (a: TwilioAuth) => `${API}/Accounts/${encodeURIComponent(a.accountSid)}`;

async function rest(a: TwilioAuth, path: string, method: "GET" | "POST" | "DELETE", form?: URLSearchParams, f: F = fetch) {
  const r = await f(`${base(a)}${path}`, {
    method,
    headers: { Authorization: basic(a), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form?.toString(),
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: r.ok ? text : text.slice(0, 300) };
}

export interface PlaceCallOpts {
  statusCallback?: string;
  statusCallbackEvent?: string[];
  machineDetection?: "Enable" | "DetectMessageEnd";
  machineDetectionTimeoutSec?: number;
  timeoutSec?: number;
}

/**
 * Place an outbound call. Recording is deliberately NOT enabled at the call level: Record=true
 * would capture from the moment of answer, racing the spoken disclosure. Each TwiML path starts
 * recording itself with <Start><Recording> after the disclosure has played.
 */
export async function placeCall(
  a: TwilioAuth, from: string, to: string, target: { twiml?: string; url?: string },
  opts: PlaceCallOpts = {}, f: F = fetch,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const form = new URLSearchParams({ To: to, From: from });
  if (target.twiml) form.set("Twiml", target.twiml);
  else if (target.url) form.set("Url", target.url);
  else return { ok: false, error: "twiml or url required" };
  if (opts.statusCallback) form.set("StatusCallback", opts.statusCallback);
  for (const ev of opts.statusCallbackEvent ?? []) form.append("StatusCallbackEvent", ev);
  if (opts.machineDetection) form.set("MachineDetection", opts.machineDetection);
  // Twilio's floor for detection time is 3s.
  if (opts.machineDetectionTimeoutSec) form.set("MachineDetectionTimeout", String(Math.max(3, Math.min(59, Math.round(opts.machineDetectionTimeoutSec)))));
  if (opts.timeoutSec) form.set("Timeout", String(Math.max(5, Math.min(600, Math.round(opts.timeoutSec)))));
  const r = await rest(a, "/Calls.json", "POST", form, f);
  if (!r.ok) return { ok: false, error: `Twilio call ${r.status}: ${r.body}` };
  return { ok: true, sid: (JSON.parse(r.body) as { sid?: string }).sid };
}

/** Move a live call to new TwiML, wherever it is (queue, mid-<Play>, mid-<Gather>). */
export async function redirectCall(a: TwilioAuth, callSid: string, url: string, f: F = fetch) {
  const r = await rest(a, `/Calls/${encodeURIComponent(callSid)}.json`, "POST", new URLSearchParams({ Url: url, Method: "POST" }), f);
  return r.ok ? { ok: true } : { ok: false, error: `Twilio redirect ${r.status}: ${r.body}` };
}

export async function hangupCall(a: TwilioAuth, callSid: string, f: F = fetch) {
  const r = await rest(a, `/Calls/${encodeURIComponent(callSid)}.json`, "POST", new URLSearchParams({ Status: "completed" }), f);
  return r.ok ? { ok: true } : { ok: false, error: `Twilio hangup ${r.status}: ${r.body}` };
}

/** Pure: sid of the queue with this exact name on one Queues page, and the next page's path. */
export function queuePageSearch(body: string, name: string): { sid: string | null; nextPath: string | null } {
  try {
    const j = JSON.parse(body) as { queues?: Array<{ sid?: string; friendly_name?: string }>; next_page_uri?: string | null };
    const sid = j.queues?.find((q) => q.friendly_name === name)?.sid ?? null;
    const raw = j.next_page_uri ?? null;
    return { sid, nextPath: raw ? raw.replace(/^\/2010-04-01\/Accounts\/[^/]+/, "") : null };
  } catch {
    return { sid: null, nextPath: null };
  }
}

/** Delete a hold queue by name once its one caller has left. Capped at 20 pages; a cap trip is a failure. */
export async function deleteQueueByName(a: TwilioAuth, name: string, f: F = fetch): Promise<boolean> {
  let next: string | null = "/Queues.json?PageSize=50";
  for (let page = 0; page < 20 && next; page++) {
    const list = await rest(a, next, "GET", undefined, f);
    if (!list.ok) return false;
    const found = queuePageSearch(list.body, name);
    if (found.sid) return (await rest(a, `/Queues/${found.sid}.json`, "DELETE", undefined, f)).ok;
    next = found.nextPath;
  }
  return next === null;
}

/** Start recording a live call (a call on ConversationRelay can't take <Start><Recording> mid-session). */
export async function startCallRecording(a: TwilioAuth, callSid: string, statusCallback: string, f: F = fetch) {
  const form = new URLSearchParams({ RecordingStatusCallback: statusCallback, RecordingStatusCallbackEvent: "completed" });
  const r = await rest(a, `/Calls/${encodeURIComponent(callSid)}/Recordings.json`, "POST", form, f);
  return r.ok ? { ok: true } : { ok: false, error: `Twilio recording ${r.status}: ${r.body}` };
}
