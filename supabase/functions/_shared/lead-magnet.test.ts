import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase } from "./testing/fake-supabase.ts";
import { attributionFromPath, buildLeadMagnetEmail, parseLeadMagnetEnvelope, processLeadMagnet, type LeadMagnetDeps } from "./lead-magnet.ts";
import { hmacSha256Hex } from "./site-webhook-auth.ts";
import { handle, type IntakeDeps } from "../site-lead-intake/handler.ts";
import type { SendOrgEmailOptions } from "./email-defaults.ts";

import { LEAD_ORG_ID } from "./lead-intake.ts";
const ORG = LEAD_ORG_ID;
const SECRET = "test-secret";
const ID = "6f0d3bb5-77b3-4b3d-9f2d-3ac95778a3f0";
const URL_ = "https://example.com/api/downloads/ai-policy?t=1799999999.abc123";

const envelope = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: "lead_magnet", formName: "lead-magnet", schemaVersion: 1, receivedAt: "2026-11-12T12:00:00.000Z",
  source: { path: "/resources/ai-policy?utm_source=li&utm_campaign=nov&junk=1&ref=jo" },
  contact: { name: "Jane Q Doe", email: "Jane@Example.com", company: "", role: "" },
  consent: { accepted: true, version: "2026-11-01", acceptedAt: "2026-11-12T11:59:00.000Z" },
  answers: [{ questionId: "magnet", label: "Which guide", type: "single", value: "ai-policy", display: "The AI Policy Guide" }],
  delivery: { slug: "ai-policy", title: "The AI Policy Guide", url: URL_, expiresAt: "2026-11-19T12:00:00.000Z" },
  spam: { honeypotEmpty: true, elapsedMs: 9000 },
  ...over,
});

const seed = () => new FakeSupabase({ forms: [{ id: "f-lm", organization_id: ORG, public_slug: "sr-lead-magnet", status: "published" }] });

function harness(opts: { fail?: boolean } = {}) {
  const sent: SendOrgEmailOptions[] = [];
  let fail = !!opts.fail;
  const deps: LeadMagnetDeps = {
    orgId: ORG, actorUserId: "actor",
    unsubscribeLink: () => Promise.resolve({ slug: "s", oneClickUrl: "https://x/unsub/s", pageUrl: "https://os.example/unsubscribe/s" }),
    sendEmail: (_db, _org, o) => { sent.push(o); return Promise.resolve(fail ? { ok: false, status: 503, error: "resend down" } : { ok: true, status: 200, messageId: "re_1" }); },
  };
  return { sent, deps, setFail: (v: boolean) => (fail = v) };
}
const parse = (e: unknown) => { const r = parseLeadMagnetEnvelope(e); assert(r.ok); return r.value; };

Deno.test("parse: accepts the site's shape, rejects off-site links and bad slugs", () => {
  assertEquals(parse(envelope()).contact.email, "jane@example.com");
  for (const bad of [
    envelope({ delivery: { slug: "ai-policy", title: "T", url: "https://evil.example/x", expiresAt: "" } }),
    envelope({ delivery: { slug: "ai-policy", title: "T", url: "http://example.com/x", expiresAt: "" } }),
    envelope({ delivery: { slug: "Bad Slug", title: "T", url: URL_, expiresAt: "" } }),
    envelope({ id: "nope" }),
  ]) assertEquals(parseLeadMagnetEnvelope(bad).ok, false);
});

Deno.test("attribution keeps utm_* and ref only", () => {
  assertEquals(attributionFromPath("/resources/x?utm_source=li&utm_campaign=nov&junk=1&ref=jo"), { utm_source: "li", utm_campaign: "nov", ref: "jo" });
  assertEquals(attributionFromPath("/resources/x"), {});
});

Deno.test("email body: link, 7 days, guide page, signed as Clara (AI), unsubscribe, no hype", () => {
  const m = buildLeadMagnetEmail({ firstName: "Jane", title: "The AI Policy Guide", url: URL_, slug: "ai-policy", unsubscribeUrl: "https://os.example/unsubscribe/s" });
  assertEquals(m.subject, "Your copy of The AI Policy Guide");
  for (const part of ["Hi Jane,", URL_, "7 days", "/resources/ai-policy", "Clara", "AI assistant", "Unsubscribe: https://os.example/unsubscribe/s"]) assertStringIncludes(m.text, part);
  assert(!/<img|\$\d/.test(m.text));
});

