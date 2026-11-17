import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase } from "./testing/fake-supabase.ts";
import {
  buildFormSubmittedPayload, displayValue, findContactByEmail, findOrCreateOpenOpportunity,
  LEAD_ACTOR_USER_ID, LEAD_OWNER_USER_ID, LEAD_PIPELINE_ID, LEAD_STAGE_ID, normalizeEmail,
  recordFormSubmission, splitName, upsertContactByEmail,
} from "./lead-intake.ts";

const ORG = "org-1";
const timeline = {
  created: { eventType: "created_from_form", summary: "created" },
  reused: { eventType: "form_resubmitted", summary: "reused" },
};

Deno.test("normalizeEmail lowercases, trims and rejects junk", () => {
  assertEquals(normalizeEmail("  Jane@Example.COM "), "jane@example.com");
  assertEquals(normalizeEmail("nope"), null);
  assertEquals(normalizeEmail(42), null);
});

Deno.test("splitName splits on whitespace and keeps the rest as last name", () => {
  assertEquals(splitName("  Jane  van der Berg "), { firstName: "Jane", lastName: "van der Berg" });
  assertEquals(splitName(""), { firstName: "", lastName: "" });
});

Deno.test("findContactByEmail: oldest active unmerged row wins, case-insensitive", async () => {
  const db = new FakeSupabase({
    contacts: [
      { id: "new", organization_id: ORG, email: "jane@x.com", status: "active", created_at: "2026-02-01" },
      { id: "merged", organization_id: ORG, email: "jane@x.com", status: "active", merged_into_contact_id: "old", created_at: "2025-01-01" },
      { id: "old", organization_id: ORG, email: "jane@x.com", status: "active", created_at: "2026-01-01" },
      { id: "archived", organization_id: ORG, email: "jane@x.com", status: "archived", created_at: "2024-01-01" },
      { id: "mixed", organization_id: ORG, email: "Bob@X.com", status: "active", created_at: "2026-01-01" },
      { id: "other-org", organization_id: "org-2", email: "sam@x.com", status: "active", created_at: "2026-01-01" },
    ],
  });
  assertEquals((await findContactByEmail(db, ORG, "JANE@x.com"))?.id, "old");
  assertEquals((await findContactByEmail(db, ORG, "bob@x.com"))?.id, "mixed");
  assertEquals(await findContactByEmail(db, ORG, "sam@x.com"), null);
  assertEquals(await findContactByEmail(db, ORG, "not-an-email"), null);
});

Deno.test("upsertContactByEmail gap-fills an existing contact and never overwrites", async () => {
  const db = new FakeSupabase({
    contacts: [{ id: "c1", organization_id: ORG, email: "jane@x.com", status: "active", first_name: "Jane", last_name: "", company: "Acme", owner_id: "someone", source: "manual", created_at: "2026-01-01" }],
  });
  const r = await upsertContactByEmail(db, ORG, { email: "jane@x.com", firstName: "Janet", lastName: "Doe", company: "Other Co", jobTitle: "CEO" }, { source: "web_form_x" });
  assertEquals(r, { id: "c1", created: false });
  const row = db.rows("contacts")[0];
  assertEquals(row.first_name, "Jane");      // kept
  assertEquals(row.last_name, "Doe");        // filled
  assertEquals(row.company, "Acme");         // kept
  assertEquals(row.job_title, "CEO");        // filled
  assertEquals(row.owner_id, "someone");     // untouched
  assertEquals(row.source, "manual");        // untouched
});

Deno.test("upsertContactByEmail creates with owner, actor and source set", async () => {
  const db = new FakeSupabase();
  const r = await upsertContactByEmail(db, ORG, { email: "New@X.com", firstName: "New", lastName: "Person" }, { source: "web_form_sr-contact" });
  assert(r.created);
  const row = db.rows("contacts")[0];
  assertEquals(row.email, "new@x.com");
  assertEquals(row.owner_id, LEAD_OWNER_USER_ID);
  assertEquals(row.created_by_user_id, LEAD_ACTOR_USER_ID);
  assertEquals(row.source, "web_form_sr-contact");
  assertEquals(row.status, "active");
});

