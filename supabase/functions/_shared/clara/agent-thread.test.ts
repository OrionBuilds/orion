import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import {
  type ClaraTurnDeps, GIVE_UP_SENT_AFTER_MS, HUNG_AFTER_MS, HUNG_REPLY, MISSED_REPLY, NOT_ALLOWED_REPLY,
  canUseClara, claraThreadChannel, handleClaraTurn, mirrorToClaraThread, shouldMirrorOwnerText, sweepTurns, warnThreadStale,
} from "./agent-thread.ts";
import { ownerTurn } from "./owner-turn.ts";
import { processRequestResults } from "./request-results.ts";
import type { OwnerCtx } from "./owner-tools.ts";

const NOW = new Date("2026-10-28T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const turn = (id: string, o: Record<string, unknown> = {}) => ({
  message_id: id, org_id: "o", channel_id: "ch-clara", agent_user_id: "clara", sender_id: "jordan", mode: "clara",
  status: "sent", attempts: 0, created_at: ago(1000), updated_at: ago(1000), stale_warned_at: null, ...o,
});
const msg = (id: string, content = "what's on today?", sender = "jordan") => ({ id, channel_id: "ch-clara", organization_id: "o", sender_id: sender, content });

function deps(o: Partial<ClaraTurnDeps> & { calls?: string[] } = {}): ClaraTurnDeps & { calls: string[] } {
  const calls = o.calls ?? [];
  return {
    calls,
    now: () => NOW,
    canUseClara: o.canUseClara ?? (() => Promise.resolve(true)),
    run: o.run ?? ((_org, text) => { calls.push(text); return Promise.resolve({ reply: "Two meetings.", failed: false }); }),
  };
}
const replies = (f: FakeSupabase) => f.rows("team_messages").filter((m) => m.sender_id === "clara");

Deno.test("an owner message gets exactly one Clara reply, posted as Clara in reply to it, however often it is delivered", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1")], team_messages: [msg("m1")] });
  const d = deps();
  const [a, b] = await Promise.all([handleClaraTurn(asClient(f), d, "m1"), handleClaraTurn(asClient(f), d, "m1")]);
  assertEquals([a, b].sort(), ["answered", "skipped"]);
  assertEquals(await handleClaraTurn(asClient(f), d, "m1"), "skipped");
  assertEquals(d.calls, ["what's on today?"]);
  const r = replies(f);
  assertEquals(r.length, 1);
  assertEquals([r[0].content, r[0].reply_to_id, (r[0].metadata as Record<string, unknown>).source], ["Two meetings.", "m1", "agent"]);
  const t = f.rows("agent_thread_turns")[0];
  assertEquals([t.status, t.reply_message_id], ["answered", r[0].id]);
});

Deno.test("only someone allowed to instruct Clara gets the brain; anyone else gets a visible refusal", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1", { sender_id: "afzal" })], team_messages: [msg("m1", "email the client", "afzal")] });
  const d = deps({ canUseClara: () => Promise.resolve(false) });
  assertEquals(await handleClaraTurn(asClient(f), d, "m1"), "failed");
  assertEquals(d.calls.length, 0);
  assertEquals(replies(f)[0].content, NOT_ALLOWED_REPLY);
  assertEquals(f.rows("agent_thread_turns")[0].status, "failed");
});

Deno.test("a brain crash is reported in the thread and the turn is marked failed", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1")], team_messages: [msg("m1")] });
  const d = deps({ run: () => Promise.reject(new Error("model 529")) });
  assertEquals(await handleClaraTurn(asClient(f), d, "m1"), "failed");
  assertEquals(String(replies(f)[0].content).includes("model 529"), true);
  assertEquals([f.rows("agent_thread_turns")[0].status, f.rows("agent_thread_turns")[0].error], ["failed", "model 529"]);
});

Deno.test("a brain that answered but failed is posted and flagged failed", async () => {
  const f = new FakeSupabase({ agent_thread_turns: [turn("m1")], team_messages: [msg("m1")] });
  const d = deps({ run: () => Promise.resolve({ reply: "I hit a snag.", failed: true }) });
  assertEquals(await handleClaraTurn(asClient(f), d, "m1"), "failed");
  assertEquals(replies(f)[0].content, "I hit a snag.");
});

