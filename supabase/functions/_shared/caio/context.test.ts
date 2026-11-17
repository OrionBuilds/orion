import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { generate, modelCallsThisMonth, notifyDraftsReady, periodFor, runJob, type GenerateDeps, type Job } from "./context.ts";

const NOW = new Date("2026-11-06T10:00:00Z");
const TPL = `<h2>Overview</h2><p>Client <strong>[CLIENT LEGAL NAME]</strong></p><p>Industry <strong>[INDUSTRY]</strong></p><p>Access <strong>[ACCESS MODEL]</strong></p><p>Approver <strong>[APPROVER]</strong></p>`;

const seed = (over: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  caio_templates: [
    { id: "t1", org_id: "o1", number: 3, title: "Policy", feeds: [], body_html: TPL, enabled: true },
    { id: "t29", org_id: "o1", number: 29, title: "Weekly Client Progress Memo", feeds: [], body_html: TPL, enabled: true },
  ],
  caio_engagements: [{ id: "e1", org_id: "o1", client_legal_name: "Acme LLC", engagement_code: "ENG-1", register_owner: "Pat", executive_sponsor: "Sam", automation_enabled: true, ai_monthly_cap: 5 }],
  caio_placeholder_defs: [
    { name: "CLIENT LEGAL NAME", resolver: "engagement", target: "client_legal_name" },
    { name: "INDUSTRY", resolver: "fact", target: "industry" },
    { name: "ACCESS MODEL", resolver: "llm", target: "" },
    { name: "APPROVER", resolver: "human", target: "industry" },
  ],
  caio_facts: [{ id: "f1", engagement_id: "e1", fact_key: "industry", value: "Banking", status: "confirmed", updated_at: "2026-11-01T00:00:00Z" }],
  caio_fact_defs: [{ fact_key: "industry", label: "Industry", templates: [3] }],
  caio_sources: [{ id: "11111111-1111-1111-1111-111111111111", engagement_id: "e1", process_status: "ready", title: "Interview", text_content: "Access model: single sign-on for all advisors.", created_at: "2026-11-02T00:00:00Z" }],
  ...over,
}, { unique: { caio_document_fields: [["document_id", "mark_id"]], caio_input_requests: [["engagement_id", "kind", "key"]] } });

const deps = (db: FakeSupabase, ask: GenerateDeps["ask"] = null): GenerateDeps => ({ db: asClient(db), ask, now: () => NOW });
const P = { orgId: "o1", engagementId: "e1", templateNumber: 3 };
const SRC = "11111111-1111-1111-1111-111111111111";
const model = (text = "Single sign-on for all advisors.") => () => Promise.resolve({ values: { "ACCESS MODEL": { text, confidence: "medium", source_ids: [SRC] } } });

Deno.test("generate: new draft with provenance rows, narrative marks and a Needs-input list", async () => {
  const db = seed();
  const r = await generate(deps(db, model()), P);
  assert(r.ok);
  assertEquals(r.created, true);
  assertEquals(r.model_calls, 1);
  assertEquals(r.filled, 3);
  assertEquals(r.unresolved, [{ name: "APPROVER", resolver: "human" }]);
  const doc = db.rows("caio_documents")[0];
  assertEquals([doc.status, doc.version, doc.title], ["draft", 1, "Policy"]);
  assertStringIncludes(String(doc.body_html), 'data-resolver="llm"');
  assertStringIncludes(String(doc.body_html), "<strong>[APPROVER]</strong>");
  assert(typeof (doc.generated_from as { hash: string }).hash === "string");
  const fields = db.rows("caio_document_fields");
  assertEquals(fields.map((f) => `${f.mark_id}:${f.resolver}:${f.status}`).sort(), ["ACCESS MODEL:llm:auto", "CLIENT LEGAL NAME:engagement:auto", "INDUSTRY:fact:auto"]);
  assertEquals(fields.find((f) => f.mark_id === "ACCESS MODEL")?.source_ref, `source:${SRC}`);
});

Deno.test("generate: a bad model reply leaves the placeholder; no model key means no narrative", async () => {
  const db = seed();
  const r = await generate(deps(db, model("Costs $9,999 per month.")), P);
  assert(r.ok);
  assert(r.unresolved.some((u) => u.name === "ACCESS MODEL"));
  const db2 = seed();
  const r2 = await generate(deps(db2, null), P);
  assert(r2.ok && r2.model_calls === 0);
  assertEquals(db2.rows("caio_document_fields").length, 2);
});

