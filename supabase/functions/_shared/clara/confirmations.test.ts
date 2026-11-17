import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { confirmationGoal, queueConfirmations } from "./confirmations.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const env = { get: (k: string) => ({ BUSINESS_NAME: "Acme Co" })[k] };
const appt = (id: string, h: number, extra: Record<string, unknown> = {}) => ({ id, org_id: "o", contact_id: "c1", status: "scheduled", start_at_utc: new Date(NOW.getTime() + h * 3_600_000).toISOString(), visitor_timezone: "America/Chicago", ...extra });
const contacts = [
  { id: "c1", first_name: "Pat", last_name: "Lee", phone: "(555) 123-0001", status: "active" },
  { id: "c2", first_name: "No", last_name: "Phone", phone: null, status: "active" },
  { id: "c3", first_name: "Gone", last_name: "Archived", phone: "+15551230003", status: "archived" },
];

Deno.test("only appointments about a day out, with a callable contact, are queued — once", async () => {
  const f = new FakeSupabase({
    contacts,
    appointments: [
      appt("soon", 2), appt("tomorrow", 24), appt("far", 72), appt("nophone", 24, { contact_id: "c2" }), appt("archived", 25, { contact_id: "c3" }),
      appt("canceled", 24, { status: "canceled" }), appt("nocontact", 24, { contact_id: null }),
    ],
  }, { unique: { clara_call_requests: [["appointment_id", "kind"]] } });
  const db = asClient(f);
  assertEquals(await queueConfirmations(db, env, NOW), { queued: 1, skipped: 3 });
  const row = f.rows("clara_call_requests")[0];
  assertEquals([row.appointment_id, row.kind, row.phone_e164, row.requested_by, row.name], ["tomorrow", "confirm_appointment", "+15551230001", "system", "Pat Lee"]);
  // The hourly cron runs again: nothing new, nothing duplicated.
  assertEquals((await queueConfirmations(db, env, NOW)).queued, 0);
  assertEquals(f.rows("clara_call_requests").length, 1);
});

Deno.test("the goal names the business and the local time in the invitee's timezone", () => {
  assertEquals(confirmationGoal("Acme Co", "2026-10-21T15:00:00Z", "America/Chicago"), "I'm calling to confirm your appointment with Acme Co on Wednesday at 10:00 AM. Will you still be able to make it?");
});
