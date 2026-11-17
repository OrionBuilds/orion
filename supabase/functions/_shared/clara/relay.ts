/**
 * Clara on a live audio connection (Twilio ConversationRelay) for the owner's calls.
 *
 * The classic path is one webhook per utterance: Twilio transcribes, posts, waits for the whole answer, then fetches
 * the audio. On the relay Twilio keeps a websocket open, sends each finished utterance as text, and speaks whatever
 * text Clara streams back as it arrives (ElevenLabs Flash). Clara's first sentence is spoken while she is still
 * writing the rest, and the owner can talk over her.
 *
 * What she says comes from the same owner brain as every other channel, with the same honesty rule: a sentence
 * claiming a finished action is never spoken; a write tool's own result line is. The full written reply is still
 * saved to the owner's thread.
 *
 * Supabase ends an edge function after a few minutes, so a long call is rolled onto a fresh connection between
 * turns: the next utterance is carried across in handoffData and answered on the new connection.
 * If the connection fails, the call drops back to the classic path (voice.ts) instead of going quiet.
 */
import type { Env } from "./phones.ts";
import { COMPLETION_CLAIM, type StreamHooks } from "./owner-brain.ts";
import { esc, signTts, ttsSigValid } from "../twiml.ts";

export const RELAY_FN = "clara-voice-relay";
/** A new connection is started at the next utterance once a session is this old (Supabase's limit is 400 s). */
export const RELAY_ROLLOVER_MS = 240_000;
/** Lead-in when she starts looking something up before she has said anything. */
export const RELAY_ACK = "One sec.";
export const RELAY_STILL = "Still checking.";
/** Say "still checking" after this long without a word. */
export const RELAY_STILL_MS = 8_000;
export const RELAY_GIVE_UP_MS = 30_000;
export const RELAY_TEXT_FALLBACK = "This one's taking a while, so I'll text you the answer. Anything else?";
export const RELAY_SNAG = "I hit a snag thinking that through and I haven't done anything. Try again in a minute.";
/** Spoken length cap (the written reply can be longer; it is in his thread). */
export const RELAY_MAX_CHARS = 600;
/** Fast model for live turns; CLARA_VOICE_MODEL overrides. */
export const RELAY_DEFAULT_MODEL = "claude-haiku-5-5";

/** CLARA_VOICE_RELAY=owner (or on) puts the owner's calls on the relay. Anything else keeps the classic path. */
export function relayEnabled(env: Env): boolean {
  return ["owner", "on", "1", "true"].includes((env.get("CLARA_VOICE_RELAY") ?? "").trim().toLowerCase());
}

export function relayModel(env: Env): string {
  return env.get("CLARA_VOICE_MODEL")?.trim() || RELAY_DEFAULT_MODEL;
}

/** Twilio's ElevenLabs voice string: CLARA_RELAY_VOICE as given, else Clara's voice id on Flash v2.5. */
export function relayVoice(env: Env): string | null {
  const explicit = env.get("CLARA_RELAY_VOICE")?.trim();
  if (explicit) return explicit;
  const id = env.get("CLARA_ELEVENLABS_VOICE_ID")?.trim();
  return id ? `${id}-flash_v2_5` : null;
}

const tokenKey = (callSid: string) => `relay:${callSid}`;
/** The websocket URL carries a token for its call, so only a connection Clara handed Twilio is accepted. */
export const relayToken = (callSid: string, key: string) => signTts(tokenKey(callSid), key);
export const relayTokenValid = (callSid: string, token: string | null, key: string) =>
  callSid ? ttsSigValid(tokenKey(callSid), token, key) : Promise.resolve(false);

export interface RelayTwimlOpts {
  /** Functions base (https://...). */
  base: string;
  callSid: string;
  key: string;
  env: Env;
  /** Spoken when the connection opens (first connection only). */
  greeting?: string;
  /** An utterance carried over from the previous connection, answered as soon as this one opens. */
  pending?: string;
  /** Recording already running (a rolled-over connection). */
  recording?: boolean;
}

