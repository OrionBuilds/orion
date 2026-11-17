import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { DEFERRED_REPLY, loadThread, overheardReply, ownerTurn, soundOnly } from "./owner-turn.ts";
import type { OwnerCtx } from "./owner-tools.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
const env = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "k" : undefined) };
function setup(seed: Record<string, Record<string, unknown>[]> = {}) {
  const f = new FakeSupabase(seed);
  const ctx: OwnerCtx = {
    db: asClient(f), env, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+1", channel: "sms", ownerVerified: true, now: () => NOW,
    sendSms: () => Promise.resolve(true), sendEmail: () => Promise.resolve(), createEvent: () => Promise.resolve({ id: "e" }),
  };
  return { f, ctx };
}
const say = (text: string, delayMs = 0) =>
  (() => new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }))), delayMs))) as unknown as typeof fetch;

Deno.test("a turn is saved to the shared thread and the next turn sees it (24h window, oldest first)", async () => {
  const { f, ctx } = setup({ clara_owner_thread: [
    { organization_id: "o", role: "user", content: "stale", created_at: "2026-10-18T00:00:00Z" },
    { organization_id: "o", role: "user", content: "earlier", created_at: "2026-10-20T10:00:00Z" },
  ] });
  assertEquals((await loadThread(ctx.db, "o", NOW)).map((t) => t.content), ["earlier"]);
  const r = await ownerTurn(ctx.db, env, ctx, "what's up?", { fetch: say("Not much.") });
  assertEquals([r.reply, r.deferred], ["Not much.", false]);
  assertEquals(f.rows("clara_owner_thread").slice(-2).map((t) => [t.role, t.content]), [["user", "what's up?"], ["clara", "Not much."]]);
});

Deno.test("a slow brain answers honestly now and delivers the real outcome later, exactly once", async () => {
  const { f, ctx } = setup();
  const delivered: string[] = []; const kept: Promise<unknown>[] = [];
  const r = await ownerTurn(ctx.db, env, ctx, "do the thing", {
    fetch: say("Finished.", 60), deadlineMs: 10,
    deliverLater: (t) => { delivered.push(t); return Promise.resolve(); }, keepAlive: (p) => kept.push(p),
  });
  assertEquals([r.reply, r.deferred, delivered.length], [DEFERRED_REPLY, true, 0]);
  await Promise.all(kept);
  assertEquals(delivered, ["Finished."]);
  assertEquals(f.rows("clara_owner_thread").filter((t) => t.role === "clara").length, 1);
});

Deno.test("a fast brain inside the deadline is returned directly with nothing deferred", async () => {
  const { ctx } = setup();
  const delivered: string[] = [];
  const r = await ownerTurn(ctx.db, env, ctx, "hi", { fetch: say("Hi."), deadlineMs: 500, deliverLater: (t) => { delivered.push(t); return Promise.resolve(); } });
  assertEquals([r.reply, r.deferred, delivered.length], ["Hi.", false, 0]);
});

Deno.test("the app thread reads three days of shared history; SMS/voice keep one day", async () => {
  const { ctx } = setup({ clara_owner_thread: [
    { organization_id: "o", role: "user", content: "two days ago", created_at: "2026-10-18T16:00:00Z" },
    { organization_id: "o", role: "user", content: "today", created_at: "2026-10-20T10:00:00Z" },
    { organization_id: "other", role: "user", content: "other org", created_at: "2026-10-20T11:00:00Z" },
  ] });
  assertEquals((await loadThread(ctx.db, "o", NOW, "chat")).map((t) => t.content), ["two days ago", "today"]);
  assertEquals((await loadThread(ctx.db, "o", NOW, "sms")).map((t) => t.content), ["today"]);
});

Deno.test("speech a device overheard is remembered by Clara but kept out of the owner's thread", async () => {
  const seed = () => ({ team_channels: [{ id: "ch", organization_id: "o", agent_user_id: "clara", created_by: "owner", created_at: "2026-10-01T00:00:00Z" }] });
  const voiceEnv = { get: (k: string) => ({ ANTHROPIC_API_KEY: "k", CLARA_USER_ID: "clara", OWNER_USER_ID: "owner" } as Record<string, string>)[k] };
  const turn = async (heard: string, reply: string) => {
    const { f, ctx } = setup(seed());
    await ownerTurn(ctx.db, voiceEnv, { ...ctx, env: voiceEnv, channel: "voice" }, heard, { fetch: say(reply) });
    return [f.rows("clara_owner_thread").length, f.rows("team_messages").length];
  };
  assertEquals(await turn("Clara, what's on tomorrow?", "Two meetings."), [2, 2]);
  assertEquals(await turn("We want him to push our software.", "Still not addressed to me, so I'm staying quiet. Say Clara when you need me."), [2, 0]);

  assertEquals([soundOnly("[beep]"), soundOnly(" [phone beeping] [click]"), soundOnly("[laughs] okay Clara"), soundOnly("")], [true, true, false, false]);
  assertEquals([overheardReply("I'm still staying quiet, since none of that was addressed to me."), overheardReply("Your 3 PM is addressed.")], [true, false]);
});