Deno.test("process: upserts brand contact, tags, records attribution + consent, sends once from Clara's brand", async () => {
  const db = seed(); const h = harness();
  const out = await processLeadMagnet(db, h.deps, parse(envelope()), null);
  assertEquals(out.email, "sent");
  const [c] = db.rows("contacts"); assertEquals([c.email, c.first_name, c.brand], ["jane@example.com", "Jane", "default"]);
  assertEquals(db.rows("tags").map((t) => t.name).sort(), ["lead-magnet", "lead-magnet:ai-policy"]);
  assertEquals(db.rows("contact_tags").length, 2);
  assertEquals(db.rows("opportunities").length, 0); // not an inquiry
  assertEquals(db.rows("event_outbox").length, 0); // no form_submitted alert
  const sub = db.rows("form_submissions")[0];
  assertEquals((sub.attribution as Record<string, unknown>).utm_source, "li");
  assertEquals((sub.payload as { consent: { version: string } }).consent.version, "2026-11-01");
  const tl = db.rows("contact_timeline")[0].event_data as Record<string, unknown>;
  assertEquals([tl.consent_version, tl.email_status], ["2026-11-01", "sent"]);
  assertEquals(h.sent.length, 1);
  assertEquals([h.sent[0].to, h.sent[0].brand, h.sent[0].replyTo], ["jane@example.com", "default", undefined]);
  assertStringIncludes(h.sent[0].text ?? "", URL_);
  assertEquals(h.sent[0].html, undefined);
});

Deno.test("idempotent on id: a replay sends no second email and adds no rows", async () => {
  const db = seed(); const h = harness();
  const first = await processLeadMagnet(db, h.deps, parse(envelope()), null);
  const again = await processLeadMagnet(db, h.deps, parse(envelope()), null);
  assertEquals(again.duplicate, true); assertEquals(again.ref, first.ref);
  assertEquals(h.sent.length, 1);
  assertEquals(db.rows("form_submissions").length, 1); assertEquals(db.rows("contact_tags").length, 2);
});

Deno.test("email failure: recorded, no throw; a replay retries once and then stops", async () => {
  const db = seed(); const h = harness({ fail: true });
  const out = await processLeadMagnet(db, h.deps, parse(envelope()), null);
  assertEquals(out.email, "failed"); assert(out.ref);
  const res = (db.rows("form_submissions")[0].payload as { _result: { email: { status: string; error: string; attempts: number } } })._result.email;
  assertEquals([res.status, res.attempts], ["failed", 1]); assertStringIncludes(res.error, "resend down");
  assertEquals(db.rows("contact_timeline")[0].event_data && (db.rows("contact_timeline")[0].event_data as Record<string, unknown>).email_status, "failed");
  h.setFail(false);
  const retry = await processLeadMagnet(db, h.deps, parse(envelope()), null);
  assertEquals([retry.duplicate, retry.retried, retry.email], [true, true, "sent"]);
  await processLeadMagnet(db, h.deps, parse(envelope()), null);
  assertEquals(h.sent.length, 2); // failed attempt + one successful retry, nothing after
});

Deno.test("a thrown send is a recorded failure, not an exception", async () => {
  const db = seed(); const h = harness();
  h.deps.sendEmail = () => Promise.reject(new Error("boom"));
  assertEquals((await processLeadMagnet(db, h.deps, parse(envelope()), null)).email, "failed");
});

Deno.test("no consent: contact stored, nothing sent", async () => {
  const db = seed(); const h = harness();
  const out = await processLeadMagnet(db, h.deps, parse(envelope({ consent: { accepted: false, version: "v", acceptedAt: "" } })), null);
  assertEquals(out.email, "skipped"); assertEquals(h.sent.length, 0);
});

