import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  assembleDocuments,
  type ContentFetcher,
  ensureDocumentTexts,
  gatherSources,
  listSourceFiles,
  primaryOrigin,
  type PromptDoc,
  renderDocuments,
  sourceVersion,
  summarizeProject,
} from "./proposal-sources.ts";
import { asClient, FakeSupabase } from "./testing/fake-supabase.ts";

const doc = (id: string, origin: PromptDoc["origin"], len: number): PromptDoc => ({ id, name: `${id}.pdf`, origin, text: "x".repeat(len) });

Deno.test("assembleDocuments: government puts solicitation first and applies caps", () => {
  const a = assembleDocuments(
    [doc("contact", "contact", 500), doc("sol1", "solicitation", 5000), doc("upl", "upload", 3000), doc("sol2", "solicitation", 5000)],
    { isGovernment: true, perDocCap: 4000, totalCap: 10_500 },
  );
  assertEquals(a.used.map((d) => d.id), ["sol1", "sol2", "upl"]);
  assertEquals(a.used.map((d) => d.chars), [4000, 4000, 2500]);
  assert(a.used.every((d) => d.truncated));
  // 2,500 left: upload gets truncated to the remainder; contact doc omitted (below useful minimum).
  assertEquals(a.omitted.map((o) => o.id), ["contact"]);
  assertEquals(a.omitted[0].reason, "total context cap reached");
});

Deno.test("assembleDocuments: commercial order, empty text omitted, totals bounded", () => {
  const a = assembleDocuments(
    [doc("sol", "solicitation", 100), doc("opp", "opportunity", 100), { id: "e", name: "empty", origin: "selected", text: "  " }, doc("up", "upload", 100)],
    { isGovernment: false },
  );
  assertEquals(a.used.map((d) => d.id), ["up", "opp", "sol"]);
  assertEquals(a.omitted.map((o) => o.reason), ["no text"]);
  const big = assembleDocuments(Array.from({ length: 10 }, (_, i) => doc(`d${i}`, "opportunity", 200_000)), { isGovernment: false });
  const total = big.used.reduce((n, d) => n + d.chars, 0);
  assert(total <= 600_000, `total ${total} exceeds cap`);
  assert(big.omitted.length > 0);
});

Deno.test("renderDocuments labels solicitation docs as authoritative and lists omissions", () => {
  const a = assembleDocuments([
    { id: "s", name: "RFP.pdf", origin: "solicitation", text: "Section L" },
    { id: "o", name: "notes.docx", origin: "opportunity", text: "Kickoff" },
  ], { isGovernment: true });
  a.omitted.push({ id: "z", name: "scan.pdf", origin: "contact", reason: "no text layer (scanned)" });
  const s = renderDocuments(a, { isGovernment: true });
  assertStringIncludes(s, "SOLICITATION DOCUMENTS");
  assertStringIncludes(s, "--- Document: RFP.pdf (SAM.gov solicitation document) ---\nSection L");
  assertStringIncludes(s, "notes.docx (attached to the opportunity)");
  assertStringIncludes(s, "scan.pdf (no text layer (scanned))");
  assert(s.indexOf("RFP.pdf") < s.indexOf("notes.docx"));
  assertEquals(renderDocuments({ docs: [], used: [], omitted: [] }, { isGovernment: false }), "");
});

Deno.test("primaryOrigin prefers solicitation for gov, explicit picks for commercial", () => {
  assertEquals(primaryOrigin(["contact", "solicitation"], true), "solicitation");
  assertEquals(primaryOrigin(["contact", "selected"], false), "selected");
});

