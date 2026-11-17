/**
 * microsoft-calendar — user-facing Outlook calendar writes for the OS UI (create/update/delete
 * events + RSVP), the Microsoft counterpart to the calendar write actions of google-calendar-sync.
 * Authenticated as the signed-in user; acts through their own Microsoft connection and keeps the
 * microsoft_calendar_events mirror in sync so the calendar views update immediately.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { getValidAccessToken } from "../_shared/ms-graph.ts";
import { connectionOfMirroredEvent, ownedConnectionId } from "../_shared/ms-connection-select.ts";
import { createEvent, deleteEvent, respondEvent, syncCalendarWindow, updateEvent } from "../_shared/ms-calendar.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const RSVP: Record<string, "accept" | "decline" | "tentativelyAccept"> = { accepted: "accept", declined: "decline", tentative: "tentativelyAccept" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = getSupabaseClient();
  const ctx = await extractUserContext(req, supabase);
  if (!ctx) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = String(body.action ?? "");
  try {
    const eventId = String(body.eventId ?? "");
    // Optional `connection_id` picks one of the caller's Microsoft accounts (default: the primary). A connection
    // that is not the caller's is refused. For update/delete/rsvp with no selector, the account that holds the
    // mirrored event is used when that is unambiguous, so editing a secondary-calendar event just works.
    const owned = await ownedConnectionId(supabase, ctx.id, body.connection_id);
    if (!owned) return json({ success: false, error: "That Microsoft account is not connected for your user" }, 403);
    let connectionId = owned.connectionId;
    if (!connectionId && eventId && ["update-event", "delete-event", "rsvp"].includes(action)) {
      connectionId = await connectionOfMirroredEvent(supabase, ctx.id, eventId);
    }
    const cu = { orgId: ctx.orgId, userId: ctx.id, connectionId };
    const token = await getValidAccessToken(supabase, ctx.id, { connectionId });
    switch (action) {
      case "sync": {
        // Manual on-demand pull of the signed-in user's Outlook calendar window into the mirror.
        // (The scheduled microsoft-calendar-sync cron does this automatically for every connection.)
        const out = await syncCalendarWindow(supabase, token, cu);
        return json({ success: true, synced: out.upserted, removed: out.removed });
      }
      case "create-event": {
        const e = body.event as Record<string, unknown> ?? body;
        const out = await createEvent(supabase, token, cu, {
          subject: String(e.summary ?? e.subject ?? "Untitled"),
          startISO: String(e.start_time ?? e.startISO ?? ""),
          endISO: String(e.end_time ?? e.endISO ?? ""),
          body: e.description as string | undefined,
          attendees: (e.attendees as string[]) ?? undefined,
        });
        return json({ success: true, id: out.id });
      }
      case "update-event": {
        const u = body.updates as Record<string, unknown> ?? {};
        await updateEvent(supabase, token, cu, eventId, {
          subject: u.summary as string | undefined,
          startISO: u.start_time as string | undefined,
          endISO: u.end_time as string | undefined,
          location: u.location as string | undefined,
          body: u.description as string | undefined,
          attendees: u.attendees as string[] | undefined,
        });
        return json({ success: true });
      }
      case "delete-event":
        await deleteEvent(supabase, token, cu, eventId);
        return json({ success: true });
      case "rsvp": {
        const r = RSVP[String(body.response ?? "")];
        if (!r) return json({ error: "invalid response" }, 400);
        await respondEvent(token, eventId, r);
        return json({ success: true });
      }
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("[microsoft-calendar]", action, e);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
