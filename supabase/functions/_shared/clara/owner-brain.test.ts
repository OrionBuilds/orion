import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { CHANNEL_LIMITS, NOTHING_DONE, composeReply, dropCompletionClaims, runOwnerBrain } from "./owner-brain.ts";
import type { OwnerCtx } from "./owner-tools.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
function ctx(sent: string[] = []): OwnerCtx {
  const f = new FakeSupabase({
    contacts: [{ id: "c1", organization_id: "o", status: "active", first_name: "Casey", last_name: "Lee", email: "j@acme.com", phone: "+15551230001", company: "Acme" }],
    users: [{ id: "friday-id", organization_id: "o", email: "friday@example.com" }],
  }, { rpc: { find_contact_id_by_phone: () => null } });
  return {
    db: asClient(f), env: { get: () => undefined }, orgId: "o", ownerUserId: "owner", claraUserId: "clara", claraNumber: "+18135550142", channel: "sms", ownerVerified: true, now: () => NOW,
    sendSms: (_f, to, b) => { sent.push(`sms:${to}:${b}`); return Promise.resolve(true); },
    sendEmail: (m) => { sent.push(`email:${m.to}`); return Promise.resolve(); },
    createEvent: () => Promise.resolve({ id: "e" }),
  };
}
// A scripted model: each call returns the next canned response.
function model(...steps: unknown[]): typeof fetch {
  let i = 0;
  return (() => Promise.resolve(new Response(JSON.stringify(steps[Math.min(i++, steps.length - 1)])))) as unknown as typeof fetch;
}
const env = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "k" : undefined) };
const use = (name: string, input: Record<string, unknown>, id = "t1") => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
const say = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

Deno.test("an email request runs the tool and the reply is the tool's report, whatever the model then says", async () => {
  const sent: string[] = [];
  const f = model(use("send_email", { to: ["Casey"], subject: "Tomorrow", body: "See you at 10. — Clara" }), say("All done, I've emailed him and everything is perfect!"));
  const r = await runOwnerBrain(env, ctx(sent), [], "email Casey that I'll see him at 10", { fetch: f });
  assertEquals(sent, ["email:j@acme.com"]);
  assertEquals(r.reply, 'Emailed j@acme.com — "Tomorrow". You\'re CC\'d.');
  assertEquals(r.tools.map((t) => [t.name, t.ok]), [["send_email", true]]);
});

Deno.test("a failed tool is reported as failed, never as done", async () => {
  const c = ctx();
  c.sendEmail = () => Promise.reject(new Error("token expired"));
  const f = model(use("send_email", { to: ["j@acme.com"], subject: "x", body: "y" }), say("Sent!"));
  const r = await runOwnerBrain(env, c, [], "email j@acme.com", { fetch: f });
  assertEquals(r.reply.includes("Nothing was sent"), true);
  assertEquals(r.reply.includes("Sent!"), false);
  assertEquals(r.tools[0].ok, false);
});

Deno.test("several asks in one message all run, and the reply lists each outcome", async () => {
  const sent: string[] = [];
  const f = model(
    { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "a", name: "send_text", input: { to: "Casey", body: "Running late. — Clara" } },
      { type: "tool_use", id: "b", name: "delegate_to_friday", input: { kind: "bug", title: "Login 500", details: "Repro steps…" } },
    ] },
    say("ok"),
  );
  const r = await runOwnerBrain(env, ctx(sent), [], "text Casey I'm late and have friday look at the login bug", { fetch: f });
  assertEquals(r.tools.map((t) => t.name), ["send_text", "delegate_to_friday"]);
  assertEquals(r.reply, 'Texted Casey Lee. Queued for FRIDAY (bug): "Login 500". I\'ll tell you when it\'s done.');
});

Deno.test("an ambiguous ask gets one question and nothing is sent", async () => {
  const c = ctx();
  c.db = asClient(new FakeSupabase({ contacts: [
    { id: "1", organization_id: "o", status: "active", first_name: "Sam", last_name: "Park", email: "a@x.com" },
    { id: "2", organization_id: "o", status: "active", first_name: "Sam", last_name: "Ortiz", email: "b@y.com" },
  ] }));
  const f = model(use("send_email", { to: ["Sam"], subject: "s", body: "b" }), say("Which Sam?"));
  const r = await runOwnerBrain(env, c, [], "email Sam", { fetch: f });
  assertEquals(r.clarifying, true);
  assertEquals(r.reply.startsWith("Which Sam do you mean"), true);
});

