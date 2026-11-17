/**
 * booking-microsoft-sync — service-role-only: mirror a booked appointment onto the host's Outlook
 * calendar (create / update / reschedule / delete). The Microsoft replacement for
 * booking-google-sync. Reuses ms-calendar's create/update/delete helpers and stores the Graph
 * event id on appointments.external_event_id with external_calendar_provider = 'microsoft'
 * (google_event_id is reserved for Google Calendar ids so the Google sync never misreads it).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getValidAccessToken } from "../_shared/ms-graph.ts";
import { createEvent, deleteEvent, updateEvent } from "../_shared/ms-calendar.ts";
import { connectionOfMirroredEvent } from "../_shared/ms-connection-select.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${serviceRoleKey}`) return json(401, { error: "Unauthorized" });

  let body: { appointmentId?: string; operation?: "create" | "update" | "reschedule" | "delete" };
  try { body = await req.json(); } catch { return json(400, { error: "invalid json" }); }
  const { appointmentId, operation = "create" } = body;
  if (!appointmentId) return json(400, { error: "appointmentId is required" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: appt, error } = await supabase.from("appointments")
      .select("id, org_id, assigned_user_id, start_at_utc, end_at_utc, status, location, external_event_id, external_calendar_provider, appointment_type:appointment_types(name), contact:contacts(first_name, last_name, email)")
      .eq("id", appointmentId).maybeSingle();
    if (error || !appt) return json(404, { error: "appointment not found" });

    const a = appt as unknown as {
      org_id: string; assigned_user_id: string | null; start_at_utc: string; end_at_utc: string;
      location: string | null; external_event_id: string | null; external_calendar_provider: string | null;
      appointment_type: { name?: string } | null; contact: { first_name?: string; last_name?: string; email?: string } | null;
    };
    if (!a.assigned_user_id) return json(200, { success: true, data: { synced: false, reason: "no_host" } });

    // Only an event this function created (provider 'microsoft') is ours to update/delete.
    const existingId = a.external_calendar_provider === "microsoft" ? a.external_event_id : null;

    // New events go on the host's primary calendar. An existing event is changed on the account that holds it
    // (found from the calendar mirror), so promoting another account to primary never strands it.
    const connectionId = existingId ? await connectionOfMirroredEvent(supabase, a.assigned_user_id, existingId) : undefined;
    let token: string;
    try { token = await getValidAccessToken(supabase, a.assigned_user_id, { connectionId }); }
    catch { return json(200, { success: true, data: { synced: false, reason: "no_connection" } }); }

    const ctx = { orgId: a.org_id, userId: a.assigned_user_id, connectionId };
    const contactName = [a.contact?.first_name, a.contact?.last_name].filter(Boolean).join(" ").trim();
    const subject = `${a.appointment_type?.name ?? "Appointment"}${contactName ? ` — ${contactName}` : ""}`;
    const attendees = a.contact?.email ? [a.contact.email] : [];

    if (operation === "delete") {
      if (existingId) await deleteEvent(supabase, token, ctx, existingId);
      if (existingId) {
        await supabase.from("appointments").update({ external_event_id: null, external_calendar_provider: null }).eq("id", appointmentId);
      }
      return json(200, { success: true, data: { synced: true } });
    }

    if ((operation === "update" || operation === "reschedule") && existingId) {
      await updateEvent(supabase, token, ctx, existingId, {
        subject, startISO: a.start_at_utc, endISO: a.end_at_utc, location: a.location ?? undefined, attendees,
      });
      return json(200, { success: true, data: { synced: true, eventId: existingId } });
    }

    // create (or update with no existing event → create)
    const created = await createEvent(supabase, token, ctx, {
      subject, startISO: a.start_at_utc, endISO: a.end_at_utc, attendees,
      body: a.location ? `Location: ${a.location}` : "",
    });
    await supabase.from("appointments")
      .update({ external_event_id: created.id, external_calendar_provider: "microsoft" })
      .eq("id", appointmentId);
    return json(200, { success: true, data: { synced: true, eventId: created.id } });
  } catch (e) {
    console.error("[booking-microsoft-sync]", e);
    return json(500, { success: false, error: (e as Error).message });
  }
});