Deno.test("generate: regenerate merges: confirmed and edited text stay, unconfirmed marks refresh", async () => {
  const db = seed();
  const first = await generate(deps(db, model()), P);
  assert(first.ok);
  const doc = db.rows("caio_documents")[0];
  // the owner confirms the client name, edits the industry and types an approver
  let body = String(doc.body_html);
  body = body.replace(/<mark data-auto="CLIENT LEGAL NAME"[^>]*>(.*?)<\/mark>/, "$1")
    .replace(/<mark data-auto="INDUSTRY"[^>]*>.*?<\/mark>/, "Owner-written industry").replace("<strong>[APPROVER]</strong>", "Jo");
  doc.body_html = body;
  for (const f of db.rows("caio_document_fields")) {
    if (f.mark_id === "CLIENT LEGAL NAME") f.status = "confirmed";
    if (f.mark_id === "INDUSTRY") f.status = "edited";
  }
  db.rows("caio_engagements")[0].client_legal_name = "Renamed LLC";
  db.rows("caio_facts")[0].value = "Changed";

  const again = await generate(deps(db, model("Federated login for advisors.")), P);   // llm marks are kept unless asked to redraft
  assert(again.ok);
  assertEquals(again.created, false);
  assertEquals(db.rows("caio_documents").length, 1);
  const out = String(db.rows("caio_documents")[0].body_html);
  assertStringIncludes(out, "Client Acme LLC</p>");
  assertStringIncludes(out, "Owner-written industry");
  assertStringIncludes(out, "Approver Jo");
  assertStringIncludes(out, "Single sign-on for all advisors.");
  assertEquals(out.includes("Renamed"), false);
  assertEquals(out.includes("Changed"), false);
  assertEquals(again.model_calls, 0);
});

Deno.test("generate: an approved document is refused, never edited", async () => {
  const db = seed({ caio_documents: [{ id: "d1", engagement_id: "e1", template_number: 3, system_key: null, version: 2, status: "approved", body_html: "<p>Approved text</p>" }] });
  const r = await generate(deps(db, model()), P);
  assertEquals(r, { ok: false, error: "approved_use_revise" });
  assertEquals(db.rows("caio_documents")[0].body_html, "<p>Approved text</p>");
  assertEquals(db.rows("caio_document_fields").length, 0);
  const byId = await generate(deps(db, model()), { ...P, documentId: "d1" });
  assertEquals(byId, { ok: false, error: "approved_use_revise" });
  const inReview = seed({ caio_documents: [{ id: "d2", engagement_id: "e1", template_number: 3, system_key: null, version: 1, status: "in_review", body_html: "<p>x</p>" }] });
  assertEquals((await generate(deps(inReview), P)), { ok: false, error: "document_in_review" });
});

Deno.test("generate: unknown template or another org's engagement is refused", async () => {
  const db = seed();
  assertEquals(await generate(deps(db), { ...P, templateNumber: 99 }), { ok: false, error: "template_not_found" });
  assertEquals(await generate(deps(db), { ...P, orgId: "other" }), { ok: false, error: "template_not_found" });
});

Deno.test("recurring templates always create a new titled draft; period comes from the job reason", async () => {
  const db = seed();
  const a = await generate(deps(db), { ...P, templateNumber: 29, reason: "period:2026-W45" });
  const b = await generate(deps(db), { ...P, templateNumber: 29, reason: "period:2026-W46" });
  const c = await generate(deps(db), { ...P, templateNumber: 29 });
  assert(a.ok && b.ok && c.ok && a.created && b.created && c.created);
  assertEquals(db.rows("caio_documents").map((d) => d.title), ["Weekly Client Progress Memo - 2026-W45", "Weekly Client Progress Memo - 2026-W46", "Weekly Client Progress Memo - 2026-11-06"]);
  assertEquals(periodFor("period:2026-Q4 extra", NOW), "2026-Q4");
  assertEquals(periodFor("manual", NOW), "2026-11-06");
});

// ── jobs ────────────────────────────────────────────────────────────────────────────────────
const job = (over: Partial<Job> = {}): Job => ({ id: "j1", org_id: "o1", engagement_id: "e1", template_number: 3, system_key: null, trigger_kind: "schedule", reason: null, attempts: 1, ...over });
const jobs = (db: FakeSupabase) => db.rows("caio_generation_jobs")[0];

Deno.test("runJob: done records document_id, filled, unresolved, created", async () => {
  const db = seed({ caio_generation_jobs: [{ id: "j1", engagement_id: "e1", status: "running" }] });
  const o = await runJob(deps(db, model()), job());
  assertEquals([o.status, o.produced, o.modelCalls], ["done", true, 1]);
  const j = jobs(db);
  assertEquals(j.status, "done");
  const res = j.result as Record<string, unknown>;
  assertEquals([res.filled, res.created, res.unresolved], [3, true, ["APPROVER"]]);
  assertEquals(j.document_id, db.rows("caio_documents")[0].id);
});