/** Inner TwiML: <Connect> to Clara's relay; Twilio posts to clara-voice?relay=done when the session ends. */
export async function relayTwiml(o: RelayTwimlOpts): Promise<string> {
  const ws = `${o.base.replace(/^http/, "ws")}/${RELAY_FN}?call=${encodeURIComponent(o.callSid)}&t=${await relayToken(o.callSid, o.key)}`;
  const action = `${o.base}/clara-voice?relay=done`;
  const voice = relayVoice(o.env);
  const attrs: Record<string, string> = {
    url: ws, language: "en-US", interruptible: "any",
    transcriptionProvider: "Deepgram", speechModel: "nova-3-general",
    ...(voice ? { ttsProvider: "ElevenLabs", voice } : {}),
    ...(o.greeting ? { welcomeGreeting: o.greeting, welcomeGreetingInterruptible: "none" } : {}),
  };
  const params = [
    ...(o.pending ? [["pending", o.pending.slice(0, 1000)]] : []),
    ...(o.recording ? [["rec", "1"]] : []),
  ].map(([k, v]) => `<Parameter name="${k}" value="${esc(v)}"/>`).join("");
  const a = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
  return `<Connect action="${esc(action)}"><ConversationRelay ${a}>${params}</ConversationRelay></Connect>`;
}

/** What the Connect action should do when a relay session ends. Pure. */
export function relayAfter(p: Record<string, string>): { kind: "rollover"; pending?: string } | { kind: "hangup" } | { kind: "fallback" } {
  let handoff: { reason?: string; pending?: string } = {};
  try { handoff = p.HandoffData ? JSON.parse(p.HandoffData) : {}; } catch { /* not ours */ }
  if (handoff.reason === "rollover") return { kind: "rollover", pending: handoff.pending };
  if (handoff.reason === "hangup" || p.SessionStatus === "completed" || p.CallStatus === "completed") return { kind: "hangup" };
  return { kind: "fallback" };
}

