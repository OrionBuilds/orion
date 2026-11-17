/**
 * clara-voice-relay — the websocket Twilio ConversationRelay connects to for the owner's calls.
 *
 * clara-voice hands Twilio this URL with a token for that one call (relay.ts). The connection is accepted only with
 * a valid token, and the session only runs when the setup message is for that call and comes from an owner number.
 * Each finished utterance runs through the owner brain with its words streamed back to Twilio as they are written.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { background, denoEnv, functionsBase, serviceClient, twilioAuth } from "../_shared/clara/webhook.ts";
import { isOwner, ownerDeliveryNumber } from "../_shared/clara/phones.ts";
import { ownerTurn } from "../_shared/clara/owner-turn.ts";
import { ownerCtx, resolveLine, sendAndLogSms } from "../_shared/clara/runtime.ts";
import { relayModel, relaySession, relayTokenValid } from "../_shared/clara/relay.ts";
import { startCallRecording } from "../_shared/clara/twilio-rest.ts";

const log = (callSid: string, msg: string) => console.log(`[relay] ${callSid} ${msg}`);

Deno.serve(async (req: Request) => {
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
  const url = new URL(req.url);
  const callSid = url.searchParams.get("call") ?? "";
  const auth = twilioAuth(denoEnv);
  if (!auth || !(await relayTokenValid(callSid, url.searchParams.get("t"), auth.authToken))) {
    return new Response("forbidden", { status: 403 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const db = serviceClient();
  const base = functionsBase(denoEnv);
  let session: ReturnType<typeof relaySession> | null = null;
  // Messages are handled in order: the setup lookup finishes before the first utterance is read.
  let inbox: Promise<void> = Promise.resolve();

  const send = (msg: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };

  async function handle(raw: string): Promise<void> {
    let m: Record<string, any>;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "setup") {
      const from = String(m.from ?? "");
      if (m.callSid !== callSid || !isOwner(denoEnv, from)) {
        log(callSid, `setup refused (call ${m.callSid === callSid ? "ok" : "mismatch"}, owner ${isOwner(denoEnv, from)})`);
        socket.close(1008, "not allowed");
        return;
      }
      const line = await resolveLine(db, String(m.to ?? ""));
      if (!line) { log(callSid, `no line for ${m.to}`); socket.close(1011, "no line"); return; }
      const ctx = ownerCtx(db, denoEnv, { orgId: line.orgId, claraNumber: line.number, channel: "voice", ownerVerified: true });
      const model = relayModel(denoEnv);
      log(callSid, `session open (model ${model})`);
      session = relaySession({
        send,
        ownerTurn: async (text, hooks) => (await ownerTurn(db, denoEnv, ctx, text, { stream: hooks, model })).reply,
        textOwner: (reply) => sendAndLogSms(db, denoEnv, line.orgId, line.number, ownerDeliveryNumber(denoEnv) ?? from, reply, "owner_voice_followup"),
        startRecording: async () => {
          const r = await startCallRecording(auth!, callSid, `${base}/clara-recording`);
          if (!r.ok) throw new Error(r.error);
        },
        keepAlive: background,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        log: (msg) => log(callSid, msg),
      });
    }
    session?.onMessage(m);
  }

  socket.onmessage = (ev) => {
    inbox = inbox.then(() => handle(String(ev.data))).catch((e) => console.error("[relay]", callSid, e));
  };
  socket.onclose = () => { session?.onClose(); log(callSid, "closed"); };
  socket.onerror = (e) => console.error("[relay] socket error", callSid, e);
  return response;
});