Deno.test("runJob: kill-switch-like skips: automation off, approved document, over the monthly cap", async () => {
  const off = seed({ caio_generation_jobs: [{ id: "j1", status: "running" }] });
  off.rows("caio_engagements")[0].automation_enabled = false;
  assertEquals((await runJob(deps(off, model()), job())).reason, "automation_off");
  assertEquals((jobs(off).result as Record<string, unknown>).reason, "automation_off");
  assertEquals(off.rows("caio_documents").length, 0);
  assertEquals((await runJob(deps(off, model()), job({ trigger_kind: "manual", id: "j1" }))).status, "done");   // a manual job ignores the switch

  const appr = seed({ caio_generation_jobs: [{ id: "j1", status: "running" }], caio_documents: [{ id: "d1", engagement_id: "e1", template_number: 3, system_key: null, version: 1, status: "approved", body_html: "x" }] });
  const o = await runJob(deps(appr, model()), job());
  assertEquals([o.status, jobs(appr).status, (jobs(appr).result as Record<string, unknown>).reason], ["skipped", "skipped", "approved_use_revise"]);

  const cap = seed({
    caio_generation_jobs: [{ id: "j1", status: "running" }, { id: "j0", engagement_id: "e1", status: "done", finished_at: "2026-11-02T00:00:00Z", result: { model_calls: 5 } }, { id: "jold", engagement_id: "e1", status: "done", finished_at: "2026-10-30T00:00:00Z", result: { model_calls: 50 } }],
  });
  assertEquals(await modelCallsThisMonth(asClient(cap), "e1", NOW), 5);
  const c = await runJob(deps(cap, model()), job());
  assertEquals([c.status, cap.rows("caio_generation_jobs")[0].status, cap.rows("caio_generation_jobs")[0].last_error], ["blocked", "blocked", "over_monthly_cap"]);
  assertEquals(cap.rows("caio_documents").length, 0);
});

Deno.test("runJob: failures requeue with back-off, then fail after three attempts", async () => {
  const db = seed({ caio_generation_jobs: [{ id: "j1", status: "running" }] });
  // the engagement lookup itself fails: simulate by a client whose generate step throws
  const failing = { ...deps(db), db: new Proxy(asClient(db), { get: (t, p) => p === "from" ? (tbl: string) => tbl === "caio_templates" ? { select: () => { throw new Error("boom ".repeat(80)); } } : t.from(tbl) : t[p] }) } as GenerateDeps;
  const q = await runJob(failing, job({ attempts: 1 }));
  assertEquals(q.status, "queued");
  assertEquals(jobs(db).status, "queued");
  assert(String(jobs(db).last_error).length <= 200);
  assertEquals(new Date(String(jobs(db).run_after)).getTime(), NOW.getTime() + 5 * 60_000);
  const f = await runJob(failing, job({ attempts: 3 }));
  assertEquals([f.status, jobs(db).status], ["failed", "failed"]);
});

// ── owner notice ────────────────────────────────────────────────────────────────────────────
Deno.test("notifyDraftsReady: counts today's drafts, owner-only text, dedupe key per engagement per UTC day", async () => {
  const db = seed({ caio_documents: [
    { id: "a", engagement_id: "e1", status: "draft", generated_at: "2026-11-06T08:00:00Z" },
    { id: "b", engagement_id: "e1", status: "draft", generated_at: "2026-11-06T09:00:00Z" },
    { id: "c", engagement_id: "e1", status: "draft", generated_at: "2026-11-05T09:00:00Z" },
    { id: "d", engagement_id: "e1", status: "approved", generated_at: "2026-11-06T09:00:00Z" },
  ] });
  const sent: unknown[] = [];
  const n = await notifyDraftsReady(asClient(db), (r) => { sent.push(r); return Promise.resolve("queued"); }, { engagementId: "e1", clientName: "Acme LLC", now: NOW });
  assertEquals(n, 2);
  assertEquals(sent, [{ kind: "caio.drafts_ready", priority: "normal", dedupeKey: "caio-drafts:e1:2026-11-06", text: "2 CAIO drafts are ready to review for Acme LLC" }]);
  const none = await notifyDraftsReady(asClient(seed()), (r) => { sent.push(r); return Promise.resolve("queued"); }, { engagementId: "e1", clientName: "Acme LLC", now: NOW });
  assertEquals([none, sent.length], [0, 1]);
});
