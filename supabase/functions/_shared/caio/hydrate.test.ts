import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyNarrative, escapeHtml, hydrate, htmlToText, unresolvedNames, type HydrateInput, type PlaceholderDef, type RecordInput } from "./hydrate.ts";

const fx = JSON.parse(Deno.readTextFileSync(new URL("./testdata/defs.json", import.meta.url))) as { feeds: Record<string, string[]>; defs: PlaceholderDef[] };
const tpl = (n: number) => Deno.readTextFileSync(new URL(`./testdata/t${String(n).padStart(2, "0")}.html`, import.meta.url));

const engagement = { client_legal_name: "Acme Holdings LLC", engagement_code: "ENG-ACME", register_owner: "Pat Owner", executive_sponsor: "Sam Sponsor" };
const base = (html: string, over: Partial<HydrateInput> = {}): HydrateInput => ({
  html, defs: fx.defs, engagement, facts: [], records: [], today: "2026-11-06", docVersion: 1, ...over,
});
const rec = (register_key: string, record_key: string, data: Record<string, unknown>, system_key: string | null = null): RecordInput =>
  ({ id: `id-${record_key}`, register_key, record_key, system_key, data });
const count = (s: string, needle: string) => s.split(needle).length - 1;
const marks = (html: string) => [...html.matchAll(/<mark\b[^>]*data-auto="([^"]*)"/g)].map((m) => m[1]);

// ── (a) every placeholder class ─────────────────────────────────────────────────────────────
Deno.test("each placeholder class resolves from its own source, human and llm never", () => {
  const defs: PlaceholderDef[] = [
    { name: "CLIENT LEGAL NAME", resolver: "engagement", target: "client_legal_name" },
    { name: "DATE", resolver: "computed", target: "today" },
    { name: "VERSION", resolver: "computed", target: "doc_version" },
    { name: "STATUS", resolver: "computed", target: "doc_status" },
    { name: "SYSTEM ID", resolver: "computed", target: "system_key" },
    { name: "INDUSTRY", resolver: "fact", target: "industry" },
    { name: "SYSTEM NAME", resolver: "register", target: "ai_systems.system_name" },
    { name: "APPROVER", resolver: "human", target: "" },
    { name: "NARRATIVE", resolver: "llm", target: "" },
  ];
  const html = [...defs.map((d) => `<p><strong>[${d.name}]</strong></p>`), "<p><b>[CLIENT LEGAL NAME]</b></p>"].join("");
  const r = hydrate(base(html, {
    defs, systemKey: "SYS-0001", docVersion: 3,
    facts: [{ fact_key: "industry", value: "Wealth management", status: "confirmed", source_id: "s1" }],
    records: [rec("ai_systems", "SYS-0001", { system_name: "Intake Copilot" })],
  }));
  const byId = new Map(r.fills.map((f) => [f.markId, f]));
  assertEquals(byId.get("CLIENT LEGAL NAME")?.value, "Acme Holdings LLC");
  assertEquals(byId.get("CLIENT LEGAL NAME#2")?.resolver, "engagement");   // second occurrence, stable by position
  assertEquals(byId.get("DATE")?.value, "2026-11-06");
  assertEquals(byId.get("VERSION")?.value, "3");
  assertEquals(byId.get("STATUS")?.value, "Draft");
  assertEquals(byId.get("SYSTEM ID")?.value, "SYS-0001");
  assertEquals(byId.get("INDUSTRY")?.sourceRef, "fact:industry");
  assertEquals(byId.get("INDUSTRY")?.sourceIds, ["s1"]);
  assertEquals(byId.get("SYSTEM NAME")?.sourceRef, "record:SYS-0001");
  assertStringIncludes(r.html, '<strong>[APPROVER]</strong>');
  assertStringIncludes(r.html, '<strong>[NARRATIVE]</strong>');
  assertEquals(r.llmTargets.map((t) => t.name), ["NARRATIVE"]);
  assertEquals(r.unresolved.map((u) => u.name).sort(), ["APPROVER", "NARRATIVE"]);
  assertEquals(r.fills.some((f) => f.placeholder === "APPROVER" || f.placeholder === "NARRATIVE"), false);
  assertStringIncludes(r.html, 'data-resolver="fact" data-conf="high" data-ref="fact:industry">Wealth management</mark>');
});

