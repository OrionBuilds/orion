/**
 * meeting-transcript-import — paste or upload a transcript the OS can't fetch itself (a meeting
 * the owner didn't organise, a phone recording, a Zoom export). Same digest + filing path as the Teams
 * processor, provider 'manual'. Authenticated; requires meetings.manage.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext } from "../_shared/auth.ts";
import { hasPermission } from "../_shared/permissions.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { runMeetingDigest, type MeetingRecord } from "../_shared/clara/meeting-digest.ts";
import { fileMeeting } from "../_shared/clara/meeting-file.ts";
import { CONSENT_REQUIRED_MESSAGE, parseConsent } from "../_shared/meeting-consent.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const db = serviceClient();
  const user = await extractUserContext(req, db);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!hasPermission(user, "meetings.manage")) return json({ error: "Forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  // Importing a transcript of a call with other people needs a stated consent basis (stored as the audit trail).
  const consent = parseConsent(body.consent_basis, body.consent_note);
  if (!consent) return json({ error: CONSENT_REQUIRED_MESSAGE, code: "consent_required" }, 400);

  const transcript = String(body.transcript ?? "").trim();
  const title = String(body.title ?? "").trim() || "Imported meeting";
  if (transcript.length < 20) return json({ error: "transcript too short" }, 400);

  const attendeesIn = Array.isArray(body.attendees) ? body.attendees : [];
  const attendees = attendeesIn
    .map((a) => (typeof a === "string" ? { email: a } : a as { name?: string; email?: string }))
    .filter((a) => a && (a.email || a.name));
  const externalId = String(body.idempotency_key ?? "") || `manual:${crypto.randomUUID()}`;
  const meetingDate = typeof body.meeting_date === "string" ? body.meeting_date : new Date().toISOString();

  const rec: MeetingRecord = {
    provider: "manual", externalId, title, startedAt: meetingDate, endedAt: null,
    attendees, organizerEmail: user.email, transcript, sourceSummary: typeof body.summary === "string" ? body.summary : null,
  };

  try {
    const digest = await runMeetingDigest(denoEnv, rec);
    if (!digest) return json({ error: "Could not digest the transcript (model unavailable or key missing)" }, 502);
    const filed = await fileMeeting(db, denoEnv, user.orgId, rec, digest, {
      importedBy: user.id,
      claraUserId: denoEnv.get("CLARA_USER_ID")?.trim() || null,
      ownerUserId: denoEnv.get("OWNER_USER_ID")?.trim() || null,
      consent,
    });
    return json({ success: true, ...filed, summary: digest.summary, items: digest.items.length });
  } catch (e) {
    console.error("[meeting-transcript-import]", e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