function seed() {
  return new FakeSupabase({
    drive_files: [
      { id: "f-sam", organization_id: "org", name: "RFP.pdf", mime_type: "application/pdf", provider: "sam_gov", storage_path: "org/sam-gov/opp/a/RFP.pdf", drive_file_id: "sam-gov:N:a", user_id: "u1", size_bytes: 10, updated_at: "t1", is_deleted: false },
      { id: "f-drive", organization_id: "org", name: "Brief", mime_type: "application/vnd.google-apps.document", provider: "google", storage_path: null, drive_file_id: "g1", user_id: "u2", size_bytes: 0, updated_at: "t1", is_deleted: false },
      { id: "f-del", organization_id: "org", name: "Old", mime_type: "text/plain", provider: "google", storage_path: null, drive_file_id: "g2", user_id: "u1", size_bytes: 0, updated_at: "t1", is_deleted: true },
      { id: "f-other-org", organization_id: "other", name: "Secret", mime_type: "text/plain", provider: "google", storage_path: null, drive_file_id: "g3", user_id: "x", size_bytes: 0, updated_at: "t1", is_deleted: false },
      { id: "f-proj", organization_id: "org", name: "SOW.txt", mime_type: "text/plain", provider: "microsoft", storage_path: null, drive_file_id: "m1", user_id: "u1", size_bytes: 5, updated_at: "t1", is_deleted: false },
    ],
    file_attachments: [
      { organization_id: "org", drive_file_id: "f-sam", entity_type: "opportunities", entity_id: "opp" },
      { organization_id: "org", drive_file_id: "f-del", entity_type: "opportunities", entity_id: "opp" },
      { organization_id: "org", drive_file_id: "f-drive", entity_type: "contacts", entity_id: "c1" },
    ],
    project_files: [{ org_id: "org", project_id: "p1", drive_file_id: "f-proj" }],
    projects: [
      { id: "p1", org_id: "org", name: "Website rebuild", status: "active", opportunity_id: "opp", proposal_id: null, contact_id: "c1", description: "Rebuild the marketing site", budget_amount: 12000, currency: "USD" },
      { id: "p2", org_id: "org", name: "Unrelated", status: "active", opportunity_id: null, proposal_id: null, contact_id: "c1" },
    ],
    project_tasks: [
      { org_id: "org", project_id: "p1", title: "Design mockups", status: "done", due_date: null, sort_order: 1 },
      { org_id: "org", project_id: "p1", title: "Build CMS", status: "in_progress", due_date: "2026-11-01", sort_order: 2 },
    ],
    project_change_requests: [{ org_id: "org", project_id: "p1", title: "Add blog", status: "approved", request_type: "scope", cost_impact: 1500, timeline_impact_days: 7, description: null, created_at: "2026-10-01" }],
    project_support_tickets: [],
    project_notes: [],
    document_texts: [
      { org_id: "org", drive_file_id: "f-sam", status: "extracted", text_content: "Section L instructions", char_count: 22, page_count: 3, error: null, source_version: "sam:10" },
    ],
  });
}

Deno.test("listSourceFiles scopes to org, drops deleted, honours exclusions and explicit picks", async () => {
  const db = seed();
  const files = await listSourceFiles(asClient(db), {
    orgId: "org", opportunityId: "opp", contactId: "c1", projectIds: ["p1"], selectedFileIds: ["f-other-org"],
  });
  assertEquals(files.map((f) => f.id).sort(), ["f-drive", "f-proj", "f-sam"]);
  assert(files.find((f) => f.id === "f-sam")!.origins.includes("solicitation"));
  const excluded = await listSourceFiles(asClient(db), { orgId: "org", opportunityId: "opp", contactId: "c1", excludeFileIds: ["f-drive"] });
  assertEquals(excluded.map((f) => f.id), ["f-sam"]);
  const none = await listSourceFiles(asClient(db), { orgId: "org", opportunityId: "opp", includeAttached: false, selectedFileIds: ["f-proj"] });
  assertEquals(none.map((f) => f.id), ["f-proj"]);
  const picked = await listSourceFiles(asClient(db), { orgId: "org", opportunityId: "opp", includeAttached: false, selectedFileIds: ["f-sam"] });
  assertEquals(picked.map((f) => f.id), ["f-sam"]);
  assertEquals(picked[0].origins.sort(), ["opportunity", "solicitation"], "explicit picks keep their attachment origin");
});