Deno.test("a human placeholder is never filled, even when a fact or record has the same name", () => {
  const defs: PlaceholderDef[] = [{ name: "APPROVER", resolver: "human", target: "approver" }, { name: "TRAINER", resolver: "human", target: "training.trainer" }];
  const r = hydrate(base("<p><strong>[APPROVER]</strong> <strong>[TRAINER]</strong></p>", {
    defs, facts: [{ fact_key: "approver", value: "Pat", status: "confirmed" }],
    records: [rec("training", "TRN-1", { trainer: "Lee" })],
  }));
  assertEquals(r.fills.length, 0);
  assertEquals(unresolvedNames(r.html), ["APPROVER", "TRAINER"]);
});

Deno.test("unmapped names stay as they are", () => {
  const r = hydrate(base("<p><strong>[SOMETHING NEW]</strong></p>", { defs: [] }));
  assertEquals(r.html, "<p><strong>[SOMETHING NEW]</strong></p>");
  assertEquals(r.unresolved, [{ name: "SOMETHING NEW", resolver: "unmapped" }]);
});

// ── (b) proposed facts ──────────────────────────────────────────────────────────────────────
Deno.test("a proposed, rejected or stale fact does not fill; confirmed does", () => {
  const defs: PlaceholderDef[] = [{ name: "INDUSTRY", resolver: "fact", target: "industry" }];
  for (const status of ["proposed", "rejected", "stale"]) {
    const r = hydrate(base("<p><strong>[INDUSTRY]</strong></p>", { defs, facts: [{ fact_key: "industry", value: "Banking", status }] }));
    assertEquals(r.fills.length, 0, status);
    assertEquals(r.unresolved.map((u) => u.name), ["INDUSTRY"]);
  }
  const ok = hydrate(base("<p><strong>[INDUSTRY]</strong></p>", { defs, facts: [{ fact_key: "industry", value: "Banking", status: "confirmed" }] }));
  assertEquals(ok.fills.length, 1);
});

Deno.test("unknown stays unknown: empty engagement field and empty record field leave the placeholder", () => {
  const defs: PlaceholderDef[] = [
    { name: "DOCUMENT OWNER", resolver: "engagement", target: "register_owner" },
    { name: "SYSTEM NAME", resolver: "register", target: "ai_systems.system_name" },
  ];
  const r = hydrate(base("<p><strong>[DOCUMENT OWNER]</strong><strong>[SYSTEM NAME]</strong></p>", {
    defs, engagement: { ...engagement, register_owner: "  " }, records: [rec("ai_systems", "SYS-1", { system_name: "" })],
  }));
  assertEquals(r.fills.length, 0);
});

// ── (f) escaping ────────────────────────────────────────────────────────────────────────────
Deno.test("every inserted value is HTML-escaped", () => {
  const defs: PlaceholderDef[] = [
    { name: "CLIENT LEGAL NAME", resolver: "engagement", target: "client_legal_name" },
    { name: "INDUSTRY", resolver: "fact", target: "industry" },
    { name: "SYSTEM NAME", resolver: "register", target: "ai_systems.system_name" },
  ];
  const evil = `<script>alert("x")</script> & 'q'`;
  const r = hydrate(base("<p><strong>[CLIENT LEGAL NAME]</strong><strong>[INDUSTRY]</strong><strong>[SYSTEM NAME]</strong></p>", {
    defs, engagement: { ...engagement, client_legal_name: evil },
    facts: [{ fact_key: "industry", value: "<img src=x onerror=1>", status: "confirmed" }],
    records: [rec("ai_systems", "SYS-1", { system_name: evil })],
  }));
  assertEquals(r.html.includes("<script"), false);
  assertEquals(r.html.includes("<img"), false);
  assertStringIncludes(r.html, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
  assertEquals(escapeHtml("<script>"), "&lt;script&gt;");
  assertEquals(marks(r.html).length, 3);
});

Deno.test("secret-like and prompt-like values are not inserted", () => {
  const defs: PlaceholderDef[] = [{ name: "SYSTEM NAME", resolver: "register", target: "ai_systems.system_name,ai_systems.business_purpose" }];
  const r = hydrate(base("<p><strong>[SYSTEM NAME]</strong></p>", { defs, records: [rec("ai_systems", "S1", { system_name: "password: hunter2hunter2hunter2", business_purpose: "[SOMETHING]" })] }));
  assertEquals(r.fills.length, 0);
});

// ── text outside placeholders is untouched ──────────────────────────────────────────────────
Deno.test("only placeholders change: everything else in the template is byte-identical", () => {
  for (const n of [9, 10, 11, 17, 29]) {
    const html = tpl(n);
    const r = hydrate(base(html, { feeds: fx.feeds[n], facts: [{ fact_key: "industry", value: "Banking", status: "confirmed" }] }));
    const strip = (s: string) => s.replace(/<mark\b[^>]*>[\s\S]*?<\/mark>/g, "§").replace(/<(strong|b)>\s*\[[^\]]+\]\s*<\/\1>/g, "§");
    assertEquals(strip(r.html), strip(html), `template ${n}`);
    assert(r.fills.length >= 4, `template ${n} header fills`);   // client, engagement, owner, version, status, date
  }
});

