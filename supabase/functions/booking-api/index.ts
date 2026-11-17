import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isWorkspaceProvider, resolveUserProvider, type WorkspaceProvider } from "../_shared/provider.ts";
import { findContactByEmail, findOrCreateOpenOpportunity, LEAD_ACTOR_USER_ID, LEAD_OWNER_USER_ID } from "../_shared/lead-intake.ts";
import { brandFromSettings } from "../_shared/brands.ts";
import { isServiceRoleRequest } from "../_shared/auth.ts";

// CORS stays wildcard ON PURPOSE: booking-api is a public, embeddable endpoint —
// it backs the OS's own /book/<slug> page AND the sharable
// booking widget that can sit on any client domain. An origin allowlist (like
// webchat-api's) would break those legitimate embeds, and CORS is not an auth
// control anyway. The real protections for the public booking surface are the
// honeypot, the per-IP rate limit, and server-side slot re-validation below.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── per-IP rate limit for POST /book ───────────────────────────────────────
// In-memory and per-isolate (Supabase may run several), so this is a coarse
// ceiling, not a guarantee — the difference between "a script mints thousands of
// bookings" (real contacts, real emails, real Google events with sendUpdates:all
// to the fake attendee) and "a script mints a handful". Same shape webchat-api
// uses for session minting.
const BOOK_LIMIT_PER_HOUR = 8;
const bookHits = new Map<string, number[]>();