Deno.test("only Clara turns in 'sent' are ever claimed (FRIDAY turns and finished turns are left alone)", async () => {
  const f = new FakeSupabase({
    agent_thread_turns: [turn("m1", { mode: "agent_request", status: "queued" }), turn("m2", { status: "answered" })],
    team_messages: [msg("m1"), msg("m2")],
  });
  const d = deps();
  assertEquals(await handleClaraTurn(asClient(f), d, "m1"), "skipped");
  assertEquals(await handleClaraTurn(asClient(f), d, "m2"), "skipped");
  assertEquals(d.calls.length, 0);
});

Deno.test("the sweep runs an undelivered turn, fails a stale one and a hung one visibly, and never re-runs a hung one", async () => {
  const f = new FakeSupabase({
    agent_thread_turns: [
      turn("fresh", { created_at: ago(5_000) }),
      turn("undelivered", { created_at: ago(25_000) }),
      turn("stale", { created_at: ago(GIVE_UP_SENT_AFTER_MS + 60_000) }),
      turn("hung", { status: "working", created_at: ago(HUNG_AFTER_MS + 120_000), updated_at: ago(HUNG_AFTER_MS + 60_000) }),
    ],
    team_messages: [msg("fresh", "fresh"), msg("undelivered", "undelivered"), msg("stale", "stale"), msg("hung", "hung")],
  });
  const d = deps();
  assertEquals(await sweepTurns(asClient(f), d), { retried: 1, missed: 1, hung: 1 });
  assertEquals(d.calls, ["undelivered"]);
  const status = Object.fromEntries(f.rows("agent_thread_turns").map((t) => [t.message_id, t.status]));
  assertEquals(status, { fresh: "sent", undelivered: "answered", stale: "failed", hung: "failed" });
  const posted = replies(f).map((r) => [r.reply_to_id, r.content]);
  assertEquals(posted.some(([id, c]) => id === "stale" && c === MISSED_REPLY), true);
  assertEquals(posted.some(([id, c]) => id === "hung" && c === HUNG_REPLY), true);
  // A second sweep says nothing new.
  assertEquals(await sweepTurns(asClient(f), d), { retried: 0, missed: 0, hung: 0 });
  assertEquals(replies(f).length, 3);
});

// ── one Clara history ──────────────────────────────────────────────────────────────────────
const env = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] });
const channels = [
  { id: "ch-afzal", organization_id: "o", agent_user_id: "clara", created_by: "afzal", created_at: "2026-10-01" },
  { id: "ch-clara", organization_id: "o", agent_user_id: "clara", created_by: "jordan", created_at: "2026-10-02" },
];

Deno.test("the mirror targets OWNER_USER_ID's Clara thread and writes rows that never wake Clara", async () => {
  const f = new FakeSupabase({ team_channels: channels, users: [{ id: "clara", organization_id: "o", email: "clara@x.com" }] });
  const e = env({ OWNER_USER_ID: "jordan" });
  assertEquals(await claraThreadChannel(asClient(f), e, "o"), { id: "ch-clara", humanId: "jordan", claraId: "clara" });
  const n = await mirrorToClaraThread(asClient(f), e, "o", [
    { role: "user", content: "move my 3pm", source: "sms" },
    { role: "clara", content: "Moved to 4.", source: "sms" },
  ]);
  assertEquals(n, 2);
  assertEquals(f.rows("team_messages").map((m) => [m.channel_id, m.sender_id, (m.metadata as Record<string, unknown>).source]), [
    ["ch-clara", "jordan", "sms"], ["ch-clara", "clara", "sms"],
  ]);
});

Deno.test("no Clara thread means no mirror, and nothing throws", async () => {
  const f = new FakeSupabase({});
  assertEquals(await mirrorToClaraThread(asClient(f), env({ CLARA_USER_ID: "clara" }), "o", [{ role: "user", content: "hi", source: "sms" }]), 0);
});

Deno.test("Clara's texts to the owner are mirrored except the ones that already are owner-turn replies", () => {
  assertEquals(["owner_notify", "hold", "owner_tool", "owner_reply", "owner_voice_followup"].map(shouldMirrorOwnerText), [true, true, true, false, false]);
});