// ── (c) row / form-table expansion on the real templates ────────────────────────────────────
const tools = (k: number) => Array.from({ length: k }, (_, i) => rec("approved_tools", `TOL-000${i + 1}`, {
  tool_id: `TOL-000${i + 1}`, tool_and_account_tier: `Tool ${i + 1} Team`, permitted_data: `Public ${i + 1}`, prohibited_data: "Client NPI", company_account_owner: `Owner ${i + 1}`,
}));

Deno.test("template 10: approved-tool entry table repeats per record (0, 1, 3)", () => {
  const html = tpl(10);
  const zero = hydrate(base(html, { feeds: fx.feeds[10] }));
  assertEquals(count(zero.html, "data-rec="), 0);
  assertEquals(unresolvedNames(zero.html).includes("TOOL ID"), true);   // zero records leave placeholders
  assertEquals(count(zero.html, "<table"), count(html, "<table"));      // no table deleted or added

  const one = hydrate(base(html, { feeds: fx.feeds[10], records: tools(1) }));
  assertEquals(count(one.html, '<table data-rec="approved_tools/'), 1);
  assertStringIncludes(one.html, "Tool 1 Team");
  assertEquals(unresolvedNames(one.html).includes("TOOL ID"), false);

  const three = hydrate(base(html, { feeds: fx.feeds[10], records: tools(3) }));
  assertEquals(count(three.html, '<table data-rec="approved_tools/'), 3);
  assertEquals(count(three.html, "<table"), count(html, "<table") + 2);
  for (const i of [1, 2, 3]) assertStringIncludes(three.html, `Tool ${i} Team`);
  // the second table's TOOL ID mark is NAME#2: ids are stable by position
  assert(marks(three.html).includes("TOOL ID#2") && marks(three.html).includes("TOOL ID#3"));
  assertEquals(new Set(marks(three.html)).size, marks(three.html).length);
});

Deno.test("template 11: system description table follows system_key; risk rows repeat per risk of that system", () => {
  const html = tpl(11);
  const risks = (sys: string, n: number) => Array.from({ length: n }, (_, i) => rec("risks", `RSK-${sys}-${i}`, { risk_id: `RSK-${sys}-${i}`, failure_scenario: `Scenario ${sys} ${i}` }, sys));
  const systems = [rec("ai_systems", "SYS-0001", { system_name: "Intake Copilot", business_purpose: "Triage" }), rec("ai_systems", "SYS-0002", { system_name: "Other Bot" })];
  const zero = hydrate(base(html, { feeds: fx.feeds[11], systemKey: "SYS-0001" }));
  assertEquals(count(zero.html, "data-rec="), 0);

  const r = hydrate(base(html, { feeds: fx.feeds[11], systemKey: "SYS-0001", records: [...systems, ...risks("SYS-0001", 3), ...risks("SYS-0002", 2)] }));
  assertStringIncludes(r.html, "Intake Copilot");
  assertEquals(r.html.includes("Other Bot"), false);              // another system's record never leaks in
  assertEquals(count(r.html, "Scenario SYS-0001"), 3);
  assertEquals(r.html.includes("Scenario SYS-0002"), false);
  // each risk table in the template (scenarios, controls, treatment) repeats once per risk of this system
  const perRisk = count(zero.html, "<tr") === 0 ? 0 : count(r.html, 'data-rec="risks/RSK-SYS-0001-0"');
  assert(perRisk >= 1);
  assertEquals(count(r.html, 'data-rec="risks/RSK-SYS-0001-1"'), perRisk);
  assertEquals(count(r.html, 'data-rec="risks/RSK-SYS-0001-2"'), perRisk);
  assertEquals(count(r.html, 'data-rec="risks/RSK-SYS-0002'), 0);
  assertEquals(count(r.html, 'data-rec="ai_systems/'), 1);
  assertStringIncludes(r.html, 'data-resolver="computed" data-conf="high" data-ref="computed:system_key">SYS-0001');

  const one = hydrate(base(html, { feeds: fx.feeds[11], systemKey: "SYS-0001", records: [...systems, ...risks("SYS-0001", 1)] }));
  assert(count(one.html, 'data-rec="risks/RSK-SYS-0001-0"') >= 1);
  assertEquals(count(one.html, 'data-rec="risks/RSK-SYS-0001-1"'), 0);

  // without a system key every ai_systems record gets its own description table
  const all = hydrate(base(html, { feeds: fx.feeds[11], records: systems }));
  assertEquals(count(all.html, '<table data-rec="ai_systems/'), 2);
});

