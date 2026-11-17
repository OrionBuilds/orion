import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import {
  type FridayTurnDeps, type ThreadInfo, SHARED_READ_TOOLS, answerAck, classifyFridayMessage, fridayTools, handleFridayTurn, workAck, workTitle,
} from "./friday-thread.ts";
import { NOT_ALLOWED_REPLY, canUseClara, sweepTurns } from "./agent-thread.ts";
import { OWNER_TOOLS } from "./owner-tools.ts";

// ── classifier ──────────────────────────────────────────────────────────────────────────────

Deno.test("classifier: only unmistakable work orders are work", () => {
  const work: [string, string][] = [
    ["Fix the login 500 on Umbrella Roofing", "bug"],
    ["please deploy the Initech site to staging", "code"],
    ["FRIDAY, merge PR #7 on umbrellaroofing-fl", "code"],
    ["Can you fix the contact form on That Roof Dude?", "bug"],
    ["could you please run QA on the new booking flow", "qa"],
    ["Investigate why the sitemap is empty", "research"],
    ["go ahead and add a pricing page to Initech Box", "code"],
    ["Set up uptime monitoring for gearworks", "code"],
  ];
  for (const [t, kind] of work) assertEquals(classifyFridayMessage(t), { intent: "work", kind: kind as never }, t);
  const questions = [
    "what projects are you connected to?",
    "What's stuck?",
    "is the Umbrella Roofing deploy done",
    "how many PRs are open",
    "any failed runs today?",
    "status on initech",
    "check whether the site is up",
    "Can you tell me what's left on Gearworks?",
    "did you fix the login bug?",
    "the login page is broken",          // a report, not an order: answered, with an offer to queue
    "Umbrella Roofing",                            // ambiguous
    "thanks!",
    "",
  ];
  for (const t of questions) assertEquals(classifyFridayMessage(t).intent, "question", t);
});

Deno.test("work titles drop the politeness and keep it short", () => {
  assertEquals(workTitle("please fix the login 500 on Umbrella Roofing\nmore detail"), "Fix the login 500 on Umbrella Roofing");
  assertEquals(workTitle("Can you deploy staging?"), "Deploy staging?");
  assertEquals(workTitle("x".repeat(300)).length, 120);
});

// ── turns ───────────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-28T23:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const turn = (id: string, o: Record<string, unknown> = {}) => ({
  message_id: id, org_id: "o", channel_id: "ch-f", agent_user_id: "friday", sender_id: "jordan", mode: "friday",
  status: "sent", attempts: 0, agent_request_id: null, created_at: ago(1000), updated_at: ago(1000), ...o,
});
const msg = (id: string, content: string, sender = "jordan", at = ago(1000)) => ({ id, channel_id: "ch-f", organization_id: "o", sender_id: sender, content, created_at: at });

function deps(o: Partial<FridayTurnDeps> = {}): FridayTurnDeps & { asked: string[]; infos: ThreadInfo[] } {
  const asked: string[] = [], infos: ThreadInfo[] = [];
  return {
    asked, infos, now: () => NOW,
    canInstruct: o.canInstruct ?? (() => Promise.resolve(true)),
    answer: o.answer ?? ((t, text) => { asked.push(text); infos.push(t); return Promise.resolve({ reply: "You have 18 active projects.", failed: false }); }),
  };
}
const fridayReplies = (f: FakeSupabase) => f.rows("team_messages").filter((m) => m.sender_id === "friday");

Deno.test("a question is answered in the OS as FRIDAY (with thread history), once, and nothing is queued", async () => {
  const f = new FakeSupabase({
    agent_thread_turns: [turn("m2")],
    team_messages: [msg("m0", "hi", "jordan", ago(5000)), msg("m1", "Hello.", "friday", ago(4000)), msg("m2", "what projects are you connected to?")],
  });
  const d = deps();
  const [a, b] = await Promise.all([handleFridayTurn(asClient(f), d, "m2"), handleFridayTurn(asClient(f), d, "m2")]);
  assertEquals([a, b].sort(), ["answered", "skipped"]);
  assertEquals(d.asked, ["what projects are you connected to?"]);
  assertEquals(d.infos[0].history.map((h) => `${h.role}:${h.text}`), ["owner:hi", "agent:Hello."]);
  assertEquals(f.rows("agent_requests").length, 0);
  const r = fridayReplies(f).filter((m) => m.reply_to_id === "m2");
  assertEquals([r.length, r[0].content], [1, "You have 18 active projects."]);
  const t = f.rows("agent_thread_turns")[0];
  assertEquals([t.status, t.reply_message_id], ["answered", r[0].id]);
});