const ownerCtxFor = (f: FakeSupabase, channel: OwnerCtx["channel"]): OwnerCtx => ({
  db: asClient(f), env: env({ ANTHROPIC_API_KEY: "k", CLARA_USER_ID: "clara", OWNER_USER_ID: "jordan" }), orgId: "o",
  ownerUserId: "jordan", claraUserId: "clara", claraNumber: "+1", channel, ownerVerified: true, now: () => NOW,
  sendSms: () => Promise.resolve(true), sendEmail: () => Promise.resolve(), createEvent: () => Promise.resolve({ id: "e" }),
});
const say = (text: string) =>
  (() => Promise.resolve(new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] })))) as unknown as typeof fetch;

Deno.test("an SMS owner turn shows up in the Clara thread; an app turn is stored once, in the shared history only", async () => {
  const f = new FakeSupabase({ team_channels: channels });
  const sms = ownerCtxFor(f, "sms");
  await ownerTurn(sms.db, sms.env, sms, "status?", { fetch: say("All quiet.") });
  assertEquals(f.rows("team_messages").map((m) => m.content), ["status?", "All quiet."]);
  const chat = ownerCtxFor(f, "chat");
  await ownerTurn(chat.db, chat.env, chat, "and tomorrow?", { fetch: say("Two calls.") });
  assertEquals(f.rows("team_messages").length, 2);
  assertEquals(f.rows("clara_owner_thread").map((t) => [t.channel, t.content]), [
    ["sms", "status?"], ["sms", "All quiet."], ["chat", "and tomorrow?"], ["chat", "Two calls."],
  ]);
});

// ── FRIDAY (agent_requests) thread turns ───────────────────────────────────────────────────
Deno.test("a thread request nobody picked up gets one note in the thread instead of a text", async () => {
  const old = ago(45 * 60_000);
  const f = new FakeSupabase({
    agent_requests: [{ id: "r1", org_id: "o", title: "Fix login", kind: "task", status: "queued", created_at: old, notified_at: null, source: { channel: "agent_thread" } }],
    agent_thread_turns: [turn("m1", { mode: "agent_request", status: "queued", agent_user_id: "friday", channel_id: "ch-friday", agent_request_id: "r1" })],
  });
  const texts: string[] = [];
  const notify = (_o: string, r: { text: string }) => { texts.push(r.text); return Promise.resolve("sms" as const); };
  assertEquals((await processRequestResults(asClient(f), { now: () => NOW, notify })).warned, 1);
  assertEquals((await processRequestResults(asClient(f), { now: () => NOW, notify })).warned, 0);
  assertEquals(texts, []);
  const notes = f.rows("team_messages");
  assertEquals(notes.length, 1);
  assertEquals([notes[0].sender_id, notes[0].channel_id, (notes[0].metadata as Record<string, unknown>).kind], ["friday", "ch-friday", "system"]);
  assertEquals(await warnThreadStale(asClient(f), "r1", 30, NOW), false);
});

Deno.test("canUseClara: the account owner or a SuperAdmin; personal_assistant.view alone no longer reaches the owner brain", async () => {
  const f = new FakeSupabase({
    users: [{ id: "jordan", role_id: "r-sa" }, { id: "ops", role_id: "r-ops" }, { id: "admin", role_id: "r-admin" }, { id: "x", role_id: null }, { id: "owner2", role_id: "r-admin" }],
    roles: [{ id: "r-sa", name: "SuperAdmin" }, { id: "r-ops", name: "Ops" }, { id: "r-admin", name: "Admin" }],
    permissions: [{ id: "p-pa", key: "personal_assistant.view" }],
    role_permissions: [{ role_id: "r-admin", permission_id: "p-pa" }],
  });
  const db = asClient(f);
  const users = ["jordan", "ops", "admin", "x", "nobody", "owner2"];
  // No OWNER_USER_ID: SuperAdmin only (the Admin with personal_assistant.view is refused).
  assertEquals(await Promise.all(users.map((u) => canUseClara(db, u))), [true, false, false, false, false, false]);
  // OWNER_USER_ID names the owner, whatever their role.
  const env = { get: (k: string) => (k === "OWNER_USER_ID" ? "owner2" : undefined) };
  assertEquals(await Promise.all(users.map((u) => canUseClara(db, u, env))), [true, false, false, false, false, true]);
});
