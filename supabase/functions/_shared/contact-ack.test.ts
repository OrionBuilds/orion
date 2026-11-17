import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase } from "./testing/fake-supabase.ts";
import { LEAD_ORG_ID } from "./lead-intake.ts";
import { hmacSha256Hex } from "./site-webhook-auth.ts";
import { buildContactAckEmail, helpTypeOf } from "./contact-ack.ts";
import { handle, type IntakeDeps } from "../site-lead-intake/handler.ts";
import type { SendOrgEmailOptions } from "./email-defaults.ts";

const SECRET = "test-secret";
const ID = "7a0d3bb5-77b3-4b3d-9f2d-3ac95778a3f1";

const contactEnv = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: "contact", formName: "contact", schemaVersion: 1, receivedAt: "2026-11-13T12:00:00.000Z",
  source: { path: "/contact" },
  contact: { name: "Jane Q Doe", email: "Jane@Example.com", company: "Acme", role: "Founder" },
  consent: { accepted: true, version: "2026-11-01", acceptedAt: "2026-11-13T11:59:00.000Z" },
  answers: [
    { questionId: "help_type", label: "What do you need help with?", type: "single", value: "cmo", display: "Fractional CMO" },
    { questionId: "problem", label: "The problem", type: "text", value: "Leads dry up", display: "Leads dry up" },
  ],
  spam: { honeypotEmpty: true, elapsedMs: 42000 },
  ...over,
});
const assessmentEnv = () => contactEnv({ id: "8b0d3bb5-77b3-4b3d-9f2d-3ac95778a3f2", kind: "assessment", formName: "assessment-security" });

const seed = () => new FakeSupabase({
  forms: ["sr-contact", "sr-assessment-security"].map((s) => ({ id: `f-${s}`, name: s, organization_id: LEAD_ORG_ID, public_slug: s, status: "published" })),
});

function harness(o: { fail?: "result" | "throw" } = {}) {
  const sent: SendOrgEmailOptions[] = [];
  const deps = (db: FakeSupabase): IntakeDeps => ({
    getDb: () => db, secret: () => SECRET,
    sendEmail: (_d, _o, m) => {
      sent.push(m);
      if (o.fail === "throw") return Promise.reject(new Error("boom"));
      return Promise.resolve(o.fail === "result" ? { ok: false, status: 503, error: "resend down" } : { ok: true, status: 200, messageId: "re_1" });
    },
  });
  return { sent, deps };
}

async function post(body: unknown, deps: IntakeDeps) {
  const raw = JSON.stringify(body); const ts = String(Date.now());
  const sig = "sha256=" + await hmacSha256Hex(SECRET, `${ts}.${raw}`);
  return handle(new Request("https://f/site-lead-intake", { method: "POST", body: raw, headers: { "x-submission-timestamp": ts, "x-submission-signature": sig } }), deps);
}

Deno.test("email body: thanks, received, recap, Clara (AI), unsubscribe; no timeframe, no link", () => {
  const m = buildContactAckEmail({ firstName: "Jane", helpType: "Fractional CMO", unsubscribeUrl: "https://os.example/unsubscribe/s" });
  assertEquals(m.subject, "We got your message");
  for (const part of ["Hi Jane,", "Thanks for getting in touch", "help with: Fractional CMO.", "Clara", "AI assistant", "Unsubscribe: https://os.example/unsubscribe/s"]) assertStringIncludes(m.text, part);
  assert(!/business day|hours|within|https?:\/\/(?!os\.example)/i.test(m.text));
  assert(!buildContactAckEmail({ firstName: "", helpType: "", unsubscribeUrl: null }).text.includes("help with"));
  assertStringIncludes(buildContactAckEmail({ firstName: "", helpType: "", unsubscribeUrl: null }).text, "Hi there,");
});

Deno.test("helpTypeOf reads the help_type display, empty when absent", () => {
  assertEquals(helpTypeOf({ answers: contactEnv().answers as never }), "Fractional CMO");
  assertEquals(helpTypeOf({ answers: [] }), "");
});

Deno.test("contact submission: Clara acknowledges once, brand sender, no default reply-to, result stored", async () => {
  const db = seed(); const h = harness();
  const res = await post(contactEnv(), h.deps(db));
  const body = await res.json();
  assertEquals([res.status, body.ok, body.ack_email], [200, true, "sent"]);
  assertEquals(h.sent.length, 1);
  assertEquals([h.sent[0].to, h.sent[0].brand, h.sent[0].replyTo, h.sent[0].html], ["jane@example.com", "default", undefined, undefined]);
  assertStringIncludes(h.sent[0].text ?? "", "Fractional CMO");
  const stored = (db.rows("form_submissions")[0].payload as { _result: { ack_email: { status: string }; opportunity_id: string } })._result;
  assertEquals(stored.ack_email.status, "sent"); assert(stored.opportunity_id); // the original result fields survive
  assertEquals(db.rows("event_outbox").length, 1); // the staff notification still goes out
});