Deno.test("a model that claims a finished action with no tool behind it is overruled", async () => {
  const r = await runOwnerBrain(env, ctx(), [], "email Casey hi", { fetch: model(say("I've sent that email to Casey.")) });
  assertEquals(r.reply, NOTHING_DONE);
  assertEquals(composeReply("Which day works for you?", []), "Which day works for you?");
  assertEquals(composeReply("I haven't sent anything yet — want me to?", []), "I haven't sent anything yet — want me to?");
});

Deno.test("read-only questions are answered from the data; an outage with nothing done says so", async () => {
  const f = model(use("find_contact", { query: "Casey" }), say("Casey Lee is at Acme."));
  assertEquals((await runOwnerBrain(env, ctx(), [], "who is Casey", { fetch: f })).reply, "Casey Lee is at Acme.");
  const down = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
  const r = await runOwnerBrain(env, ctx(), [], "email Casey", { fetch: down });
  assertEquals([r.failed, r.reply.includes("haven't done anything")], [true, true]);
});

Deno.test("if the model dies AFTER an action ran, the action is still reported", async () => {
  let n = 0;
  const f = (() => n++ === 0
    ? Promise.resolve(new Response(JSON.stringify(use("send_text", { to: "Casey", body: "hi — Clara" }))))
    : Promise.reject(new Error("net"))) as unknown as typeof fetch;
  const r = await runOwnerBrain(env, ctx(), [], "text Casey hi", { fetch: f });
  assertEquals([r.failed, r.reply], [false, "Texted Casey Lee."]);
});

Deno.test("history is passed through so a follow-up can refer to an earlier turn", async () => {
  let body = "";
  const f = ((_u: string, init: RequestInit) => { body = String(init.body); return Promise.resolve(new Response(JSON.stringify(say("Sure.")))); }) as unknown as typeof fetch;
  await runOwnerBrain(env, ctx(), [{ role: "user", content: "who is Casey" }, { role: "clara", content: "Casey Lee at Acme." }], "email him", { fetch: f });
  const m = JSON.parse(body).messages;
  assertEquals(m.map((x: { role: string }) => x.role), ["user", "assistant", "user"]);
});

Deno.test("composeReply keeps her written answer next to the tool report, minus any claimed action", () => {
  const tools = [
    { name: "send_text", ok: true, line: "Texted Casey Lee.", readOnly: false },
    { name: "calendar_agenda", ok: true, line: "2 items today.", readOnly: true },
  ];
  const r = composeReply("I've texted Casey. You have two things today: standup at 10 and Acme at 2.", tools);
  assertEquals(r, "Texted Casey Lee.\n\nYou have two things today: standup at 10 and Acme at 2.");
  // A bare acknowledgement after a write adds nothing.
  assertEquals(composeReply("Done!", [tools[0]]), "Texted Casey Lee.");
  assertEquals(dropCompletionClaims("All sent. Pat's invoice is 12 days overdue."), "Pat's invoice is 12 days overdue.");
});

Deno.test("chat gets the longer budget and thread wording; SMS stays short; the owner's context is injected only when verified", async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = ((_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Promise.resolve(new Response(JSON.stringify(say("Hi.")))); }) as unknown as typeof fetch;
  const chat = { ...ctx(), channel: "chat" as const };
  chat.db = asClient(new FakeSupabase({ user_connected_accounts: [{ user_id: "owner", provider: "microsoft_365", provider_account_email: "boss@corp.com", status: "connected" }] }));
  await runOwnerBrain(env, chat, [], "hi", { fetch: f });
  await runOwnerBrain(env, ctx(), [], "hi", { fetch: f });
  await runOwnerBrain(env, { ...chat, ownerVerified: false }, [], "hi", { fetch: f });
  assertEquals([bodies[0].max_tokens, bodies[1].max_tokens], [CHANNEL_LIMITS.chat.maxTokens, CHANNEL_LIMITS.sms.maxTokens]);
  // The system prompt is one cached text block.
  const sys = bodies.map((b) => (b.system as { text: string; cache_control?: unknown }[]).map((x) => x.text).join("\n"));
  assertEquals((bodies[0].system as { cache_control?: unknown }[])[0].cache_control, { type: "ephemeral" });
  assertEquals(((bodies[0].tools as { cache_control?: unknown }[]).at(-1))?.cache_control, { type: "ephemeral" });
  assertEquals([sys[0].includes("Clara thread in the OS's Conversations"), sys[1].includes("text message (short and plain")], [true, true]);
  assertEquals([sys[0].includes("boss@corp.com"), sys[2].includes("boss@corp.com")], [true, false]);
  assertEquals(sys[0].includes("That is the whole list"), false);
  // Every new read tool is offered to the model.
  const names = (bodies[0].tools as { name: string }[]).map((t) => t.name);
  for (const n of ["find", "client_overview", "mailbox_status", "project_work", "agents_status", "conversation_history", "meetings", "money_status", "search_records", "my_tasks", "remember", "recall"]) assertEquals(names.includes(n), true, n);
});