function clientKey(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function bookRateLimited(key: string): boolean {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (bookHits.get(key) ?? []).filter((t) => t > windowStart);
  hits.push(now);
  bookHits.set(key, hits);
  if (bookHits.size > 5000) {
    for (const [k, v] of bookHits) if (v.every((t) => t <= windowStart)) bookHits.delete(k);
  }
  return hits.length > BOOK_LIMIT_PER_HOUR;
}

interface TimeRange {
  start: string;
  end: string;
}

interface DateOverride {
  date: string;
  available: boolean;
  ranges?: TimeRange[];
}

interface DaySchedule {
  [key: string]: TimeRange[];
}

interface AvailabilitySlot {
  start: string;
  end: string;
  eligible_user_ids: string[];
}


function enqueueBookingEmail(
  appointmentId: string,
  action: "confirmation" | "rescheduled" | "canceled"
): void {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return;
    fetch(`${supabaseUrl}/functions/v1/booking-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appointment_id: appointmentId, action }),
    }).catch((err) => console.error("booking-email enqueue failed:", err));
  } catch (err) {
    console.error("booking-email enqueue error:", err);
  }
}

type GoogleSyncOperation = "create" | "update" | "reschedule" | "delete";

interface GoogleSyncResult {
  synced: boolean;
  meetLink?: string | null;
  googleEventId?: string | null;
  eventId?: string | null;
  reason?: string;
}

/**
 * Which host-calendar sync function owns this appointment: an existing event stays with the
 * provider that created it (external_calendar_provider); a new one goes to the host's connected
 * provider (Google -> booking-google-sync, Microsoft -> booking-microsoft-sync). With nothing
 * connected we still call booking-microsoft-sync, which answers "no_connection" as before.
 */
async function bookingSyncFunctionFor(appointmentId: string): Promise<string> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return "booking-microsoft-sync";
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: appt } = await supabase
      .from("appointments")
      .select("org_id, assigned_user_id, external_calendar_provider")
      .eq("id", appointmentId)
      .maybeSingle();
    const a = appt as { org_id?: string; assigned_user_id?: string | null; external_calendar_provider?: string | null } | null;
    let provider: WorkspaceProvider | null = isWorkspaceProvider(a?.external_calendar_provider) ? a!.external_calendar_provider as WorkspaceProvider : null;
    if (!provider && a?.assigned_user_id) {
      provider = await resolveUserProvider(supabase, a.assigned_user_id, { orgId: a.org_id ?? null });
    }
    return provider === "google" ? "booking-google-sync" : "booking-microsoft-sync";
  } catch (err) {
    console.error("booking sync provider lookup failed:", err);
    return "booking-microsoft-sync";
  }
}

async function syncAppointmentToGoogle(
  appointmentId: string,
  operation: GoogleSyncOperation
): Promise<GoogleSyncResult | null> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return null;

    const fn = await bookingSyncFunctionFor(appointmentId);
    const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "sync-appointment",
        appointmentId,
        operation,
      }),
    });

    if (!res.ok) {
      console.error(`${fn} returned non-OK:`, res.status);
      return { synced: false };
    }
    const json = (await res.json()) as { success?: boolean; data?: GoogleSyncResult };
    return json?.data || { synced: false };
  } catch (err) {
    console.error("booking calendar sync await error:", err);
    return { synced: false };
  }
}

function enqueueGoogleSync(
  appointmentId: string,
  operation: GoogleSyncOperation
): void {
  // Fire-and-forget: resolve the owning provider, then hand off without awaiting the sync.
  // waitUntil keeps the provider lookup + hand-off alive after the response is sent.
  const p = syncAppointmentToGoogle(appointmentId, operation).catch((err) =>
    console.error("booking calendar sync enqueue failed:", err)
  );
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  rt?.waitUntil?.(p);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing environment variables");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const action = pathParts[pathParts.length - 1];

    if (req.method === "GET" && action === "availability") {
      return handleGetAvailability(req, supabase);
    }

    if (req.method === "GET" && action === "calendar") {
      return handleGetCalendarInfo(req, supabase);
    }

    if (req.method === "GET" && action === "calendar-types") {
      return handleGetCalendarTypes(req, supabase);
    }

    if (req.method === "POST" && action === "book") {
      return handleSubmitBooking(req, supabase);
    }

    if (req.method === "POST" && action === "reschedule") {
      return handleReschedule(req, supabase);
    }

    if (req.method === "POST" && action === "cancel") {
      return handleCancel(req, supabase);
    }

    if (req.method === "GET" && action === "appointment") {
      return handleGetAppointment(req, supabase);
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Booking API error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

async function handleGetCalendarTypes(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const url = new URL(req.url);
  const calendarSlug = url.searchParams.get("calendar_slug");

  if (!calendarSlug) {
    return new Response(
      JSON.stringify({ error: "Missing calendar_slug" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // `active` gate matters here: an inactive calendar shouldn't leak its
  // name/description or its appointment-type roster to the public URL.
  const { data: calendar } = await supabase
    .from("calendars")
    .select("id, name, slug, description, active")
    .eq("slug", calendarSlug)
    .eq("active", true)
    .maybeSingle();

  if (!calendar) {
    return new Response(
      JSON.stringify({ error: "Calendar not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: appointmentTypes } = await supabase
    .from("appointment_types")
    .select("id, name, slug, description, duration_minutes, location_type")
    .eq("calendar_id", calendar.id)
    .eq("active", true)
    .order("name");

  return new Response(
    JSON.stringify({
      calendar: { id: calendar.id, name: calendar.name, slug: calendar.slug, description: calendar.description },
      appointment_types: appointmentTypes || [],
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetCalendarInfo(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const url = new URL(req.url);
  const calendarSlug = url.searchParams.get("calendar_slug");
  const appointmentTypeSlug = url.searchParams.get("type_slug");

  if (!calendarSlug || !appointmentTypeSlug) {
    return new Response(
      JSON.stringify({ error: "Missing calendar_slug or type_slug" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Only expose active calendars publicly. An inactive calendar shouldn't leak
  // its team members, host names, or org linkage to anonymous callers.
  const { data: calendar } = await supabase
    .from("calendars")
    .select(
      "id, name, slug, org_id, type, owner_user_id, settings, members:calendar_members(user_id, active)"
    )
    .eq("slug", calendarSlug)
    .eq("active", true)
    .maybeSingle();

  if (!calendar) {
    return new Response(
      JSON.stringify({ error: "Calendar not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const { data: appointmentType } = await supabase
    .from("appointment_types")
    .select("*")
    .eq("calendar_id", calendar.id)
    .eq("slug", appointmentTypeSlug)
    .eq("active", true)
    .maybeSingle();

  if (!appointmentType) {
    return new Response(
      JSON.stringify({ error: "Appointment type not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const settings = calendar.settings as { assignment_mode?: string } | null;
  const isCollective = settings?.assignment_mode === "collective";
  const isUserCalendar = calendar.type === "user" && !!calendar.owner_user_id;

  function makeInitials(name: string): string {
    return (name || "TM")
      .split(" ")
      .map((n: string) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }

  let collectiveMembers: Array<{ name: string; initials: string }> = [];
  let host: { name: string; initials: string } | undefined;

  if (isUserCalendar) {
    const { data: ownerUser } = await supabase
      .from("users")
      .select("id, name")
      .eq("id", calendar.owner_user_id)
      .maybeSingle();
    if (ownerUser) {
      const ownerName = ownerUser.name || "Host";
      host = { name: ownerName, initials: makeInitials(ownerName) };
    }
  }

  if (isCollective) {
    const members = (calendar.members as Array<{ user_id: string; active: boolean }>) || [];
    const activeMembers = members.filter((m) => m.active);

    if (activeMembers.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, name")
        .in("id", activeMembers.map((m) => m.user_id));

      collectiveMembers = (users || []).map((u) => ({
        name: u.name || "Team Member",
        initials: makeInitials(u.name || "TM"),
      }));
    }
  }

  return new Response(
    JSON.stringify({
      calendar: {
        id: calendar.id,
        name: calendar.name,
        slug: calendar.slug,
        type: calendar.type,
        is_collective: isCollective,
        collective_members: isCollective ? collectiveMembers : undefined,
        host,
      },
      appointment_type: {
        id: appointmentType.id,
        name: appointmentType.name,
        slug: appointmentType.slug,
        description: appointmentType.description,
        duration_minutes: appointmentType.duration_minutes,
        location_type: appointmentType.location_type,
        location_value: appointmentType.location_value,
        questions: appointmentType.questions,
        booking_window_days: appointmentType.booking_window_days,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleGetAvailability(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const url = new URL(req.url);
  let calendarId = url.searchParams.get("calendar_id");
  let appointmentTypeId = url.searchParams.get("type_id");
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  const timezone = url.searchParams.get("timezone") || "America/New_York";

  // The booking page may ask by slug so it can fetch availability in parallel with /calendar
  // instead of waiting for the ids. Same active-only lookup as /calendar.
  const calendarSlug = url.searchParams.get("calendar_slug");
  const typeSlug = url.searchParams.get("type_slug");
  if ((!calendarId || !appointmentTypeId) && calendarSlug && typeSlug) {
    const { data: calBySlug } = await supabase
      .from("calendars")
      .select("id")
      .eq("slug", calendarSlug)
      .eq("active", true)
      .maybeSingle();
    const { data: typeBySlug } = calBySlug
      ? await supabase
          .from("appointment_types")
          .select("id")
          .eq("calendar_id", calBySlug.id)
          .eq("slug", typeSlug)
          .eq("active", true)
          .maybeSingle()
      : { data: null };
    if (!calBySlug || !typeBySlug) {
      return new Response(
        JSON.stringify({ error: "Appointment type not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    calendarId = calBySlug.id as string;
    appointmentTypeId = typeBySlug.id as string;
  }

  if (!calendarId || !appointmentTypeId || !startDate || !endDate) {
    return new Response(
      JSON.stringify({ error: "Missing required parameters" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Only active types/calendars leak slots. Previously this GET path (unlike
  // /calendar and /book) skipped the active filter, so a deactivated calendar
  // still handed out bookable slots to anyone holding the ids.
  const { data: appointmentType } = await supabase
    .from("appointment_types")
    .select("*")
    .eq("id", appointmentTypeId)
    .eq("active", true)
    .single();

  if (!appointmentType) {
    return new Response(
      JSON.stringify({ error: "Appointment type not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const { data: calendar } = await supabase
    .from("calendars")
    .select("*, members:calendar_members(*)")
    .eq("id", calendarId)
    .eq("active", true)
    .single();

  if (!calendar) {
    return new Response(
      JSON.stringify({ error: "Calendar not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const { data: availabilityRules } = await supabase
    .from("availability_rules")
    .select("*")
    .eq("calendar_id", calendarId);

  const rules = availabilityRules || [];

  // Enforce the appointment type's rolling booking window and hard-cap the span.
  // booking_window_days was returned to the client but never enforced, so a caller
  // could request a 5-year range and force a huge generation loop / browse
  // arbitrarily far ahead.
  const nowMs = Date.now();
  const windowDays = (appointmentType.booking_window_days as number) ?? 30;
  const windowEndStr = new Date(nowMs + windowDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const spanCapStr = new Date(new Date(startDate).getTime() + 62 * 86400000)
    .toISOString()
    .slice(0, 10);
  let effectiveEnd = endDate < windowEndStr ? endDate : windowEndStr;
  if (effectiveEnd > spanCapStr) effectiveEnd = spanCapStr;

  const eligibleUserIds = getEligibleUserIds(calendar);

  const busyBlocks = await getBusyBlocks(supabase, calendar, startDate, effectiveEnd);

  const settings = calendar.settings as { assignment_mode?: string } | null;
  const isCollective = settings?.assignment_mode === "collective";

  const slots = generateSlots(
    startDate,
    effectiveEnd,
    calendar,
    rules,
    appointmentType,
    eligibleUserIds,
    busyBlocks,
    isCollective
  );

  return new Response(
    JSON.stringify({ slots }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

function getEligibleUserIds(calendar: Record<string, unknown>): string[] {
  if (calendar.type === "user" && calendar.owner_user_id) {
    return [calendar.owner_user_id as string];
  }

  const members = (calendar.members as Array<{ active: boolean; user_id: string }>) || [];
  return members.filter((m) => m.active).map((m) => m.user_id);
}

// Shift a date by whole days, returning "YYYY-MM-DD". Accepts EITHER a bare
// "YYYY-MM-DD" or a full ISO timestamp — the public site sends start_date/end_date
// as `Date.toISOString()`, so concatenating "T00:00:00.000Z" would make an
// Invalid Date and throw on toISOString(). `new Date()` parses both (date-only ISO
// is treated as UTC), and a NaN guard keeps a malformed value from 500ing the whole
// availability endpoint.
function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr).slice(0, 10);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getBusyBlocks(
  supabase: ReturnType<typeof createClient>,
  calendar: Record<string, unknown>,
  startDate: string,
  endDate: string
): Promise<Array<{ userId: string; start: Date; end: Date }>> {
  const busyBlocks: Array<{ userId: string; start: Date; end: Date }> = [];

  const eligibleUserIds = getEligibleUserIds(calendar);

  // startDate/endDate are bare "YYYY-MM-DD" strings, which coerce to UTC midnight
  // in a timestamp comparison. A naive `.lte(col, endDate)` therefore DROPS any
  // busy block that starts after midnight on the final day of the range — the
  // last-day slots would then ignore real conflicts. Widen the fetch window
  // generously on both ends; over-fetching busy blocks is harmless because a
  // block only removes a slot it actually overlaps.
  const startBound = shiftDateStr(startDate, -1);
  const endBound = shiftDateStr(endDate, 2);

  // An appointment the Google sync MIRRORED from a Google event (history[0].action
  // "created_from_google") defers to the event itself, which already knows whether it's cancelled,
  // marked free, or moved. The mirror never reliably follows those changes, so counting it blocked
  // whole days — e.g. daily all-day "Voice Message Alert" events, cancelled in Google, left zero
  // bookable slots for weeks (2026-10-09).
  // Busy time = scheduled appointments + each host's calendar mirror: Google (google_calendar_events)
  // and/or Microsoft 365 (microsoft_calendar_events), whichever the host has connected.
  const googleEvents = eligibleUserIds.length > 0
    ? ((await supabase
        .from("google_calendar_events")
        .select("user_id, google_event_id, start_time, end_time, status, all_day, appointment_id, transparency")
        .in("user_id", eligibleUserIds)
        .gte("end_time", startBound)
        .lte("start_time", endBound)).data || []) as GoogleBusyEvent[]
    : [];

  const { data: existingAppointmentsRaw } = await supabase
    .from("appointments")
    .select("id, assigned_user_id, start_at_utc, end_at_utc, google_event_id, history")
    .eq("calendar_id", calendar.id)
    .eq("status", "scheduled")
    .gte("start_at_utc", startBound)
    .lte("start_at_utc", endBound);
  const existingAppointments = existingAppointmentsRaw as BusyAppointment[] | null;

  // Resolve mirrors against their Google rows BY ID, at any time: a mirror whose event was moved
  // outside this window (appointment still at the old time) must still defer, or the stale copy
  // keeps blocking slots the owner freed. Keyed by user + event id so a mirror only defers to its
  // own user's event — otherwise the assigned user could show as free while only someone else's
  // calendar blocks. (google_event_id only ever holds Google ids; Graph ids live in
  // external_event_id since 20261028040000.)
  const mirrorEventIds = [...new Set(
    (existingAppointments || []).filter(isGoogleMirror).map((a) => a.google_event_id as string)
  )];
  const syncedEventKeys = new Set<string>();
  if (mirrorEventIds.length > 0) {
    const { data: mirrorEvents } = await supabase
      .from("google_calendar_events")
      .select("user_id, google_event_id")
      .in("google_event_id", mirrorEventIds);
    for (const e of (mirrorEvents || []) as { user_id: string | null; google_event_id: string | null }[]) {
      if (!e.google_event_id) continue;
      syncedEventKeys.add(`${e.user_id ?? ""}|${e.google_event_id}`);
      syncedEventKeys.add(`*|${e.google_event_id}`);
    }
  }

  const mirroredAppointmentIds = new Set<string>();
  for (const apt of existingAppointments || []) {
    if (isGoogleMirror(apt) && syncedEventKeys.has(`${apt.assigned_user_id ?? "*"}|${apt.google_event_id}`)) {
      mirroredAppointmentIds.add(apt.id);
      continue;
    }
    if (apt.assigned_user_id) {
      busyBlocks.push({
        userId: apt.assigned_user_id,
        start: new Date(apt.start_at_utc),
        end: new Date(apt.end_at_utc),
      });
    }
  }

  for (const evt of googleEvents) {
    if (!evt.user_id || !evt.start_time || !evt.end_time) continue;
    if (evt.status === "cancelled") continue;
    // A linked appointment normally speaks for this event — unless that appointment is a
    // mirror we just deferred to the event, in which case the event is the only record.
    if (evt.appointment_id && !mirroredAppointmentIds.has(evt.appointment_id)) continue;
    if (evt.transparency === "transparent") continue;
    busyBlocks.push({
      userId: evt.user_id,
      start: new Date(evt.start_time),
      end: new Date(evt.end_time),
    });
  }

  // Outlook events (Microsoft 365 mirror): same rules as the Google loop above, minus the
  // appointment-linkage dedupe (nothing links appointments to Outlook mirror rows); an
  // appointment's Outlook copy overlaps its own appointment block, so it removes no extra slots.
  const msEvents = eligibleUserIds.length > 0
    ? ((await supabase
        .from("microsoft_calendar_events")
        .select("user_id, start_time, end_time, status, transparency")
        .in("user_id", eligibleUserIds)
        .gte("end_time", startBound)
        .lte("start_time", endBound)).data || [])
    : [];
  for (const evt of msEvents) {
    if (evt.status === "cancelled" || evt.transparency === "transparent") continue;
    busyBlocks.push({
      userId: evt.user_id,
      start: new Date(evt.start_time),
      end: new Date(evt.end_time),
    });
  }

  const { data: blockedSlots } = await supabase
    .from("blocked_slots")
    .select("user_id, start_at_utc, end_at_utc")
    .eq("calendar_id", calendar.id)
    .gte("end_at_utc", startBound)
    .lte("start_at_utc", endBound);

  for (const slot of blockedSlots || []) {
    const start = new Date(slot.start_at_utc);
    const end = new Date(slot.end_at_utc);
    if (slot.user_id) {
      busyBlocks.push({ userId: slot.user_id, start, end });
    } else {
      for (const userId of eligibleUserIds) {
        busyBlocks.push({ userId, start, end });
      }
    }
  }

  return busyBlocks;
}

interface GoogleBusyEvent {
  user_id: string | null; google_event_id: string | null; start_time: string | null; end_time: string | null;
  status: string | null; all_day: boolean | null; appointment_id: string | null; transparency: string | null;
}

interface BusyAppointment {
  id: string; assigned_user_id: string | null; start_at_utc: string; end_at_utc: string;
  google_event_id: string | null; history: unknown;
}

/** An appointment the Google sync created from a Google event (not booked through the OS). */
function isGoogleMirror(apt: { google_event_id?: string | null; history?: unknown }): apt is { google_event_id: string; history: unknown } {
  if (!apt.google_event_id || !Array.isArray(apt.history)) return false;
  const first = apt.history[0] as { action?: string } | undefined;
  return first?.action === "created_from_google";
}

function dateStrInZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayOfWeekInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
    .format(d)
    .toLowerCase();
}

function dateInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(naiveUtcMs));
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  const h = get("hour") % 24;
  const tzMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    h,
    get("minute"),
    get("second")
  );
  const offsetMs = tzMs - naiveUtcMs;
  return new Date(naiveUtcMs - offsetMs);
}

function generateSlots(
  startDate: string,
  endDate: string,
  calendar: Record<string, unknown>,
  rules: Array<Record<string, unknown>>,
  appointmentType: Record<string, unknown>,
  eligibleUserIds: string[],
  busyBlocks: Array<{ userId: string; start: Date; end: Date }>,
  isCollective: boolean
): AvailabilitySlot[] {
  const slots: AvailabilitySlot[] = [];
  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);
  const now = new Date();
  const minNoticeTime = new Date(
    now.getTime() + (appointmentType.min_notice_minutes as number) * 60 * 1000
  );
  const calendarLevelRule = rules.find((r) => r.user_id === null) || rules[0];
  if (!calendarLevelRule) return slots;

  const ruleTimezone =
    (calendarLevelRule.timezone as string) || "America/New_York";
  const seenDates = new Set<string>();

  for (
    let cursor = new Date(startDateObj);
    cursor <= endDateObj;
    cursor = new Date(cursor.getTime() + 86400000)
  ) {
    const noonUtc = new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        12,
        0
      )
    );
    const dateStr = dateStrInZone(noonUtc, ruleTimezone);
    if (seenDates.has(dateStr)) continue;
    seenDates.add(dateStr);

    const dayOfWeek = dayOfWeekInZone(noonUtc, ruleTimezone);

    const dayRanges = getDayRanges(calendarLevelRule, dateStr, dayOfWeek);
    if (dayRanges.length === 0) continue;

    const [yyyy, mm, dd] = dateStr.split("-").map(Number);

    for (const range of dayRanges) {
      const [sh, sm] = range.start.split(":").map(Number);
      const [eh, em] = range.end.split(":").map(Number);
      const rangeStart = dateInZone(yyyy, mm, dd, sh, sm, ruleTimezone);
      const rangeEnd = dateInZone(yyyy, mm, dd, eh, em, ruleTimezone);

      let current = new Date(rangeStart);
      const durationMs = (appointmentType.duration_minutes as number) * 60 * 1000;
      const intervalMs = (appointmentType.slot_interval_minutes as number) * 60 * 1000;

      while (current.getTime() + durationMs <= rangeEnd.getTime()) {
        const slotEnd = new Date(current.getTime() + durationMs);

        if (current < minNoticeTime) {
          current = new Date(current.getTime() + intervalMs);
          continue;
        }

        const bufferBefore = (appointmentType.buffer_before_minutes as number) * 60 * 1000;
        const bufferAfter = (appointmentType.buffer_after_minutes as number) * 60 * 1000;
        const bufferedStart = new Date(current.getTime() - bufferBefore);
        const bufferedEnd = new Date(slotEnd.getTime() + bufferAfter);

        const availableUserIds: string[] = [];

        for (const userId of eligibleUserIds) {
          const userRule = rules.find((r) => r.user_id === userId);
          const effectiveRule = userRule || calendarLevelRule;
          const memberTz = (effectiveRule.timezone as string) || ruleTimezone;
          const memberDayRanges = getDayRanges(
            effectiveRule,
            dateStr,
            dayOfWeek
          );

          const withinMemberSchedule = memberDayRanges.some((mr) => {
            const [msh, msm] = mr.start.split(":").map(Number);
            const [meh, mem] = mr.end.split(":").map(Number);
            const mStart = dateInZone(yyyy, mm, dd, msh, msm, memberTz);
            const mEnd = dateInZone(yyyy, mm, dd, meh, mem, memberTz);
            return current >= mStart && slotEnd <= mEnd;
          });

          if (!withinMemberSchedule) continue;

          const userBusyBlocks = busyBlocks.filter((b) => b.userId === userId);
          const hasConflict = userBusyBlocks.some(
            (b) => bufferedStart < b.end && bufferedEnd > b.start
          );

          if (!hasConflict) {
            availableUserIds.push(userId);
          }
        }

        if (isCollective) {
          if (availableUserIds.length === eligibleUserIds.length && eligibleUserIds.length > 0) {
            slots.push({
              start: current.toISOString(),
              end: slotEnd.toISOString(),
              eligible_user_ids: availableUserIds,
            });
          }
        } else {
          if (availableUserIds.length > 0) {
            slots.push({
              start: current.toISOString(),
              end: slotEnd.toISOString(),
              eligible_user_ids: availableUserIds,
            });
          }
        }

        current = new Date(current.getTime() + intervalMs);
      }
    }
  }

  return slots;
}

/**
 * Server-side authority for "is this exact slot bookable right now?". Used by
 * POST /book so a booking can only succeed for a slot the availability engine
 * currently offers. Cheap pre-checks (past / min-notice / window / duration)
 * short-circuit; then it regenerates the slots around the requested day with the
 * SAME generateSlots the public /availability path uses and requires an exact
 * start+end match — closing double-book, off-hours, and past-date holes.
 */
async function isSlotBookable(
  supabase: ReturnType<typeof createClient>,
  calendar: Record<string, unknown>,
  appointmentType: Record<string, unknown>,
  startUtc: string,
  endUtc: string
): Promise<{ ok: boolean; reason?: string }> {
  const start = new Date(startUtc);
  const end = new Date(endUtc);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { ok: false, reason: "Invalid time." };
  }

  const now = Date.now();
  const minNoticeMs = ((appointmentType.min_notice_minutes as number) ?? 0) * 60 * 1000;
  if (start.getTime() < now + minNoticeMs) {
    return { ok: false, reason: "That time is no longer available." };
  }

  const windowDays = (appointmentType.booking_window_days as number) ?? 30;
  if (start.getTime() > now + windowDays * 86400000) {
    return { ok: false, reason: "That time is outside the booking window." };
  }

  const expectedMs = ((appointmentType.duration_minutes as number) ?? 30) * 60 * 1000;
  if (end.getTime() - start.getTime() !== expectedMs) {
    return { ok: false, reason: "Invalid slot length." };
  }

  // Regenerate over a ±1 day window (covers the availability timezone's date
  // boundary) and confirm the exact slot is on offer.
  const dayBefore = new Date(start.getTime() - 86400000).toISOString().slice(0, 10);
  const dayAfter = new Date(start.getTime() + 86400000).toISOString().slice(0, 10);

  const { data: availabilityRules } = await supabase
    .from("availability_rules")
    .select("*")
    .eq("calendar_id", calendar.id);
  const rules = availabilityRules || [];

  const eligibleUserIds = getEligibleUserIds(calendar);
  const busyBlocks = await getBusyBlocks(supabase, calendar, dayBefore, dayAfter);
  const isCollective =
    (calendar.settings as { assignment_mode?: string } | null)?.assignment_mode === "collective";

  const slots = generateSlots(
    dayBefore,
    dayAfter,
    calendar,
    rules,
    appointmentType,
    eligibleUserIds,
    busyBlocks,
    isCollective
  );

  const wantStart = start.toISOString();
  const wantEnd = end.toISOString();
  const match = slots.some(
    (s) => new Date(s.start).toISOString() === wantStart && new Date(s.end).toISOString() === wantEnd
  );
  if (!match) {
    return { ok: false, reason: "That time was just taken — please pick another." };
  }
  return { ok: true };
}

function getDayRanges(
  rule: Record<string, unknown>,
  dateStr: string,
  dayOfWeek: string
): TimeRange[] {
  const overrides = (rule.overrides as DateOverride[]) || [];
  const override = overrides.find((o) => o.date === dateStr);

  if (override) {
    if (!override.available) return [];
    return override.ranges || [];
  }

  const schedule = rule.rules as DaySchedule;
  return schedule[dayOfWeek] || [];
}

async function handleSubmitBooking(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const body = await req.json();
  const {
    calendar_id: calendarId,
    appointment_type_id: appointmentTypeId,
    start_utc: startUtc,
    end_utc: endUtc,
    visitor_timezone: visitorTimezone,
    answers,
    _gotcha: honeypot,
  } = body;

  // Honeypot: legit widgets never fill this hidden field. Bots crawling the
  // form and filling every input do. Return the same 200 shape as success so
  // bots can't detect they were rejected.
  if (honeypot) {
    console.warn("[booking-api] honeypot triggered from", req.headers.get("x-forwarded-for") ?? "?");
    return new Response(
      JSON.stringify({ success: true, appointment: { id: crypto.randomUUID() } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (bookRateLimited(clientKey(req))) {
    console.warn("[booking-api] book rate limit hit for", clientKey(req));
    return new Response(
      JSON.stringify({ error: "Too many booking attempts, please try again later." }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!calendarId || !appointmentTypeId || !startUtc || !endUtc || !answers) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Cap `answers` size. Legit intake forms are single-digit KB; a 50KB
  // submission is almost certainly abuse of the free JSON field to bloat
  // the appointments row.
  const ANSWERS_MAX_BYTES = 20 * 1024;
  if (JSON.stringify(answers).length > ANSWERS_MAX_BYTES) {
    return new Response(
      JSON.stringify({ error: "Answers payload too large" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Public booking endpoint - only active calendars, and only within their own
  // appointment types. Previously the appointment_type was looked up by id
  // alone, so an attacker could pair a real calendar_id with an appointment
  // type belonging to a DIFFERENT org and the insert would run under the
  // calendar's org_id, effectively creating a cross-org appointment.
  const { data: calendar } = await supabase
    .from("calendars")
    .select("*, members:calendar_members(*)")
    .eq("id", calendarId)
    .eq("active", true)
    .maybeSingle();

  if (!calendar) {
    return new Response(
      JSON.stringify({ error: "Calendar not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const { data: appointmentType } = await supabase
    .from("appointment_types")
    .select("*")
    .eq("id", appointmentTypeId)
    .eq("calendar_id", calendarId)
    .eq("active", true)
    .maybeSingle();

  if (!appointmentType) {
    return new Response(
      JSON.stringify({ error: "Appointment type not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Re-validate the requested slot server-side. Until now /book trusted the
  // client's start_utc/end_utc verbatim — no availability check, no min-notice,
  // no past-date guard, no conflict check — so anyone could curl an arbitrary
  // time, double-book a taken slot, or book at 3am/in the past. Re-run the SAME
  // slot engine /availability uses and require the requested slot to still be on
  // offer. A race that lost the slot returns 409 so the client can re-pick.
  const bookable = await isSlotBookable(supabase, calendar, appointmentType, startUtc, endUtc);
  if (!bookable.ok) {
    return new Response(
      JSON.stringify({ error: bookable.reason || "That time is no longer available." }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const eligibleUserIds = getEligibleUserIds(calendar);
  const assignedUserId = await assignUser(
    supabase,
    calendar,
    eligibleUserIds,
    startUtc,
    appointmentType.max_per_day
  );

  let contactId = null;
  if (answers.email || answers.phone) {
    contactId = await findOrCreateContact(
      supabase,
      calendar.org_id,
      calendar.department_id,
      answers,
      brandFromSettings(calendar.settings), // the calendar's client brand (calendars.settings.brand)
    );
  }

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .insert({
      org_id: calendar.org_id,
      calendar_id: calendarId,
      appointment_type_id: appointmentTypeId,
      contact_id: contactId,
      assigned_user_id: assignedUserId,
      start_at_utc: startUtc,
      end_at_utc: endUtc,
      visitor_timezone: visitorTimezone || "America/New_York",
      answers,
      source: "booking",
      status: "scheduled",
      history: [{ action: "created", timestamp: new Date().toISOString() }],
    })
    .select()
    .single();

  if (appointmentError) {
    console.error("Failed to create appointment:", appointmentError);
    return new Response(
      JSON.stringify({ error: "Failed to create appointment" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Every booking is a lead: reuse the contact's open Inbound opportunity or open one in New Lead
  // (owner decision, 2026-10-30). Never blocks the booking.
  if (contactId) {
    try {
      const visitorTz = visitorTimezone || "America/New_York";
      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: visitorTz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(new Date(startUtc));
      const who = String(answers.name || answers.email || "Guest").trim();
      await findOrCreateOpenOpportunity(supabase, calendar.org_id, contactId, {
        source: "booking",
        name: `${who} — ${appointmentType.name}`,
        description: `Booked ${appointmentType.name} for ${when} via ${calendar.slug}${answers.email ? `\nEmail: ${answers.email}` : ""}${answers.phone ? `\nPhone: ${answers.phone}` : ""}`,
        assignedUserId: assignedUserId ?? LEAD_OWNER_USER_ID,
        createdBy: LEAD_ACTOR_USER_ID,
      }, {
        created: { eventType: "created_from_booking", summary: `Auto-created from a booking (${appointmentType.name}, ${when})`, payload: { appointment_id: appointment.id, calendar_id: calendarId } },
        reused: { eventType: "appointment_booked", summary: `Booked ${appointmentType.name} for ${when}`, payload: { appointment_id: appointment.id, calendar_id: calendarId } },
      });
    } catch (e) {
      console.error("[booking-api] opportunity upsert failed:", e instanceof Error ? e.message : e);
    }
  }

  if (contactId) {
    await supabase.from("contact_timeline").insert({
      contact_id: contactId,
      user_id: null,
      event_type: "appointment_booked",
      event_data: {
        appointment_id: appointment.id,
        start_time: startUtc,
        appointment_type: appointmentType.name,
        title: appointmentType.name,
      },
    });
  }

  // NOTE: no manual event_outbox `appointment_booked` here — the DB trigger emit_event_appointment_booked
  // fires on the insert above and notification-dispatcher loads type/contact/time/assignee from the row.
  // A second row here double-posted the booking toast for every admin.

  const syncResult = await syncAppointmentToGoogle(appointment.id, "create");
  const googleMeetLink = syncResult?.meetLink || null;

  enqueueBookingEmail(appointment.id, "confirmation");

  // Host shown as ORGANIZER in the booking page's "Add to calendar" invite.
  const { data: organizer } = assignedUserId
    ? await supabase.from("users").select("name, email").eq("id", assignedUserId).maybeSingle()
    : { data: null };

  return new Response(
    JSON.stringify({
      success: true,
      appointment: {
        id: appointment.id,
        start_at_utc: appointment.start_at_utc,
        end_at_utc: appointment.end_at_utc,
        reschedule_token: appointment.reschedule_token,
        cancel_token: appointment.cancel_token,
        google_meet_link: googleMeetLink,
        visitor_timezone: appointment.visitor_timezone,
        organizer: organizer?.email
          ? { name: (organizer.name as string | null) ?? null, email: organizer.email as string }
          : null,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function assignUser(
  supabase: ReturnType<typeof createClient>,
  calendar: Record<string, unknown>,
  eligibleUserIds: string[],
  startUtc: string,
  maxPerDay: number | null
): Promise<string> {
  if (calendar.type === "user" && calendar.owner_user_id) {
    return calendar.owner_user_id as string;
  }

  const members = (calendar.members as Array<{
    active: boolean;
    user_id: string;
    weight: number;
    priority: number;
  }>) || [];

  let activeMembers = members.filter(
    (m) => m.active && eligibleUserIds.includes(m.user_id)
  );

  if (activeMembers.length === 0) {
    throw new Error("No team members available");
  }

  if (maxPerDay) {
    const dayStart = startUtc.split("T")[0] + "T00:00:00.000Z";
    const dayEnd = startUtc.split("T")[0] + "T23:59:59.999Z";

    const filteredMembers = [];
    for (const member of activeMembers) {
      const { count } = await supabase
        .from("appointments")
        .select("*", { count: "exact", head: true })
        .eq("calendar_id", calendar.id)
        .eq("assigned_user_id", member.user_id)
        .eq("status", "scheduled")
        .gte("start_at_utc", dayStart)
        .lt("start_at_utc", dayEnd);

      if ((count || 0) < maxPerDay) {
        filteredMembers.push(member);
      }
    }

    if (filteredMembers.length === 0) {
      throw new Error("All team members have reached their daily limit");
    }

    activeMembers = filteredMembers;
  }

  const settings = calendar.settings as { assignment_mode: string; last_assigned_index: number };

  if (settings.assignment_mode === "collective") {
    return activeMembers[0].user_id;
  }

  if (settings.assignment_mode === "priority") {
    const sorted = [...activeMembers].sort((a, b) => b.priority - a.priority);
    return sorted[0].user_id;
  }

  const totalWeight = activeMembers.reduce((sum, m) => sum + m.weight, 0);
  const expandedList: string[] = [];
  for (const member of activeMembers) {
    for (let i = 0; i < member.weight; i++) {
      expandedList.push(member.user_id);
    }
  }

  const currentIndex = settings.last_assigned_index % expandedList.length;
  const selectedUserId = expandedList[currentIndex];

  await supabase
    .from("calendars")
    .update({
      settings: {
        ...settings,
        last_assigned_index: (settings.last_assigned_index + 1) % totalWeight,
      },
    })
    .eq("id", calendar.id);

  return selectedUserId;
}

async function findOrCreateContact(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  departmentId: string | null,
  answers: { name?: string; email?: string; phone?: string },
  brand: string | null = null,
): Promise<string | null> {
  if (answers.email) {
    // Oldest active unmerged match, case-insensitive (a duplicate email must not 500 the booking).
    const existingByEmail = await findContactByEmail(supabase, organizationId, answers.email);
    if (existingByEmail) return existingByEmail.id;
  }

  if (answers.phone) {
    const normalizedPhone = answers.phone.replace(/\D/g, "");
    const { data: existingByPhone } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .is("merged_into_contact_id", null)
      .or(`phone.eq.${normalizedPhone},phone.eq.${answers.phone}`)
      .maybeSingle();

    if (existingByPhone) return existingByPhone.id;
  }

  let effectiveDepartmentId = departmentId;
  if (!effectiveDepartmentId) {
    const { data: departments } = await supabase
      .from("departments")
      .select("id")
      .eq("organization_id", organizationId)
      .limit(1);

    effectiveDepartmentId = departments?.[0]?.id;
  }

  if (!effectiveDepartmentId) return null;

  const nameParts = (answers.name || "").trim().split(" ");
  const firstName = nameParts[0] || "Guest";
  const lastName = nameParts.slice(1).join(" ") || "";

  const { data: newContact, error } = await supabase
    .from("contacts")
    .insert({
      organization_id: organizationId,
      department_id: effectiveDepartmentId,
      first_name: firstName,
      last_name: lastName,
      email: answers.email || null,
      phone: answers.phone?.replace(/\D/g, "") || null,
      source: "booking",
      status: "active",
      ...(brand ? { brand } : {}),
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to create contact:", error);
    return null;
  }

  return newContact.id;
}

/**
 * Load the calendar + appointment type behind an appointment so the
 * reschedule/cancel policy columns (allow_reschedule, allow_cancel, and the
 * *_deadline_hours) can be honored. Returns nulls if the rows are gone; callers
 * fall back to "allowed" so a missing calendar never traps a customer.
 */
async function loadBookingContext(
  supabase: ReturnType<typeof createClient>,
  appointment: Record<string, unknown>
): Promise<{ calendar: Record<string, unknown> | null; appointmentType: Record<string, unknown> | null }> {
  const [{ data: calendar }, { data: appointmentType }] = await Promise.all([
    appointment.calendar_id
      // Join members — isSlotBookable → getEligibleUserIds needs them, or a
      // collective calendar regenerates zero slots and every reschedule 409s.
      ? supabase.from("calendars").select("*, members:calendar_members(*)").eq("id", appointment.calendar_id).maybeSingle()
      : Promise.resolve({ data: null }),
    appointment.appointment_type_id
      ? supabase.from("appointment_types").select("*").eq("id", appointment.appointment_type_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return { calendar: calendar ?? null, appointmentType: appointmentType ?? null };
}

/**
 * A self-service change (reschedule/cancel) is inside the cutoff when the
 * appointment starts sooner than `deadlineHours` from now. deadlineHours null/0
 * means no cutoff. Returned as a helper so both handlers phrase it identically.
 */
function pastSelfServiceDeadline(startAtUtc: string, deadlineHours: number | null | undefined): boolean {
  const hrs = Number(deadlineHours) || 0;
  if (hrs <= 0) return false;
  const start = Date.parse(startAtUtc);
  if (!isFinite(start)) return false;
  return start - Date.now() < hrs * 3_600_000;
}

async function handleReschedule(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const body = await req.json();
  const { token, new_start_utc: newStartUtc, new_end_utc: newEndUtc } = body;

  if (!token || !newStartUtc || !newEndUtc) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Reject a reschedule into the past or with end <= start. Both are always
  // user error and the previous version happily wrote them, poisoning the
  // history + Google sync with malformed slots.
  const parsedStart = Date.parse(newStartUtc);
  const parsedEnd = Date.parse(newEndUtc);
  if (!isFinite(parsedStart) || !isFinite(parsedEnd) || parsedEnd <= parsedStart || parsedStart < Date.now() - 60_000) {
    return new Response(
      JSON.stringify({ error: "Invalid new_start_utc / new_end_utc" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: appointment } = await supabase
    .from("appointments")
    .select("*")
    .eq("reschedule_token", token)
    .eq("status", "scheduled")
    .maybeSingle();

  if (!appointment) {
    return new Response(
      JSON.stringify({ error: "Appointment not found or already canceled" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Honor the calendar's self-service reschedule policy + deadline, and re-check
  // that the requested new slot is actually on offer (past/min-notice/window/
  // duration + not taken/off-hours) — the same guard POST /book uses.
  // The host's own change (Clara acting for the owner, service-role call) is not "online
  // self-service": the guest policy and deadline don't apply. The slot check still does.
  const { calendar, appointmentType } = await loadBookingContext(supabase, appointment);
  if (calendar && !isServiceRoleRequest(req)) {
    if (calendar.allow_reschedule === false) {
      return new Response(
        JSON.stringify({ error: "This appointment can't be rescheduled online. Please contact us to change it." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (pastSelfServiceDeadline(appointment.start_at_utc as string, calendar.reschedule_deadline_hours as number | null)) {
      return new Response(
        JSON.stringify({ error: "It's too close to the appointment time to reschedule online. Please contact us." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
  if (calendar && appointmentType) {
    const bookable = await isSlotBookable(supabase, calendar, appointmentType, newStartUtc, newEndUtc);
    if (!bookable.ok) {
      return new Response(
        JSON.stringify({ error: bookable.reason || "That new time is no longer available." }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  const historyEntry = {
    action: "rescheduled",
    timestamp: new Date().toISOString(),
    previous_start: appointment.start_at_utc,
    previous_end: appointment.end_at_utc,
  };

  const { data: updated, error } = await supabase
    .from("appointments")
    .update({
      start_at_utc: newStartUtc,
      end_at_utc: newEndUtc,
      history: [...(appointment.history || []), historyEntry],
    })
    .eq("id", appointment.id)
    .select()
    .single();

  if (error) {
    return new Response(
      JSON.stringify({ error: "Failed to reschedule" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  if (appointment.contact_id) {
    await supabase.from("contact_timeline").insert({
      contact_id: appointment.contact_id,
      user_id: null,
      event_type: "appointment_rescheduled",
      event_data: {
        appointment_id: appointment.id,
        old_time: appointment.start_at_utc,
        new_time: newStartUtc,
      },
    });
  }

  enqueueBookingEmail(appointment.id, "rescheduled");
  enqueueGoogleSync(appointment.id, "reschedule");

  return new Response(
    JSON.stringify({
      success: true,
      appointment: {
        id: updated.id,
        start_at_utc: updated.start_at_utc,
        end_at_utc: updated.end_at_utc,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleCancel(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const body = await req.json();
  const { token, reason } = body;

  if (!token) {
    return new Response(
      JSON.stringify({ error: "Missing token" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const { data: appointment } = await supabase
    .from("appointments")
    .select("*")
    .eq("cancel_token", token)
    .eq("status", "scheduled")
    .maybeSingle();

  if (!appointment) {
    return new Response(
      JSON.stringify({ error: "Appointment not found or already canceled" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Honor the calendar's self-service cancel policy + deadline.
  const { calendar: cancelCalendar } = await loadBookingContext(supabase, appointment);
  if (cancelCalendar && !isServiceRoleRequest(req)) {
    if (cancelCalendar.allow_cancel === false) {
      return new Response(
        JSON.stringify({ error: "This appointment can't be canceled online. Please contact us to cancel it." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (pastSelfServiceDeadline(appointment.start_at_utc as string, cancelCalendar.cancel_deadline_hours as number | null)) {
      return new Response(
        JSON.stringify({ error: "It's too close to the appointment time to cancel online. Please contact us." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  const historyEntry = {
    action: "canceled",
    timestamp: new Date().toISOString(),
    reason: reason || undefined,
  };

  const { error } = await supabase
    .from("appointments")
    .update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      history: [...(appointment.history || []), historyEntry],
    })
    .eq("id", appointment.id);

  if (error) {
    return new Response(
      JSON.stringify({ error: "Failed to cancel" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  if (appointment.contact_id) {
    await supabase.from("contact_timeline").insert({
      contact_id: appointment.contact_id,
      user_id: null,
      event_type: "appointment_canceled",
      event_data: {
        appointment_id: appointment.id,
        reason,
      },
    });
  }

  enqueueBookingEmail(appointment.id, "canceled");
  enqueueGoogleSync(appointment.id, "delete");

  return new Response(
    JSON.stringify({ success: true }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleGetAppointment(
  req: Request,
  supabase: ReturnType<typeof createClient>
) {
  const url = new URL(req.url);
  const rescheduleToken = url.searchParams.get("reschedule_token");
  const cancelToken = url.searchParams.get("cancel_token");

  if (!rescheduleToken && !cancelToken) {
    return new Response(
      JSON.stringify({ error: "Missing token" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  let query = supabase
    .from("appointments")
    .select(`
      *,
      calendar:calendars(id, name, slug),
      appointment_type:appointment_types(id, name, duration_minutes, location_type, location_value)
    `);

  if (rescheduleToken) {
    query = query.eq("reschedule_token", rescheduleToken);
  } else {
    query = query.eq("cancel_token", cancelToken);
  }

  const { data: appointment } = await query.maybeSingle();

  if (!appointment) {
    return new Response(
      JSON.stringify({ error: "Appointment not found" }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  return new Response(
    JSON.stringify({
      appointment: {
        id: appointment.id,
        status: appointment.status,
        start_at_utc: appointment.start_at_utc,
        end_at_utc: appointment.end_at_utc,
        visitor_timezone: appointment.visitor_timezone,
        google_meet_link: appointment.google_meet_link,
        calendar: appointment.calendar,
        appointment_type: appointment.appointment_type,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}
