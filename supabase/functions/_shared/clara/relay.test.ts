import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { StreamHooks } from "./owner-brain.ts";
import {
  RELAY_ACK, RELAY_GIVE_UP_MS, RELAY_STILL, RELAY_TEXT_FALLBACK, SentenceSpeaker, relayAfter, relayEnabled, relaySession,
  relayToken, relayTokenValid, relayTwiml, relayVoice,
} from "./relay.ts";

const env = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] });

Deno.test("relay is off unless CLARA_VOICE_RELAY turns it on", () => {
  assertEquals(relayEnabled(env()), false);
  assertEquals(relayEnabled(env({ CLARA_VOICE_RELAY: "owner" })), true);
  assertEquals(relayEnabled(env({ CLARA_VOICE_RELAY: "off" })), false);
});

Deno.test("the websocket token is bound to its call", async () => {
  const t = await relayToken("CA1", "secret");
  assertEquals(await relayTokenValid("CA1", t, "secret"), true);
  assertEquals(await relayTokenValid("CA2", t, "secret"), false);
  assertEquals(await relayTokenValid("CA1", t, "other"), false);
  assertEquals(await relayTokenValid("CA1", null, "secret"), false);
});

Deno.test("TwiML connects to the relay with Clara's voice, a greeting, and the action back to clara-voice", async () => {
  const x = await relayTwiml({
    base: "https://x.supabase.co/functions/v1", callSid: "CA1", key: "k",
    env: env({ CLARA_ELEVENLABS_VOICE_ID: "VOICE" }), greeting: "Hi & welcome",
  });
  assertStringIncludes(x, `<Connect action="https://x.supabase.co/functions/v1/clara-voice?relay=done">`);
  assertStringIncludes(x, `url="wss://x.supabase.co/functions/v1/clara-voice-relay?call=CA1&amp;t=${await relayToken("CA1", "k")}"`);
  assertStringIncludes(x, `ttsProvider="ElevenLabs" voice="VOICE-flash_v2_5"`);
  assertStringIncludes(x, `welcomeGreeting="Hi &amp; welcome"`);
  assertStringIncludes(x, `interruptible="any"`);
  assertEquals(relayVoice(env({ CLARA_RELAY_VOICE: "X-turbo_v2_5", CLARA_ELEVENLABS_VOICE_ID: "VOICE" })), "X-turbo_v2_5");
});

Deno.test("a rolled-over connection carries the pending utterance and skips the greeting", async () => {
  const x = await relayTwiml({ base: "https://b", callSid: "CA1", key: "k", env: env(), pending: "what's on today?", recording: true });
  assertEquals(x.includes("welcomeGreeting"), false);
  assertEquals(x.includes("ttsProvider"), false);
  assertStringIncludes(x, `<Parameter name="pending" value="what&#39;s on today?"/>`.replace("&#39;", "'"));
  assertStringIncludes(x, `<Parameter name="rec" value="1"/>`);
});

Deno.test("session end: rollover, hang-up, or drop back to the classic path", () => {
  assertEquals(relayAfter({ SessionStatus: "ended", HandoffData: JSON.stringify({ reason: "rollover", pending: "hi" }) }), { kind: "rollover", pending: "hi" });
  assertEquals(relayAfter({ SessionStatus: "completed" }), { kind: "hangup" });
  assertEquals(relayAfter({ SessionStatus: "failed" }), { kind: "fallback" });
  assertEquals(relayAfter({ SessionStatus: "ended", HandoffData: "not json" }), { kind: "fallback" });
});

Deno.test("speaker: whole sentences, no markdown, no claimed actions, first paragraph only", () => {
  const out: string[] = [];
  const s = new SentenceSpeaker((x) => out.push(x));
  for (const d of ["You have **three** meet", "ings today. I've sent the", " agenda to Casey. First is at 10.", "\n\nSecond paragraph is written only."]) s.push(d);
  s.flush();
  assertEquals(out, ["You have three meetings today.", "First is at 10."]);
});

Deno.test("speaker: a lead-in before tools doesn't count as the answer", () => {
  const out: string[] = [];
  const s = new SentenceSpeaker((x) => out.push(x));
  s.push("Let me look.");
  s.leadIn();
  assertEquals(s.content, false);
  s.push("Two invoices are overdue.\n\nMore here.");
  s.flush();
  assertEquals(out, ["Let me look.", "Two invoices are overdue."]);
});

// ── session ──────────────────────────────────────────────────────────────────────────────

function harness(turn: (text: string, h: StreamHooks) => Promise<string>, rolloverAfterMs?: number) {
  const sent: Record<string, unknown>[] = [], texts: string[] = [], logs: string[] = [];
  let recordings = 0;
  const clock = { t: 0 };
  const s = relaySession({
    send: (m) => sent.push(m),
    ownerTurn: turn,
    textOwner: (r) => { texts.push(r); return Promise.resolve(); },
    startRecording: () => { recordings++; return Promise.resolve(); },
    keepAlive: () => {},
    sleep: async (ms) => { await new Promise((r) => setTimeout(r, 0)); clock.t += ms; },
    now: () => clock.t,
    log: (m) => logs.push(m),
  }, { rolloverAfterMs });
  const spoken = () => sent.filter((m) => m.type === "text").map((m) => m.token).join("");
  return { s, sent, texts, logs, clock, spoken, recordings: () => recordings };
}