Deno.test("replayed contact submission: no second email, no new rows", async () => {
  const db = seed(); const h = harness();
  const first = await (await post(contactEnv(), h.deps(db))).json();
  const again = await (await post(contactEnv(), h.deps(db))).json();
  assertEquals([again.duplicate, again.ref], [true, first.ref]);
  assertEquals(h.sent.length, 1);
  assertEquals(db.rows("form_submissions").length, 1);
});

Deno.test("email failure (error result or thrown) never fails the submission", async () => {
  for (const fail of ["result", "throw"] as const) {
    const db = seed(); const h = harness({ fail });
    const res = await post(contactEnv(), h.deps(db));
    const body = await res.json();
    assertEquals([res.status, body.ok, body.ack_email], [200, true, "failed"]);
    assert(body.ref); assertEquals(db.rows("contacts").length, 1); assertEquals(db.rows("opportunities").length, 1);
    assertEquals(db.rows("event_outbox").length, 1);
    const st = (db.rows("form_submissions")[0].payload as { _result: { ack_email: { status: string; error: string } } })._result.ack_email;
    assertEquals(st.status, "failed"); assert(st.error.length > 0);
  }
});

Deno.test("assessments are not acknowledged by this path", async () => {
  const db = seed(); const h = harness();
  const body = await (await post(assessmentEnv(), h.deps(db))).json();
  assertEquals(body.ok, true); assertEquals(body.ack_email, undefined); assertEquals(h.sent.length, 0);
});

Deno.test("bad signature: 401, nothing sent or stored", async () => {
  const db = seed(); const h = harness();
  const raw = JSON.stringify(contactEnv());
  const res = await handle(new Request("https://f/x", { method: "POST", body: raw, headers: { "x-submission-timestamp": String(Date.now()), "x-submission-signature": "sha256=" + "0".repeat(64) } }), h.deps(db));
  assertEquals(res.status, 401); assertEquals(h.sent.length, 0); assertEquals(db.rows("contacts").length, 0);
});

Deno.test("a hung mail provider cannot hold the webhook: deadline, then ok with the ack marked failed", async () => {
  const db = seed(); let calls = 0;
  const deps: IntakeDeps = { getDb: () => db, secret: () => SECRET, sendTimeoutMs: 30, sendEmail: () => { calls++; return new Promise(() => {}); } };
  const t0 = Date.now();
  const res = await post(contactEnv(), deps);
  const body = await res.json();
  assert(Date.now() - t0 < 1000);
  assertEquals([res.status, body.ok, body.ack_email, calls], [200, true, "failed", 1]);
  assertEquals(db.rows("event_outbox").length, 1); // staff notification not held up
  const st = (db.rows("form_submissions")[0].payload as { _result: { ack_email: { error: string } } })._result.ack_email;
  assertStringIncludes(st.error, "after 30 ms");
});

Deno.test("two overlapping deliveries of one envelope: one email (unique key claims the send)", async () => {
  const db = new FakeSupabase({
    forms: [{ id: "f-sr-contact", name: "sr-contact", organization_id: LEAD_ORG_ID, public_slug: "sr-contact", status: "published" }],
  }, { unique: { form_submissions: [["idempotency_key"]] } });
  const h = harness();
  const [a, b] = await Promise.all([post(contactEnv(), h.deps(db)), post(contactEnv(), h.deps(db))]);
  const [ja, jb] = [await a.json(), await b.json()];
  assertEquals([a.status, b.status, ja.ok, jb.ok], [200, 200, true, true]);
  assertEquals(h.sent.length, 1);
  assertEquals(db.rows("form_submissions").length, 1);
  assertEquals(ja.ref, jb.ref);
});

Deno.test("the staff notification and timeline are written before the acknowledgement is sent", async () => {
  const db = seed(); const seenAtSend: number[] = [];
  const deps: IntakeDeps = {
    getDb: () => db, secret: () => SECRET,
    sendEmail: () => { seenAtSend.push(db.rows("event_outbox").length, db.rows("contact_timeline").length); return Promise.resolve({ ok: true, status: 200, messageId: "re_1" }); },
  };
  assertEquals((await post(contactEnv(), deps)).status, 200);
  assertEquals(seenAtSend, [1, 1]);
});