Deno.test("template 17: training rows repeat per record (0, 1, 3)", () => {
  const html = tpl(17);
  const rows = (k: number) => Array.from({ length: k }, (_, i) => rec("training", `TRN-000${i + 1}`, {
    training_record_id: `TRN-000${i + 1}`, person: `Person ${i + 1}`, role_or_team: "Ops", session_or_module: "Safe use", trainer: "Trainer T",
  }));
  assertEquals(count(hydrate(base(html, { feeds: fx.feeds[17] })).html, "data-rec="), 0);
  const one = hydrate(base(html, { feeds: fx.feeds[17], records: rows(1) }));
  assertStringIncludes(one.html, "Person 1");
  const three = hydrate(base(html, { feeds: fx.feeds[17], records: rows(3) }));
  for (const i of [1, 2, 3]) assertStringIncludes(three.html, `Person ${i}`);
  assert(count(three.html, "data-rec=") >= 3);
  // a row of the attendance table is repeated, not edited: its label cells are unchanged
  assertEquals(count(three.html, "Role or team"), count(html, "Role or team"));
});

Deno.test("a register placeholder outside an expanded row fills only when exactly one record is in scope", () => {
  const defs: PlaceholderDef[] = [{ name: "SYSTEM NAME", resolver: "register", target: "ai_systems.system_name" }];
  const html = "<p><strong>[SYSTEM NAME]</strong></p>";
  assertEquals(hydrate(base(html, { defs, records: [rec("ai_systems", "A", { system_name: "One" })] })).fills.length, 1);
  assertEquals(hydrate(base(html, { defs, records: [rec("ai_systems", "A", { system_name: "One" }), rec("ai_systems", "B", { system_name: "Two" })] })).fills.length, 0);
});

