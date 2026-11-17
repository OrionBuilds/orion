import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { caioStatus, isClosed, summarize } from "./status.ts";

const NOW = new Date("2026-11-04T15:00:00Z");
function db() {
  return new FakeSupabase({
    caio_engagements: [
      { id: "e1", org_id: "o", engagement_code: "CAIO-2026-01", client_legal_name: "Acme Roofing LLC", project_id: "p1", status: "active", portal_enabled: false, kickoff_date: "2026-10-05" },
      { id: "e2", org_id: "o", engagement_code: "CAIO-2026-02", client_legal_name: "Zed Clinics", project_id: "p2", status: "active", portal_enabled: true, kickoff_date: "2026-09-01" },
      { id: "e3", org_id: "other", engagement_code: "CAIO-2026-01", client_legal_name: "Not ours", project_id: "p3", status: "active", portal_enabled: false, kickoff_date: "2026-09-01" },
    ],
    caio_registers: [{ register_key: "actions", title: "Actions" }, { register_key: "exceptions", title: "Exceptions" }, { register_key: "incidents", title: "Incidents" }, { register_key: "risks", title: "Risks" }],
    caio_gate_defs: [{ gate_key: "day_30", label: "Day 30", sort: 1, required_templates: [1, 2, 3] }],
    caio_gates: [{ engagement_id: "e1", gate_key: "day_30", due_date: "2026-11-09", status: "open", conditions: [{ text: "Sponsor approves the charter", met: true }, { text: "Business owner confirms the baseline", met: false }] }],
    caio_records: [
      { engagement_id: "e1", register_key: "actions", record_key: "ACT-0001", status: "Open", due_date: "2026-11-01" },
      { engagement_id: "e1", register_key: "actions", record_key: "ACT-0002", status: "Done", due_date: "2026-10-01" },
      { engagement_id: "e1", register_key: "exceptions", record_key: "EXC-0001", status: "Approved", due_date: "2026-10-30" },
      { engagement_id: "e1", register_key: "exceptions", record_key: "EXC-0002", status: "Requested", due_date: "2026-11-20" },
      { engagement_id: "e1", register_key: "incidents", record_key: "INC-0001", status: "Open", due_date: null },
      { engagement_id: "e1", register_key: "risks", record_key: "RSK-0001", status: "Open", due_date: "2026-11-02" },
    ],
    caio_documents: [
      { engagement_id: "e1", template_number: 1, status: "approved", next_review: "2026-10-30", title: "Charter" },
      { engagement_id: "e1", template_number: 9, status: "draft", next_review: null, title: "AI Use Policy" },
    ],
  });
}

Deno.test("status counts overdue, expiring, expired-but-approved, open incidents and overdue reviews, and ignores closed items", async () => {
  const [s] = await caioStatus(asClient(db()), "o", { client: "acme", now: NOW });
  assertEquals([s.overdue_actions, s.exceptions_expiring_30d, s.exceptions_expired, s.open_incidents, s.reviews_overdue], [1, 1, 1, 1, 1]);
  assertEquals(s.documents, { draft: 1, in_review: 0, approved: 1, review_overdue: 1 });
  assertEquals(s.counts.actions, 2);
});

Deno.test("next gate reports days left, unmet conditions and required documents still missing", async () => {
  const [s] = await caioStatus(asClient(db()), "o", { client: "CAIO-2026-01", now: NOW });
  assertEquals([s.next_gate?.label, s.next_gate?.days, s.next_gate?.met, s.next_gate?.total], ["Day 30", 5, 1, 2]);
  assertEquals(s.next_gate?.unmet, ["Business owner confirms the baseline"]);
  assertEquals(s.next_gate?.templates_missing, [2, 3]);
  assertEquals(s.attention.some((a) => a.includes("Day 30 gate is due 2026-11-09: 1/2 conditions met, 2 required document(s)")), true);
});

Deno.test("only this organization's engagements, and a client filter narrows them", async () => {
  const all = await caioStatus(asClient(db()), "o", { now: NOW });
  assertEquals(all.map((x) => x.code).sort(), ["CAIO-2026-01", "CAIO-2026-02"]);
  assertEquals((await caioStatus(asClient(db()), "o", { client: "nobody", now: NOW })).length, 0);
  assertEquals(all.find((x) => x.code === "CAIO-2026-02")?.next_gate, null);
});

Deno.test("closed-status vocabulary and the one-line summary", () => {
  assertEquals(["Closed", "done", "Not applicable", "Retired"].every(isClosed), true);
  assertEquals(["Open", "Approved", null].some((v) => isClosed(v as string)), false);
});