Deno.test("an unverified turn can't read business data even if the model asks", async () => {
  const c = { ...ctx(), ownerVerified: false };
  const f = model(use("money_status", {}), say("Here you go."));
  const r = await runOwnerBrain(env, c, [], "how much is overdue", { fetch: f });
  assertEquals(r.tools, [{ name: "money_status", ok: false, line: "I can only look that up for the account owner." }]);
});

Deno.test("chat may take more tool rounds than SMS", async () => {
  let n = 0;
  const loop = (() => { n++; return Promise.resolve(new Response(JSON.stringify(use("find_contact", { query: "Casey" }, `t${n}`)))); }) as unknown as typeof fetch;
  await runOwnerBrain(env, ctx(), [], "x", { fetch: loop });
  const sms = n; n = 0;
  await runOwnerBrain(env, { ...ctx(), channel: "chat" }, [], "x", { fetch: loop, selfContext: "" });
  assertEquals([sms, n], [CHANNEL_LIMITS.sms.maxSteps, CHANNEL_LIMITS.chat.maxSteps]);
});

Deno.test("lookups in one step run together; a step that changes something runs in order", async () => {
  const both = { role: "assistant", stop_reason: "tool_use", content: [
    { type: "tool_use", id: "a", name: "money_status", input: {} },
    { type: "tool_use", id: "b", name: "my_tasks", input: {} },
  ] };
  const f = model(both, say("Here's where things stand."));
  const r = await runOwnerBrain(env, ctx(), [], "status update", { fetch: f });
  assertEquals(r.tools.map((t) => t.name), ["money_status", "my_tasks"]); // results keep the model's order
});

// ── streamed (live call) ─────────────────────────────────────────────────────────────────
function sse(...events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  // Split mid-event to prove the reader reassembles across chunks.
  const mid = Math.floor(body.length / 2);
  const stream = new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode(body.slice(0, mid))); c.enqueue(e.encode(body.slice(mid))); c.close(); } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}
const textStep = (...parts: string[]) => sse(
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...parts.map((p) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })),
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
);
const toolStep = (name: string, input: Record<string, unknown>) => sse(
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(0, 5) } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(5) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
);

Deno.test("streamed: words reach the call as they're written, tools run, and the written reply is the same as unstreamed", async () => {
  const sent: string[] = [], deltas: string[] = [], events: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const steps = [toolStep("send_text", { to: "Casey", body: "Running late. — Clara" }), textStep("He usually ", "replies fast.")];
  let i = 0;
  const f = ((_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Promise.resolve(steps[i++]); }) as unknown as typeof fetch;
  const r = await runOwnerBrain(env, ctx(sent), [], "text Casey I'm late", {
    fetch: f, model: "claude-haiku-5-5",
    stream: {
      onText: (d) => deltas.push(d),
      onTools: (names, ro) => events.push(`tools:${names.join(",")}:${ro}`),
      onToolDone: (t) => events.push(`done:${t.name}:${t.ok}`),
    },
  });
  assertEquals(bodies.map((b) => [b.stream, b.model]), [[true, "claude-haiku-5-5"], [true, "claude-haiku-5-5"]]);
  assertEquals(sent, ["sms:+15551230001:Running late. — Clara"]);
  assertEquals(deltas, ["He usually ", "replies fast."]);
  assertEquals(events, ["tools:send_text:false", "done:send_text:true"]);
  assertEquals(r.reply, "Texted Casey Lee."); // same rule as unstreamed: a short aside after a write is dropped
});