Deno.test("a quick answer is streamed sentence by sentence and closed with last:true; recording starts at his first words", async () => {
  const h = harness(async (_t, hooks) => {
    hooks.onText("You're free until two. ");
    hooks.onText("Then Casey.");
    return "You're free until two. Then Casey.";
  });
  h.s.onMessage({ type: "setup", callSid: "CA1" });
  assertEquals(h.recordings(), 0);
  h.s.onMessage({ type: "prompt", voicePrompt: "what's my afternoon", last: true });
  await h.s.idle();
  assertEquals(h.recordings(), 1);
  assertEquals(h.spoken(), "You're free until two. Then Casey. ");
  assertEquals(h.sent.at(-1), { type: "text", token: "", last: true });
});

Deno.test("looking something up: 'one sec' at once, write tools say their own result, the claim is dropped", async () => {
  const h = harness(async (_t, hooks) => {
    hooks.onTools?.(["find"], true);
    hooks.onTools?.(["send_text"], false);
    hooks.onToolDone?.({ name: "send_text", ok: true, line: "Texted Casey Lee.", readOnly: false });
    hooks.onText("I've texted him. He usually replies fast.");
    return "Texted Casey Lee.\n\nHe usually replies fast.";
  });
  h.s.onMessage({ type: "prompt", voicePrompt: "text Casey I'm late", last: true });
  await h.s.idle();
  assertEquals(h.spoken(), `${RELAY_ACK} Texted Casey Lee. He usually replies fast. `);
});

Deno.test("nothing streamed (the model wrote no prose): the written reply's first paragraph is spoken", async () => {
  const h = harness(() => Promise.resolve("I haven't actually done anything with that yet.\n\nmore"));
  h.s.onMessage({ type: "prompt", voicePrompt: "do the thing", last: true });
  await h.s.idle();
  assertEquals(h.spoken(), "I haven't actually done anything with that yet. ");
});

Deno.test("a slow lookup: 'still checking', then past the give-up time it's texted and the call moves on", async () => {
  let finish!: (r: string) => void;
  const h = harness((_t, hooks) => { hooks.onTools?.(["money_status"], true); return new Promise((r) => { finish = r; }); });
  h.s.onMessage({ type: "prompt", voicePrompt: "money status", last: true });
  while (!h.spoken().includes(RELAY_TEXT_FALLBACK)) await new Promise((r) => setTimeout(r, 0));
  assertEquals(h.clock.t >= RELAY_GIVE_UP_MS, true);
  finish("Two invoices overdue, 4,200 total.");
  await h.s.idle();
  const said = h.spoken();
  assertStringIncludes(said, RELAY_ACK);
  assertStringIncludes(said, RELAY_STILL);
  assertStringIncludes(said, RELAY_TEXT_FALLBACK);
  assertEquals(said.includes("4,200"), false);
  assertEquals(h.texts, ["Two invoices overdue, 4,200 total."]);
});

Deno.test("talking over her mutes the rest of that answer", async () => {
  let go!: () => void;
  const h = harness(async (_t, hooks) => {
    hooks.onText("First sentence. ");
    await new Promise<void>((r) => { go = r; });
    hooks.onText("Second sentence.");
    return "First sentence. Second sentence.";
  });
  h.s.onMessage({ type: "prompt", voicePrompt: "q", last: true });
  await new Promise((r) => setTimeout(r, 0));
  h.s.onMessage({ type: "interrupt", utteranceUntilInterrupt: "First" });
  go();
  await h.s.idle();
  assertEquals(h.spoken(), "First sentence. ");
});

Deno.test("hung up before the answer: it's texted", async () => {
  let finish!: (r: string) => void;
  const h = harness(() => new Promise((r) => { finish = r; }));
  h.s.onMessage({ type: "prompt", voicePrompt: "q", last: true });
  await new Promise((r) => setTimeout(r, 0));
  h.s.onClose();
  finish("The answer.");
  await h.s.idle();
  assertEquals(h.texts, ["The answer."]);
});

Deno.test("an old connection hands the next utterance to a fresh one instead of answering it", async () => {
  let turns = 0;
  const h = harness(() => { turns++; return Promise.resolve("ok"); }, 1_000);
  h.clock.t = 5_000;
  h.s.onMessage({ type: "prompt", voicePrompt: "next question", last: true });
  await h.s.idle();
  assertEquals(turns, 0);
  assertEquals(h.sent, [{ type: "end", handoffData: JSON.stringify({ reason: "rollover", pending: "next question" }) }]);
});

Deno.test("the fresh connection answers the carried utterance at once without restarting the recording", async () => {
  const asked: string[] = [];
  const h = harness((t) => { asked.push(t); return Promise.resolve("Sure."); });
  h.s.onMessage({ type: "setup", callSid: "CA1", customParameters: { pending: "next question", rec: "1" } });
  await h.s.idle();
  assertEquals(asked, ["next question"]);
  assertEquals(h.recordings(), 0);
  assertEquals(h.spoken(), "Sure. ");
});

Deno.test("partial prompts are ignored; turns run one at a time in order", async () => {
  const asked: string[] = [];
  const h = harness(async (t) => { asked.push(t); await new Promise((r) => setTimeout(r, 0)); return t; });
  h.s.onMessage({ type: "prompt", voicePrompt: "par", last: false });
  h.s.onMessage({ type: "prompt", voicePrompt: "one", last: true });
  h.s.onMessage({ type: "prompt", voicePrompt: "two", last: true });
  await h.s.idle();
  await h.s.idle();
  assertEquals(asked, ["one", "two"]);
});