Deno.test("falls back to the sr-contact form row until the migration is applied", async () => {
  const db = new FakeSupabase({ forms: [{ id: "f-c", organization_id: ORG, public_slug: "sr-contact", status: "published" }] });
  const out = await processLeadMagnet(db, harness().deps, parse(envelope()), null);
  assertEquals(db.rows("form_submissions")[0].form_id, "f-c"); assert(out.ref);
});

// ── Webhook handler: signature + kind routing ────────────────────────────────
async function post(body: unknown, deps: IntakeDeps, o: { sign?: boolean; secretUsed?: string } = {}) {
  const raw = JSON.stringify(body); const ts = String(Date.now());
  const sig = o.sign === false ? "sha256=" + "0".repeat(64) : "sha256=" + await hmacSha256Hex(o.secretUsed ?? SECRET, `${ts}.${raw}`);
  return handle(new Request("https://f/site-lead-intake", { method: "POST", body: raw, headers: { "x-submission-timestamp": ts, "x-submission-signature": sig } }), deps);
}
const intakeDeps = (db: FakeSupabase, h = harness()): IntakeDeps => ({ getDb: () => db, secret: () => SECRET, sendEmail: h.deps.sendEmail });

Deno.test("handler: bad signature is 401 and does nothing, even for lead_magnet", async () => {
  const db = seed(); const h = harness();
  assertEquals((await post(envelope(), intakeDeps(db, h), { sign: false })).status, 401);
  assertEquals((await post(envelope(), intakeDeps(db, h), { secretUsed: "other" })).status, 401);
  assertEquals(h.sent.length, 0); assertEquals(db.rows("contacts").length, 0);
});

Deno.test("handler: lead_magnet routes to Clara's email, answers 200 with a ref, replay is a duplicate", async () => {
  const db = seed(); const h = harness();
  const res = await post(envelope(), intakeDeps(db, h));
  const body = await res.json();
  assertEquals([res.status, body.ok, body.email], [200, true, "sent"]); assert(body.ref);
  const dup = await (await post(envelope(), intakeDeps(db, h))).json();
  assertEquals([dup.duplicate, dup.ref], [true, body.ref]); assertEquals(h.sent.length, 1);
});

Deno.test("handler: lead_magnet never 4xx/5xx after the signature: bad envelope, email down, DB down", async () => {
  const db = seed();
  const bad = await post(envelope({ delivery: { slug: "x", title: "T", url: "https://evil.example/", expiresAt: "" } }), intakeDeps(db));
  assertEquals(bad.status, 200); assertEquals((await bad.json()).ok, false);
  const down = await post(envelope(), intakeDeps(seed(), harness({ fail: true })));
  assertEquals([down.status, (await down.json()).email], [200, "failed"]);
  const broken = await post(envelope(), { ...intakeDeps(db), getDb: () => { throw new Error("db down"); } });
  assertEquals(broken.status, 200);
});

Deno.test("handler: other kinds keep their behaviour (unknown kind still 400)", async () => {
  const res = await post(envelope({ kind: "newsletter" }), intakeDeps(seed()));
  assertEquals(res.status, 400);
});

Deno.test("lead magnet: two overlapping deliveries of one envelope send one email", async () => {
  const db = new FakeSupabase({ forms: [{ id: "f-lm", organization_id: ORG, public_slug: "sr-lead-magnet", status: "published" }] }, { unique: { form_submissions: [["idempotency_key"]] } });
  const h = harness();
  const [a, b] = await Promise.all([processLeadMagnet(db, h.deps, parse(envelope()), null), processLeadMagnet(db, h.deps, parse(envelope()), null)]);
  assertEquals(h.sent.length, 1);
  assertEquals(db.rows("form_submissions").length, 1);
  assertEquals(a.ref, b.ref);
});

Deno.test("lead magnet: a hung mail provider is a recorded failure after the deadline", async () => {
  const db = seed(); const h = harness();
  h.deps.sendEmail = () => new Promise(() => {}); h.deps.timeoutMs = 20;
  const out = await processLeadMagnet(db, h.deps, parse(envelope()), null);
  assertEquals(out.email, "failed");
});