Deno.test("a clear work order becomes ONE agent_request to FRIDAY with payload.history; the turn tracks it", async () => {
  const f = new FakeSupabase({
    agent_thread_turns: [turn("m2")],
    team_messages: [msg("m1", "the login page 500s on Umbrella Roofing", "jordan", ago(5000)), msg("m2", "Fix the login 500 on Umbrella Roofing")],
  });
  const d = deps();
  assertEquals(await handleFridayTurn(asClient(f), d, "m2"), "queued");
  assertEquals(d.asked.length, 0); // no model call for a clear order
  const req = f.rows("agent_requests")[0];
  assertEquals([req.from_user_id, req.to_user_id, req.kind, req.title, req.body], ["jordan", "friday", "bug", "Fix the login 500 on Umbrella Roofing", "Fix the login 500 on Umbrella Roofing"]);
  const src = req.source as Record<string, unknown>;
  assertEquals([src.channel, src.channel_id, src.message_id, src.requested_by], ["agent_thread", "ch-f", "m2", "owner"]);
  assertEquals(((req.payload as Record<string, unknown>).history as { role: string; text: string }[]).map((h) => h.text), ["the login page 500s on Umbrella Roofing"]);
  const t = f.rows("agent_thread_turns")[0];
  assertEquals([t.status, t.agent_request_id], ["queued", req.id]);
  assertEquals(fridayReplies(f)[0].content, workAck("Fix the login 500 on Umbrella Roofing"));
});

Deno.test("the owner's reply to FRIDAY's open question becomes a NEW request (in_reply_to) and the old one is closed", async () => {
  const f = new FakeSupabase({
    agent_requests: [{
      id: "r1", org_id: "o", from_user_id: "jordan", to_user_id: "friday", kind: "code", title: "Add pricing page", body: "Add a pricing page",
      status: "needs_input", result_summary: "Which plans should it list?", source: { channel: "agent_thread", channel_id: "ch-f", message_id: "m1" }, payload: {},
    }],
    agent_thread_turns: [turn("m1", { status: "needs_input", agent_request_id: "r1", created_at: ago(9000) }), turn("m3")],
    team_messages: [msg("m1", "Add a pricing page", "jordan", ago(9000)), msg("m2", "Which plans should it list?", "friday", ago(8000)), msg("m3", "Starter and Pro")],
  });
  const d = deps();
  assertEquals(await handleFridayTurn(asClient(f), d, "m3"), "queued");
  assertEquals(d.asked.length, 0);
  const old = f.rows("agent_requests").find((r) => r.id === "r1")!;
  const fresh = f.rows("agent_requests").find((r) => r.id !== "r1")!;
  assertEquals(old.status, "cancelled");
  assertEquals((old.result as Record<string, unknown>).superseded_by, fresh.id);
  assertEquals([fresh.title, (fresh.payload as Record<string, unknown>).in_reply_to, fresh.to_user_id], ["Re: Add pricing page", "r1", "friday"]);
  assertEquals(String(fresh.body).includes("Starter and Pro") && String(fresh.body).includes("Which plans"), true);
  const t3 = f.rows("agent_thread_turns").find((t) => t.message_id === "m3")!;
  assertEquals([t3.status, t3.agent_request_id], ["queued", fresh.id]);
  assertEquals(fridayReplies(f).at(-1)!.content, answerAck("Add pricing page"));
});

