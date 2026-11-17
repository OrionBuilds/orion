import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { OWNER_TOOLS, type OwnerCtx } from "./owner-tools.ts";
import { pickStage } from "./factory-tools.ts";

const tool = (n: string) => OWNER_TOOLS.find((t) => t.name === n)!;
const NOW = new Date("2026-11-04T15:00:00Z");
const STAGES = [
  { id: "s0", pipeline_id: "pin", name: "New Lead", sort_order: 0 }, { id: "s3", pipeline_id: "pin", name: "Qualified", sort_order: 3 },
  { id: "s5", pipeline_id: "pin", name: "Discovery Completed", sort_order: 5 }, { id: "s6", pipeline_id: "pin", name: "Discovery / Demo Scheduled", sort_order: 4 },
  { id: "s10", pipeline_id: "pin", name: "Closed Won", sort_order: 10 }, { id: "s11", pipeline_id: "pin", name: "Closed Lost", sort_order: 11 },
];

function setup() {
  const f = new FakeSupabase({
    contacts: [{ id: "c1", organization_id: "o", status: "active", first_name: "Pat", last_name: "Lee", email: "pat@acme.com", company: "Acme", brand: "default" }],
    pipelines: [{ id: "pin", org_id: "o", name: "Inbound" }, { id: "pgov", org_id: "o", name: "Government" }],
    pipeline_stages: STAGES,
    project_pipelines: [{ id: "eng", org_id: "o", name: "Engineering" }, { id: "caio", org_id: "o", name: "CAIO Engagements" }],
    opportunities: [{ id: "d1", org_id: "o", name: "Acme - AI intake", pipeline_id: "pin", stage_id: "s0", status: "open", contact_id: "c1", brand: "default" }],
  }, { rpc: { find_contact_id_by_phone: () => null } });
  const c: OwnerCtx = {
    db: asClient(f), env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+1",
    channel: "chat", ownerVerified: true, now: () => NOW,
    sendSms: () => Promise.resolve(true), sendEmail: () => Promise.resolve(), createEvent: () => Promise.resolve({ id: "e" }),
  };
  return { f, c };
}

Deno.test("pickStage: exact, then prefix, then contains; ambiguous returns the candidates", () => {
  assertEquals((pickStage(STAGES, "qualified") as { id: string }).id, "s3");
  assertEquals((pickStage(STAGES, "closed won") as { id: string }).id, "s10");
  assertEquals(Array.isArray(pickStage(STAGES, "discovery")), true);
  assertEquals(pickStage(STAGES, "nonsense"), null);
});

Deno.test("move_deal moves the stage; a lost stage closes it with the reason", async () => {
  const { f, c } = setup();
  const r = await tool("move_deal").run(c, { deal: "Acme", stage: "qualified" });
  assertEquals(r.ok, true);
  assertEquals(f.rows("opportunities")[0].stage_id, "s3");
  await tool("move_deal").run(c, { deal: "Acme", stage: "closed lost", lost_reason: "went with in-house" });
  const o = f.rows("opportunities")[0];
  assertEquals([o.stage_id, o.status, o.lost_reason], ["s11", "lost", "went with in-house"]);
});

Deno.test("move_deal asks when the stage is ambiguous", async () => {
  const { c } = setup();
  const r = await tool("move_deal").run(c, { deal: "Acme", stage: "discovery" });
  assertEquals([r.ok, r.clarify], [false, true]);
});

Deno.test("create_deal opens the deal in the first stage with the CAIO delivery pipeline when asked", async () => {
  const { f, c } = setup();
  const r = await tool("create_deal").run(c, { contact: "Pat Lee", pipeline: "inbound", delivery: "caio", value: 12000 });
  assertEquals(r.ok, true);
  const d = f.rows("opportunities")[1];
  assertEquals([d.stage_id, d.project_pipeline_id, d.value_amount, d.status], ["s0", "caio", 12000, "open"]);
});

Deno.test("factory tools are owner-only", () => {
  for (const n of ["create_deal", "move_deal", "move_project", "start_playbook", "factory_status"]) assertEquals(tool(n).ownerOnly, true);
});

Deno.test("caio_status is a read-only owner tool and answers from the CAIO tables", async () => {
  const t = OWNER_TOOLS.find((x) => x.name === "caio_status")!;
  assertEquals([t.readOnly, t.ownerOnly], [true, true]);
  const { c } = setup();
  const none = await t.run(c, {});
  assertEquals(none.line, "There are no active CAIO engagements yet.");
});