Deno.test("findOrCreateOpenOpportunity creates in Inbound / New Lead with created_by set", async () => {
  const db = new FakeSupabase();
  const r = await findOrCreateOpenOpportunity(db, ORG, "c1", { source: "web_form_sr-contact", name: "Jane — Contact", description: "Problem: x" }, timeline);
  assert(r.created);
  const opp = db.rows("opportunities")[0];
  assertEquals(opp.pipeline_id, LEAD_PIPELINE_ID);
  assertEquals(opp.stage_id, LEAD_STAGE_ID);
  assertEquals(opp.assigned_user_id, LEAD_OWNER_USER_ID);
  assertEquals(opp.created_by, LEAD_ACTOR_USER_ID);
  assertEquals(opp.status, "open");
  assertEquals(db.rows("opportunity_timeline_events")[0].event_type, "created_from_form");
  assertEquals(db.rows("event_outbox").length, 0); // never emits opportunity_created
});

Deno.test("findOrCreateOpenOpportunity reuses the contact's open Inbound opportunity regardless of source or stage", async () => {
  const db = new FakeSupabase({
    opportunities: [
      { id: "won", org_id: ORG, contact_id: "c1", pipeline_id: LEAD_PIPELINE_ID, status: "won", source: "booking", created_at: "2026-01-01" },
      { id: "open", org_id: ORG, contact_id: "c1", pipeline_id: LEAD_PIPELINE_ID, stage_id: "qualified", status: "open", source: "booking", description: "Booked a call", created_at: "2026-02-01" },
      { id: "other-pipeline", org_id: ORG, contact_id: "c1", pipeline_id: "gov", status: "open", source: "manual", created_at: "2026-03-01" },
    ],
  });
  const r = await findOrCreateOpenOpportunity(db, ORG, "c1", { source: "web_form_sr-contact", name: "n", description: "Problem: y" }, timeline);
  assertEquals(r, { id: "open", created: false });
  const open = db.rows("opportunities").find((o) => o.id === "open")!;
  assertEquals(open.stage_id, "qualified"); // stage untouched
  assert(String(open.description).startsWith("Booked a call"));
  assert(String(open.description).includes("Problem: y"));
  assertEquals(db.rows("opportunity_timeline_events")[0].event_type, "form_resubmitted");
  assertEquals(db.rows("opportunities").length, 3);
});

Deno.test("recordFormSubmission returns duplicate for a seen idempotency key", async () => {
  const db = new FakeSupabase({ form_submissions: [{ id: "s0", idempotency_key: "site:abc", contact_id: "c1", payload: {} }] });
  assertEquals(await recordFormSubmission(db, ORG, { formId: "f", contactId: "c1", payload: {}, idempotencyKey: "site:abc" }), { id: "s0", duplicate: true });
  const r = await recordFormSubmission(db, ORG, { formId: "f", contactId: "c1", payload: { a: 1 }, idempotencyKey: "site:def" });
  assertEquals(r.duplicate, false);
  assertEquals(db.rows("form_submissions").length, 2);
  assertEquals(db.rows("form_submissions")[1].processed_status, "processed");
});

Deno.test("buildFormSubmittedPayload is display-ready and drops empty fields", () => {
  const p = buildFormSubmittedPayload({
    formId: "f", formName: "Contact", formSlug: "sr-contact", submissionId: "s", contactId: "c", opportunityId: "o",
    firstName: " Jane ", lastName: "Doe", email: "jane@x.com", fields: [["Help type", "cmo"], ["Empty", ""], ["Multi", ["a", "b"]], ["Flag", true]],
  });
  assertEquals(p.name, "Jane Doe");
  assertEquals(p.fields, [["Help type", "cmo"], ["Multi", "a, b"], ["Flag", "Yes"]]);
  assertEquals(p.phone, "");
  assertEquals(displayValue({ k: 1 }), '{"k":1}');
});

Deno.test("recordFormSubmission: losing the insert race (stale lookup + unique key) is a duplicate, not an error", async () => {
  const fake = new FakeSupabase({}, { unique: { form_submissions: [["idempotency_key"]] } });
  const first = await recordFormSubmission(fake, ORG, { formId: "f", contactId: "c", payload: {}, idempotencyKey: "site:1" });
  assertEquals(first.duplicate, false);
  // The overlapping request's duplicate check ran before the first insert landed: it sees nothing once.
  let stale = 1;
  const racing = {
    from: (t: string) => {
      const q = fake.from(t);
      if (t !== "form_submissions" || stale === 0) return q;
      return {
        select: () => { stale--; return { eq: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }; },
        insert: (p: Record<string, unknown>) => q.insert(p),
      };
    },
  };
  const loser = await recordFormSubmission(racing, ORG, { formId: "f", contactId: "c", payload: {}, idempotencyKey: "site:1" });
  assertEquals(loser, { id: first.id, duplicate: true });
  assertEquals(fake.rows("form_submissions").length, 1);
});