Deno.test("only the owner or a SuperAdmin reaches FRIDAY: anyone else gets a visible refusal and nothing runs", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1", { sender_id: "afzal" })], team_messages: [msg("m1", "deploy prod", "afzal")] });
  const d = deps({ canInstruct: () => Promise.resolve(false) });
  assertEquals(await handleFridayTurn(asClient(f), d, "m1"), "failed");
  assertEquals([d.asked.length, f.rows("agent_requests").length], [0, 0]);
  assertEquals(fridayReplies(f)[0].content, NOT_ALLOWED_REPLY);
});

Deno.test("queue_work during an answer (owner said yes to the offer) leaves the turn tracking that request", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1")], team_messages: [msg("m1", "yes, do it")] });
  const d = deps({
    answer: async (t) => {
      const tool = fridayTools(t).find((x) => x.name === "queue_work")!;
      // deno-lint-ignore no-explicit-any
      const ctx = { db: asClient(f), orgId: "o", now: () => NOW } as any;
      const r = await tool.run(ctx, { title: "Add pricing page", details: "Starter + Pro tiers", kind: "code" });
      return { reply: r.line, failed: false };
    },
  });
  assertEquals(await handleFridayTurn(asClient(f), d, "m1"), "queued");
  const req = f.rows("agent_requests")[0];
  assertEquals([req.title, req.to_user_id], ["Add pricing page", "friday"]);
  const t = f.rows("agent_thread_turns")[0];
  assertEquals([t.status, t.agent_request_id, Boolean(t.reply_message_id)], ["queued", req.id, true]);
});

Deno.test("the sweep retries a FRIDAY turn whose dispatch never arrived, through the FRIDAY handler", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1", { created_at: ago(60_000) })], team_messages: [msg("m1", "what's stuck?")] });
  const ran: string[] = [];
  const r = await sweepTurns(asClient(f), {
    now: () => NOW, canUseClara: () => Promise.resolve(true), run: () => Promise.resolve({ reply: "", failed: false }),
    runFridayTurn: (id) => { ran.push(id); return Promise.resolve("answered"); },
  });
  assertEquals([r.retried, ran], [1, ["m1"]]);
});

Deno.test("FRIDAY's toolset: Clara's read tools by name, FRIDAY's own reads, one write (queue_work); every read is owner-only", () => {
  const tools = fridayTools({ messageId: "m", channelId: "c", orgId: "o", agentUserId: "f", ownerUserId: "s", history: [] });
  for (const n of SHARED_READ_TOOLS) assertEquals(OWNER_TOOLS.some((t) => t.name === n), true, n);
  assertEquals(tools.map((t) => t.name).sort(), [...SHARED_READ_TOOLS, "code_runs", "pull_requests", "client_reviews", "stuck_work", "queue_work"].sort());
  assertEquals(tools.filter((t) => !t.readOnly).map((t) => t.name), ["queue_work"]);
  assertEquals(tools.every((t) => t.ownerOnly), true);
});

// ── owner gate (mirrors is_org_owner_or_superadmin) ─────────────────────────────────────────

Deno.test("owner gate: the DB gate decides; OWNER_USER_ID pins the owner; before the migration only SuperAdmin passes", async () => {
  const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
  const withRpc = new FakeSupabase({}, { rpc: { is_org_owner_or_superadmin: (a) => a.p_user === "jordan" } });
  assertEquals(await canUseClara(asClient(withRpc), "jordan", env({})), true);
  assertEquals(await canUseClara(asClient(withRpc), "afzal", env({})), false);
  assertEquals(await canUseClara(asClient(withRpc), "afzal", env({ OWNER_USER_ID: "afzal" })), true);
  // No RPC yet (migration not applied): fall back to the SuperAdmin role.
  const legacy = new FakeSupabase({
    users: [{ id: "admin", role_id: "r-sa" }, { id: "afzal", role_id: "r-admin" }],
    roles: [{ id: "r-sa", name: "SuperAdmin" }, { id: "r-admin", name: "Admin" }],
  });
  assertEquals(await canUseClara(asClient(legacy), "admin", env({})), true);
  assertEquals(await canUseClara(asClient(legacy), "afzal", env({})), false);
});
