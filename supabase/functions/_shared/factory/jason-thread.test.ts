import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { NOT_ALLOWED_REPLY } from "../clara/agent-thread.ts";
import type { OwnerCtx } from "../clara/owner-tools.ts";
import { JASON_PLAYBOOKS, type JasonTurnDeps, handleJasonTurn, jasonSystemPrompt, jasonTools } from "./jason-thread.ts";

const NOW = new Date("2026-11-04T15:00:00Z");
function rig(sender = "owner") {
  const f = new FakeSupabase({
    agent_thread_turns: [{ message_id: "m1", org_id: "o", channel_id: "ch", agent_user_id: "jason-u", sender_id: sender, mode: "jason", status: "sent" }],
    team_messages: [{ id: "m1", channel_id: "ch", sender_id: sender, content: "draft a LinkedIn post about our CAIO assessments", created_at: "2026-11-04T14:59:00Z" }],
  });
  const answers: string[] = [];
  const d: JasonTurnDeps = {
    now: () => NOW, canInstruct: (u) => Promise.resolve(u === "owner"),
    answer: (_t, text) => { answers.push(text); return Promise.resolve({ reply: "Here's a draft…", failed: false }); },
  };
  return { f, d, answers };
}

Deno.test("Jason answers the owner in his thread once (the turn is claimed)", async () => {
  const { f, d, answers } = rig();
  assertEquals(await handleJasonTurn(asClient(f), d, "m1"), "answered");
  assertEquals(await handleJasonTurn(asClient(f), d, "m1"), "skipped");
  assertEquals(answers.length, 1);
  const reply = f.rows("team_messages").find((m) => m.sender_id === "jason-u")!;
  assertEquals([reply.content, (reply.metadata as { source: string }).source], ["Here's a draft…", "agent"]);
  assertEquals(f.rows("agent_thread_turns")[0].status, "answered");
});

Deno.test("Jason refuses anyone but the owner", async () => {
  const { f, d, answers } = rig("intern");
  assertEquals(await handleJasonTurn(asClient(f), d, "m1"), "failed");
  assertEquals(answers.length, 0);
  assertEquals(f.rows("team_messages").find((m) => m.sender_id === "jason-u")!.content, NOT_ALLOWED_REPLY);
});

Deno.test("Jason's tools: his own plus the shared read tools; nothing that sends", () => {
  const names = jasonTools().map((t) => t.name).sort();
  assertEquals(names, ["client_overview", "factory_status", "find", "my_drafts", "project_work", "run_playbook", "save_draft", "use_role"]);
  assertEquals(jasonSystemPrompt({ get: () => undefined }, NOW).includes("never publish"), true);
});

Deno.test("save_draft files an approval card as Jason (doc card, never a send)", async () => {
  const f = new FakeSupabase({});
  const c = { db: asClient(f), env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: null, claraNumber: "", channel: "chat", ownerVerified: true, now: () => NOW } as unknown as OwnerCtx;
  const r = await jasonTools().find((t) => t.name === "save_draft")!.run(c, { title: "CAIO post", body: "Most SMBs…", brand: "default", channel: "linkedin" });
  assertEquals(r.ok, true);
  const card = f.rows("workflow_approval_queue")[0] as Record<string, any>;
  assertEquals([card.agent_slug, card.action_type, String(card.external_ref).startsWith("factory-doc:")], ["jason", "factory_post_draft", true]);
});

Deno.test("run_playbook only runs Jason's own plays", async () => {
  const f = new FakeSupabase({ playbooks: [{ id: "pb1", org_id: "o", slug: "finance-weekly", name: "Weekly finance", enabled: true }] }, { rpc: { factory_start: () => "run1" } });
  const c = { db: asClient(f), orgId: "o", now: () => NOW } as unknown as OwnerCtx;
  const r = await jasonTools().find((t) => t.name === "run_playbook")!.run(c, { playbook: "finance-weekly" });
  assertEquals([r.ok, r.clarify], [false, true]);
  assertEquals(JASON_PLAYBOOKS.every((s) => s.startsWith("marketing-")), true);
});
