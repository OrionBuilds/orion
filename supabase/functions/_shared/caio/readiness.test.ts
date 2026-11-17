import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { computeNeeds, syncInputRequests } from "./readiness.ts";

const defs = [
  { name: "INDUSTRY", resolver: "fact" as const, target: "industry" },
  { name: "TOOL ID", resolver: "register" as const, target: "approved_tools.tool_id,vendors.vendor_id" },
  { name: "ACCESS MODEL", resolver: "llm" as const, target: "" },
  { name: "APPROVER", resolver: "human" as const, target: "" },
];
const common = {
  defs, feeds: ["approved_tools"], templateNumber: 10, facts: [{ fact_key: "industry", status: "proposed" }], registersWithRecords: new Set<string>(),
  factDefs: [{ fact_key: "industry", label: "Industry", templates: [10] }, { fact_key: "staff_count", label: "Staff", templates: [10] }],
  registerTitles: { approved_tools: "Approved Tools" },
};

Deno.test("needs: unconfirmed facts and empty registers only; human is never a request; llm asks for the template's facts", () => {
  const needs = computeNeeds({ ...common, unresolved: [{ name: "INDUSTRY", resolver: "fact" }, { name: "TOOL ID", resolver: "register" }, { name: "APPROVER", resolver: "human" }, { name: "ACCESS MODEL", resolver: "llm" }] });
  const keys = needs.map((n) => `${n.kind}:${n.key}`).sort();
  assertEquals(keys, ["fact:industry", "fact:staff_count", "register:approved_tools"]);
  assertEquals(needs.find((n) => n.key === "approved_tools")?.label, "Approved Tools");
  assertEquals(computeNeeds({ ...common, unresolved: [{ name: "APPROVER", resolver: "human" }] }), []);
});

Deno.test("syncInputRequests creates, merges blocks_templates, keeps dismissed, resolves satisfied", async () => {
  const db = new FakeSupabase({
    caio_input_requests: [
      { id: "r1", engagement_id: "e1", kind: "fact", key: "industry", label: "Industry", why: "", blocks_templates: [5], status: "open" },
      { id: "r2", engagement_id: "e1", kind: "fact", key: "staff_count", label: "Staff", why: "", blocks_templates: [], status: "dismissed" },
      { id: "r3", engagement_id: "e1", kind: "fact", key: "locations", label: "Locations", why: "", blocks_templates: [10], status: "open" },
      { id: "r4", engagement_id: "e1", kind: "register", key: "vendors", label: "Vendors", why: "", blocks_templates: [10], status: "open" },
    ],
  }, { unique: { caio_input_requests: [["engagement_id", "kind", "key"]] } });
  await syncInputRequests(asClient(db), {
    orgId: "o1", engagementId: "e1", templateNumber: 10, templateTitle: "Approved Tools",
    templateTitles: { 5: "Baseline", 10: "Approved Tools" },
    needs: [
      { kind: "fact", key: "industry", label: "Industry", placeholders: ["INDUSTRY"] },
      { kind: "fact", key: "staff_count", label: "Staff", placeholders: ["x"] },
      { kind: "register", key: "approved_tools", label: "Approved Tools", placeholders: ["TOOL ID"] },
    ],
    facts: [{ fact_key: "locations", status: "confirmed" }], registersWithRecords: new Set(["vendors"]),
  });
  const rows = db.rows("caio_input_requests");
  const get = (k: string) => rows.find((r) => r.key === k)!;
  assertEquals(get("industry").blocks_templates, [5, 10]);
  assertEquals(get("industry").why, "needed by 05 Baseline, 10 Approved Tools");
  assertEquals(get("staff_count").status, "dismissed");
  assertEquals(get("approved_tools").status, "open");
  assertEquals(get("locations").status, "resolved");      // fact now confirmed
  assertEquals(get("vendors").status, "resolved");        // register now has records
});