// ── (d) merge on regenerate ─────────────────────────────────────────────────────────────────
Deno.test("regenerate keeps confirmed and edited text, refreshes unconfirmed marks, fills what is new", () => {
  const defs: PlaceholderDef[] = [
    { name: "CLIENT LEGAL NAME", resolver: "engagement", target: "client_legal_name" },
    { name: "INDUSTRY", resolver: "fact", target: "industry" },
    { name: "TRADING NAME", resolver: "fact", target: "trading_name" },
    { name: "STAFF COUNT", resolver: "fact", target: "staff_count" },
    { name: "APPROVER", resolver: "human", target: "" },
  ];
  const html = "<p>Client: <strong>[CLIENT LEGAL NAME]</strong></p><p>Industry: <strong>[INDUSTRY]</strong></p><p>Trading: <strong>[TRADING NAME]</strong></p><p>Staff: <strong>[STAFF COUNT]</strong></p><p>Approver: <strong>[APPROVER]</strong></p>";
  const facts1 = [{ fact_key: "industry", value: "Banking", status: "confirmed" }, { fact_key: "trading_name", value: "Acme", status: "confirmed" }];
  const first = hydrate(base(html, { defs, facts: facts1 }));
  assertEquals(first.fills.length, 3);

  // owner: confirmed the client name (mark removed), edited industry by hand, left TRADING NAME as a mark, typed an approver
  let draft = first.html;
  draft = draft.replace(/<mark data-auto="CLIENT LEGAL NAME"[^>]*>(.*?)<\/mark>/, "$1");
  draft = draft.replace(/<mark data-auto="INDUSTRY"[^>]*>.*?<\/mark>/, "Retail banking and lending (owner wording)");
  draft = draft.replace("<strong>[APPROVER]</strong>", "Jo Approver");
  const fields = [
    { mark_id: "CLIENT LEGAL NAME", status: "confirmed" as const }, { mark_id: "INDUSTRY", status: "edited" as const }, { mark_id: "TRADING NAME", status: "auto" as const },
  ];
  // sources change: trading name was corrected, a staff count was confirmed, the engagement name was renamed
  const second = hydrate(base(draft, {
    defs, existingFields: fields, engagement: { ...engagement, client_legal_name: "Acme Renamed LLC" },
    facts: [{ fact_key: "industry", value: "Changed elsewhere", status: "confirmed" }, { fact_key: "trading_name", value: "Acme Corp", status: "confirmed" }, { fact_key: "staff_count", value: "42", status: "confirmed" }],
  }));
  assertStringIncludes(second.html, "Client: Acme Holdings LLC</p>");                  // confirmed text kept (not renamed)
  assertStringIncludes(second.html, "Retail banking and lending (owner wording)");     // edited text kept
  assertEquals(second.html.includes("Changed elsewhere"), false);
  assertStringIncludes(second.html, "Jo Approver");
  assertStringIncludes(second.html, ">Acme Corp</mark>");                              // unconfirmed mark refreshed
  assertEquals(second.html.includes(">Acme</mark>"), false);
  assertStringIncludes(second.html, ">42</mark>");                                     // new fill
  assertEquals(second.fills.map((f) => f.markId).sort(), ["STAFF COUNT", "TRADING NAME"]);

  // a fact that is no longer confirmed returns its unconfirmed mark to the placeholder
  const third = hydrate(base(second.html, { defs, existingFields: [...fields, { mark_id: "STAFF COUNT", status: "auto" as const }], facts: [{ fact_key: "staff_count", value: "42", status: "rejected" }] }));
  assertStringIncludes(third.html, "<strong>[STAFF COUNT]</strong>");
});

Deno.test("regenerate does not expand an already-expanded row again and fills newly resolvable cells of a bound row", () => {
  const html = tpl(10);
  const t1 = tools(2);
  const first = hydrate(base(html, { feeds: fx.feeds[10], records: t1 }));
  const fields = first.fills.map((f) => ({ mark_id: f.markId, status: "auto" as const }));
  // a field that was empty is now filled on the first record
  const grown = t1.map((r, i) => i === 0 ? { ...r, data: { ...r.data, retention_and_deletion: "30 days" } } : r);
  const again = hydrate(base(first.html, { feeds: fx.feeds[10], records: grown, existingFields: fields }));
  assertEquals(count(again.html, "data-rec="), count(first.html, "data-rec="));
  assertStringIncludes(again.html, "30 days");
});

Deno.test("applyNarrative marks the first occurrence only and keeps the others open", () => {
  const defs: PlaceholderDef[] = [{ name: "ACCESS MODEL", resolver: "llm", target: "" }];
  const r = hydrate(base("<h2>Access</h2><table><tbody><tr><td>Model</td><td><strong>[ACCESS MODEL]</strong></td></tr></tbody></table><p><strong>[ACCESS MODEL]</strong></p>", { defs }));
  assertEquals(r.llmTargets.length, 1);
  assertEquals(r.llmTargets[0].hint.includes("label: Model"), true);
  const a = applyNarrative(r.html, r.llmTargets, [{ name: "ACCESS MODEL", text: "Role based <b>", confidence: "medium", sourceIds: ["src-1"] }]);
  assertEquals(count(a.html, "<mark"), 1);
  assertStringIncludes(a.html, 'data-resolver="llm" data-conf="medium" data-ref="source:src-1">Role based &lt;b&gt;</mark>');
  assertEquals(unresolvedNames(a.html), ["ACCESS MODEL"]);
  assertEquals(htmlToText(a.html).includes("Role based"), true);
});