/** Spoken form of a written sentence: no markdown. */
export function spokenText(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`#]/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
}

/**
 * Turns streamed text into whole spoken sentences. Drops any sentence claiming a finished action (the tools report
 * those), stops at the end of the first paragraph of the answer, and caps the spoken length.
 */
export class SentenceSpeaker {
  private buf = "";
  private chars = 0;
  private capped = false;
  /** An answer sentence has been spoken (not just a lead-in). */
  content = false;
  constructor(private out: (sentence: string) => void, private maxChars = RELAY_MAX_CHARS) {}

  push(delta: string): void {
    if (this.capped) return;
    this.buf += delta;
    this.drain(false);
  }

  flush(): void { this.drain(true); }

  /** What was said so far was a lead-in ("let me look"): the answer is still to come. */
  leadIn(): void {
    this.flush();
    this.content = false;
    this.chars = 0;
    this.capped = false;
  }

  /** Something said outside the model's text (a tool's result) counts toward the answer. */
  said(s: string): void { this.content = true; this.chars += s.length; }

  private drain(all: boolean): void {
    while (!this.capped) {
      const m = /[.!?]["')\]]?(?=\s)/.exec(this.buf);
      const p = this.buf.indexOf("\n\n");
      let end = m ? m.index + m[0].length : -1;
      let para = false;
      if (p >= 0 && (end < 0 || p < end)) { end = p; para = true; }
      if (end < 0) {
        if (all) { this.emit(this.buf); this.buf = ""; }
        return;
      }
      const sentence = this.buf.slice(0, end);
      const gap = /^\s*/.exec(this.buf.slice(end))![0];
      if (gap.includes("\n\n")) para = true;
      this.buf = this.buf.slice(end + gap.length);
      this.emit(sentence);
      if (para && this.content) { this.capped = true; this.buf = ""; }
    }
  }

  private emit(raw: string): void {
    const s = spokenText(raw);
    if (!s || COMPLETION_CLAIM.test(s)) return;
    if (this.content && this.chars + s.length > this.maxChars) { this.capped = true; this.buf = ""; return; }
    this.out(s);
    this.content = true;
    this.chars += s.length;
  }
}

export interface RelayDeps {
  send: (msg: Record<string, unknown>) => void;
  /** One owner turn on the relay: streams through `hooks`, resolves to the written reply (saved to his thread). */
  ownerTurn: (text: string, hooks: StreamHooks) => Promise<string>;
  /** Text the owner an answer the call can't say (too slow, or he hung up first). */
  textOwner: (reply: string) => Promise<unknown>;
  startRecording: () => Promise<unknown>;
  keepAlive: (p: Promise<unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (msg: string) => void;
}

interface LiveTurn { muted: boolean; textLater: boolean; spoke: boolean; lastSpokeAt: number }

/** One relay connection. Feed it every websocket message; it answers through deps.send. */
export function relaySession(d: RelayDeps, opts: { rolloverAfterMs?: number } = {}) {
  const openedAt = d.now();
  const rollover = opts.rolloverAfterMs ?? RELAY_ROLLOVER_MS;
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let current: LiveTurn | null = null;
  let recording = false;
  let closed = false;
  let ended = false;

  const ensureRecording = () => {
    if (recording) return;
    recording = true;
    d.startRecording().catch((e) => d.log?.(`recording not started: ${e}`));
  };

  async function runTurn(text: string): Promise<void> {
    const startedAt = d.now();
    const t: LiveTurn = { muted: false, textLater: false, spoke: false, lastSpokeAt: startedAt };
    current = t;
    const say = (s: string) => {
      if (t.muted || t.textLater || closed) return;
      d.send({ type: "text", token: `${s} `, last: false });
      t.lastSpokeAt = d.now();
      t.spoke = true;
    };
    const speaker = new SentenceSpeaker(say);
    const hooks: StreamHooks = {
      onText: (delta) => speaker.push(delta),
      onTools: () => {
        const answered = speaker.content;
        speaker.leadIn();
        // Nothing said yet: a short lead-in so there is no dead air while she looks.
        if (!answered && !t.spoke) say(RELAY_ACK);
      },
      onToolDone: (r) => {
        // A change she made: the tool's own report is what gets said.
        if (r.readOnly) return;
        say(r.line);
        speaker.said(r.line);
      },
    };

    let settled = false;
    const run = d.ownerTurn(text, hooks)
      .catch((e) => { d.log?.(`owner turn failed: ${e}`); return RELAY_SNAG; })
      .finally(() => { settled = true; });

    while (!settled) {
      await Promise.race([run, d.sleep(1_000)]);
      if (settled) break;
      if (d.now() - startedAt >= RELAY_GIVE_UP_MS) {
        say(RELAY_TEXT_FALLBACK);
        if (!t.muted && !closed) d.send({ type: "text", token: "", last: true });
        t.textLater = true;
        break;
      }
      if (d.now() - t.lastSpokeAt >= RELAY_STILL_MS) say(RELAY_STILL);
    }
    const reply = await run;
    if (t.textLater) { await d.textOwner(reply).catch((e) => d.log?.(`text failed: ${e}`)); return; }
    speaker.flush();
    if (!speaker.content) say(spokenText(reply.split("\n\n")[0]).slice(0, RELAY_MAX_CHARS));
    if (closed) { await d.textOwner(reply).catch((e) => d.log?.(`text failed: ${e}`)); return; }
    if (!t.muted) d.send({ type: "text", token: "", last: true });
  }

  const enqueue = (text: string) => {
    queued++;
    const p = chain.then(() => runTurn(text)).catch((e) => d.log?.(`turn crashed: ${e}`)).finally(() => { queued--; });
    chain = p;
    d.keepAlive(p);
  };

  return {
    onMessage(m: Record<string, any>): void {
      if (ended) return;
      switch (m.type) {
        case "setup": {
          const cp = (m.customParameters ?? {}) as Record<string, string>;
          if (cp.rec === "1") recording = true;
          if (cp.pending?.trim()) { ensureRecording(); enqueue(cp.pending.trim()); }
          return;
        }
        case "prompt": {
          if (m.last === false) return;
          const text = String(m.voicePrompt ?? "").trim();
          if (!text) return;
          ensureRecording();
          if (queued === 0 && d.now() - openedAt >= rollover) {
            ended = true;
            d.send({ type: "end", handoffData: JSON.stringify({ reason: "rollover", pending: text }) });
            return;
          }
          enqueue(text);
          return;
        }
        case "interrupt":
          if (current) current.muted = true;
          return;
        case "error":
          d.log?.(`relay error: ${m.description ?? JSON.stringify(m)}`);
          return;
      }
    },
    onClose(): void { closed = true; },
    /** Resolves when every queued turn has finished (tests). */
    idle: () => chain,
  };
}