Deno.test("ensureDocumentTexts fetches + caches missing text, reuses cache, records failures", async () => {
  const db = seed();
  const files = await listSourceFiles(asClient(db), { orgId: "org", opportunityId: "opp", contactId: "c1", projectIds: ["p1"] });
  const calls: string[] = [];
  const fetcher: ContentFetcher = (f) => {
    calls.push(f.id);
    if (f.id === "f-drive") return Promise.resolve({ ok: true, bytes: new TextEncoder().encode("Client brief text"), mime: "text/plain" });
    return Promise.resolve({ ok: false, status: "failed", error: "no connected account can read this file" });
  };
  const texts = await ensureDocumentTexts(asClient(db), "org", files, fetcher);
  assertEquals(calls.sort(), ["f-drive", "f-proj"], "cached SAM text is not refetched");
  assertEquals(texts.get("f-drive")!.text_content, "Client brief text");
  assertEquals(texts.get("f-proj")!.status, "failed");
  const stored = db.rows("document_texts").find((r) => r.drive_file_id === "f-drive")!;
  assertEquals(stored.source_version, sourceVersion(files.find((f) => f.id === "f-drive")!));

  calls.length = 0;
  await ensureDocumentTexts(asClient(db), "org", files, fetcher);
  assertEquals(calls, ["f-proj"], "only the failed one is retried");

  calls.length = 0;
  await ensureDocumentTexts(asClient(db), "org", files, fetcher, { maxFresh: 0 });
  assertEquals(calls, []);
});

Deno.test("summarizeProject is concise and capped", () => {
  const s = summarizeProject(
    { id: "p", name: "Site", description: "d".repeat(300), status: "active", priority: "high", start_date: "2026-01-01", target_end_date: null, actual_end_date: null, budget_amount: 5000, actual_cost: 1000, currency: "USD", progress_percent: 40, risk_level: null },
    Array.from({ length: 40 }, (_, i) => ({ title: `Task ${i}`, status: i < 10 ? "done" : "todo", due_date: null })),
    [], [{ subject: "Login broken", title: null, status: "open", priority: "high", description: "500 on login" }], [],
    1500,
  );
  assertStringIncludes(s, "Project: Site — status active, priority high");
  assertStringIncludes(s, "Tasks: 40 total, 10 done, 30 open");
  assert(s.length <= 1500);
  const capped = summarizeProject({ id: "p", name: "Big", description: "d".repeat(5000), status: null, priority: null, start_date: null, target_end_date: null, actual_end_date: null, budget_amount: null, actual_cost: null, currency: null, progress_percent: null, risk_level: null }, [], [], [], [], 600);
  assert(capped.length <= 600);
  assertStringIncludes(capped, "[project summary truncated]");
});

Deno.test("gatherSources end to end: docs + linked project, contact-only project not auto-included", async () => {
  const db = seed();
  const fetcher: ContentFetcher = (f) =>
    Promise.resolve(f.id === "f-proj"
      ? { ok: true, bytes: new TextEncoder().encode("Statement of work v2"), mime: "text/plain" }
      : { ok: true, bytes: new TextEncoder().encode("Brief"), mime: "text/plain" });
  const g = await gatherSources(asClient(db), {
    orgId: "org", opportunityId: "opp", contactId: "c1", proposalId: "prop", isGovernment: true,
    uploadedDocuments: [{ name: "notes.txt", text: "uploaded notes" }], fetcher,
  });
  assertEquals(g.projects.map((p) => p.name), ["Website rebuild"]);
  assertStringIncludes(g.projectsText, "Change requests (1):");
  assertStringIncludes(g.projectsText, "Add blog (scope) — cost 1500, +7d");
  assertEquals(g.documents[0].name, "RFP.pdf", "solicitation first for government");
  assertEquals(g.documents.map((d) => d.origin), ["solicitation", "upload", "project", "contact"]);
  assertStringIncludes(g.documentsText, "Statement of work v2");
  assertFalse(g.documentsText.includes("Secret"));

  const noProj = await gatherSources(asClient(db), {
    orgId: "org", opportunityId: "opp", contactId: "c1", isGovernment: false, includeLinkedProjects: false,
    includeAttachedDocuments: false, projectIds: ["p2"], fileIds: ["f-sam"], fetcher,
  });
  assertEquals(noProj.projects.map((p) => p.name), ["Unrelated"]);
  assertEquals(noProj.documents.map((d) => d.id), ["f-sam"]);
});
