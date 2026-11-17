/**
 * webchat-api — public chat widget backend.
 *
 * Session model (hardened 2026-07-29 — see F-39):
 *
 *   Previously every action trusted a `visitor_id` supplied in the request body and
 *   used it as the join key against `webchat_sessions`. Anyone POSTing the same
 *   visitor_id as a target visitor took over their session and could read the whole
 *   conversation. `message` and `messages` were even worse — they only checked that
 *   session_id existed, so a leaked session_id let anyone impersonate or eavesdrop.
 *
 *   Now:
 *     - `session` always returns a signed `session_token` (`<session_id>.<hmac>`).
 *     - Subsequent `session`/`message`/`messages` calls MUST send that token; the
 *       server verifies the HMAC and derives session_id from the SIGNED portion,
 *       never trusting an unsigned session_id or visitor_id in the request.
 *     - Old clients that only send `session_id` (or unsigned `visitor_id`) get a
 *       fresh session on the next `session` call. Their previous conversation is
 *       not accessible without the token — which is the correct posture, given
 *       that the token WAS the vulnerability.
 *
 *   Signing key: WEBCHAT_SESSION_SECRET when set, else SUPABASE_SERVICE_ROLE_KEY.
 *   The fallback is a real key (always present in a Supabase function), not a
 *   "return true on missing env" fail-open. The HMAC input includes a domain-
 *   separator prefix so the same secret cannot be misused as a signing oracle
 *   for anything else.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Origin allowlist. This used to be `Access-Control-Allow-Origin: "*"`, which — combined with an
 * org_id that is a plain UUID sitting in a public embed snippet — meant any site on the internet
 * could open sessions and mint conversations against this org.
 *
 * Configurable via WEBCHAT_ALLOWED_ORIGINS (comma-separated) so a new marketing domain doesn't
 * need a redeploy. Netlify deploy previews are matched by pattern; they are the legitimate
 * pre-production surface for this widget.
 *
 * A disallowed origin gets NO Allow-Origin header at all, so the browser blocks the response.
 */
const DEFAULT_ORIGINS: string[] = [];

function allowedOrigins(): string[] {
  const extra = (Deno.env.get("WEBCHAT_ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra];
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (allowedOrigins().includes(origin)) return true;
  // Netlify previews: https://<deploy-id>--<site>.netlify.app
  return /^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/i.test(origin);
}

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
    Vary: "Origin",
  };
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

// ─── session token helpers ─────────────────────────────────────────────────

const TOKEN_CONTEXT = "webchat-session:v1:";

function sessionSecret(): string {
  return Deno.env.get("WEBCHAT_SESSION_SECRET")
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || "";
}

function b64urlEncode(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// b64urlDecode removed: tokens are verified by re-signing and comparing the encoded form, so
// nothing ever decoded one. Both issues predate this change and only surfaced now because the
// supabase/functions ESLint gate had never been run against this file.

async function hmacSign(sessionId: string): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("WEBCHAT session secret is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(TOKEN_CONTEXT + sessionId),
  );
  return b64urlEncode(new Uint8Array(sig));
}

async function mintSessionToken(sessionId: string): Promise<string> {
  return `${sessionId}.${await hmacSign(sessionId)}`;
}

/** Verify a session_token and return the embedded session_id, or null on failure. */
async function verifySessionToken(token: string | undefined | null): Promise<string | null> {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const sessionId = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  // rough shape check: session_id is a uuid
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  let expectedSig: string;
  try {
    expectedSig = await hmacSign(sessionId);
  } catch {
    return null;
  }
  // constant-time compare
  if (providedSig.length !== expectedSig.length) return null;
  let diff = 0;
  const a = new TextEncoder().encode(providedSig);
  const b = new TextEncoder().encode(expectedSig);
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 ? sessionId : null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── request router ────────────────────────────────────────────────────────

// CORS is applied once, here, on the way out — rather than threaded through every jsonResponse
// call site, where one missed handler is a silently un-headered response.
Deno.serve(async (req: Request) => {
  const cors = corsFor(req);
  const res = await route(req);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
});

async function route(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing environment variables");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const action = pathParts[pathParts.length - 1];

    if (req.method === "POST" && action === "session") {
      return handleCreateSession(req, supabase);
    }

    if (req.method === "POST" && action === "message") {
      return handleSendMessage(req, supabase);
    }

    if (req.method === "GET" && action === "messages") {
      return handleGetMessages(req, supabase);
    }

    if (req.method === "GET" && action === "config") {
      return handleGetConfig(req, supabase);
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Webchat API error:", error);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
}

// ─── handlers ──────────────────────────────────────────────────────────────

async function handleGetConfig(req: Request, supabase: ReturnType<typeof createClient>) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("org_id");

  if (!orgId) return jsonResponse({ error: "Missing org_id" }, 400);

  const { data: config } = await supabase
    .from("channel_configurations")
    .select("config, is_active")
    .eq("organization_id", orgId)
    .eq("channel_type", "webchat")
    .maybeSingle();

  if (!config || !config.is_active) {
    return jsonResponse({ enabled: false }, 200);
  }

  const webchatConfig = config.config as {
    enabled: boolean;
    primary_color: string;
    welcome_message: string;
    pre_chat_form: boolean;
    required_fields: string[];
  };

  return jsonResponse({
    enabled: webchatConfig.enabled,
    primary_color: webchatConfig.primary_color || "#0066cc",
    welcome_message: webchatConfig.welcome_message || "Hi! How can we help you today?",
    pre_chat_form: webchatConfig.pre_chat_form || false,
    required_fields: webchatConfig.required_fields || [],
  }, 200);
}

// ─── rate limiting ─────────────────────────────────────────────────────────
//
// In-memory and therefore per-isolate, which is a real limitation: Supabase may run several
// isolates, so the effective ceiling is this number times the isolate count. It is still the
// difference between "a script can mint thousands of sessions" and "a script can mint a few
// dozen", and it costs no table and no round trip. form-submit uses a durable limiter; if this
// widget ever draws real abuse it should move to the same one.
const SESSION_LIMIT_PER_HOUR = 20;
const sessionHits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const hits = (sessionHits.get(key) ?? []).filter((t) => t > windowStart);
  hits.push(now);
  sessionHits.set(key, hits);
  // Unbounded growth would be its own denial of service.
  if (sessionHits.size > 5000) {
    for (const [k, v] of sessionHits) if (v.every((t) => t <= windowStart)) sessionHits.delete(k);
  }
  return hits.length > SESSION_LIMIT_PER_HOUR;
}

function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("cf-connecting-ip")
    || "unknown";
}

async function handleCreateSession(req: Request, supabase: ReturnType<typeof createClient>) {
  const body = await req.json();
  const {
    org_id: orgId,
    session_token: providedToken,
    visitor_name: visitorName,
    visitor_email: visitorEmail,
    metadata,
  } = body;

  if (!orgId) return jsonResponse({ error: "Missing org_id" }, 400);

  // If the widget presents a valid signed token, resume that session. The visitor_id
  // is now internal state, never accepted from the request body.
  if (providedToken) {
    const verifiedSessionId = await verifySessionToken(providedToken);
    if (verifiedSessionId) {
      const { data: existingSession } = await supabase
        .from("webchat_sessions")
        .select("id, organization_id, conversation_id, visitor_name, visitor_email")
        .eq("id", verifiedSessionId)
        .eq("organization_id", orgId)
        .maybeSingle();

      if (existingSession) {
        await supabase
          .from("webchat_sessions")
          .update({
            last_activity_at: new Date().toISOString(),
            visitor_name: visitorName || existingSession.visitor_name,
            visitor_email: visitorEmail || existingSession.visitor_email,
          })
          .eq("id", existingSession.id);

        return jsonResponse({
          session_id: existingSession.id,
          session_token: providedToken,
          conversation_id: existingSession.conversation_id,
          is_new: false,
        }, 200);
      }
      // Token was well-formed but the session was deleted; fall through to create a new one.
    } else {
      console.warn("[webchat-api] session token rejected; creating a new session");
    }
  }

  // Only NEW sessions are rate limited. Resuming with a valid signed token above already returned,
  // so a visitor in a long conversation is never throttled — only session minting is.
  if (rateLimited(clientKey(req))) {
    console.warn("[webchat-api] session rate limit hit for", clientKey(req));
    return jsonResponse({ error: "Too many sessions, please try again later" }, 429);
  }

  // Create a fresh session. visitor_id is server-generated and treated as opaque
  // internal state; the client only ever sees session_token.
  const visitorId = crypto.randomUUID();

  // NOTHING is written to the CRM here — no contact, no conversation. Both are created lazily on
  // the first actual message (see ensureConversation).
  //
  // This used to create a contact literally named "Web Visitor" plus a conversation on EVERY
  // anonymous session open: every bot, every crawler, every accidental double-open. A script
  // looping POST /session produced unbounded junk, and the org_id needed to do it is a plain UUID
  // sitting in the public embed snippet.
  //
  // conversations.contact_id is NOT NULL, so a conversation cannot exist without a contact — which
  // is exactly why deferring only the contact does not work. Deferring both does, because
  // webchat_sessions.conversation_id is nullable. Opening a widget is not a conversation; saying
  // something is.
  const { data: session } = await supabase
    .from("webchat_sessions")
    .insert({
      organization_id: orgId,
      conversation_id: null,
      visitor_id: visitorId,
      visitor_name: visitorName,
      visitor_email: visitorEmail,
      metadata: metadata || {},
    })
    .select()
    .single();

  if (!session) return jsonResponse({ error: "Could not start a session" }, 500);

  const sessionToken = await mintSessionToken(session.id);

  return jsonResponse({
    session_id: session.id,
    session_token: sessionToken,
    // Null until the visitor actually says something. Clients must treat this as "not yet".
    conversation_id: null,
    is_new: true,
  }, 200);
}

/**
 * Create the contact + conversation for a session that has said something, and attach them.
 *
 * Called on the first message, never on session open. Returns the conversation id, or null if the
 * write failed — callers must treat null as "do not proceed" rather than pushing on with undefined.
 */
async function ensureConversation(
  supabase: ReturnType<typeof createClient>,
  session: { id: string; organization_id: string; conversation_id: string | null; visitor_name: string | null; visitor_email: string | null },
): Promise<{ conversationId: string; contactId: string } | null> {
  if (session.conversation_id) {
    const { data: conv } = await supabase
      .from("conversations").select("contact_id").eq("id", session.conversation_id).maybeSingle();
    return { conversationId: session.conversation_id, contactId: conv?.contact_id as string };
  }

  const orgId = session.organization_id;
  let contactId: string | undefined;
  let departmentId: string | undefined;

  if (session.visitor_email) {
    const { data: existing } = await supabase
      .from("contacts")
      .select("id, department_id")
      .eq("organization_id", orgId)
      .ilike("email", session.visitor_email)
      .eq("status", "active")
      .maybeSingle();
    if (existing) {
      contactId = existing.id as string;
      departmentId = existing.department_id as string | undefined;
    }
  }

  if (!departmentId) {
    const { data: dept } = await supabase
      .from("departments").select("id").eq("organization_id", orgId).limit(1).maybeSingle();
    departmentId = dept?.id as string | undefined;
  }

  if (!contactId) {
    const { data: created } = await supabase
      .from("contacts")
      .insert({
        organization_id: orgId,
        department_id: departmentId,
        first_name: session.visitor_name || "Web",
        last_name: session.visitor_name ? "" : "Visitor",
        email: session.visitor_email,
        source: "webchat",
        status: "active",
      })
      .select("id")
      .single();
    contactId = created?.id as string | undefined;
  }
  if (!contactId) return null;

  const { data: conversation } = await supabase
    .from("conversations")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      department_id: departmentId,
      // Explicit. Omitting this left `channel` NULL on every webchat conversation — the bug the
      // 20260801050000_backfill_conversation_channel.sql migration exists to clean up after.
      // twilio-sms-inbound has always set channel: "sms" here; this path never did.
      channel: "webchat",
      status: "open",
      unread_count: 0,
    })
    .select("id")
    .single();
  if (!conversation?.id) return null;

  await supabase.from("inbox_events").insert({
    organization_id: orgId,
    conversation_id: conversation.id,
    event_type: "conversation_created",
    payload: { channel: "webchat", visitor_name: session.visitor_name || "Web Visitor" },
  });

  await supabase
    .from("webchat_sessions")
    .update({ conversation_id: conversation.id })
    .eq("id", session.id);

  return { conversationId: conversation.id as string, contactId };
}

async function handleSendMessage(req: Request, supabase: ReturnType<typeof createClient>) {
  const body = await req.json();
  const { session_token: providedToken, message } = body;

  const verifiedSessionId = await verifySessionToken(providedToken);
  if (!verifiedSessionId) {
    console.warn("[webchat-api] message rejected: missing or invalid session_token");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!message) return jsonResponse({ error: "Missing message" }, 400);

  // No embedded conversation join: a session's conversation_id is null until its first message.
  const { data: session } = await supabase
    .from("webchat_sessions")
    .select("*")
    .eq("id", verifiedSessionId)
    .maybeSingle();

  if (!session) return jsonResponse({ error: "Session not found" }, 404);

  // Creates the contact + conversation on the first message and attaches them to the session.
  const ensured = await ensureConversation(supabase, session as never);
  if (!ensured) {
    console.error("[webchat-api] could not create conversation for session", verifiedSessionId);
    return jsonResponse({ error: "Could not start the conversation" }, 500);
  }
  const { conversationId, contactId } = ensured;

  const { data: newMessage } = await supabase
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      contact_id: contactId,
      channel: "webchat",
      direction: "inbound",
      body: message,
      status: "delivered",
      metadata: {
        visitor_id: session.visitor_id,
        visitor_name: session.visitor_name,
      },
    })
    .select()
    .single();

  if (!newMessage) return jsonResponse({ error: "Could not store the message" }, 500);

  const { data: convData } = await supabase
    .from("conversations")
    .select("unread_count, status")
    .eq("id", conversationId)
    .single();

  await supabase
    .from("conversations")
    .update({
      unread_count: (convData?.unread_count || 0) + 1,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: convData?.status === "closed" ? "open" : convData?.status,
    })
    .eq("id", conversationId);

  await supabase
    .from("webchat_sessions")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", verifiedSessionId);

  // Hand off to Clara. Same fire-and-forget shape twilio-sms-inbound uses for clara-sms-responder:
  // the widget gets its ACK immediately and polls /messages for the reply, rather than holding a
  // request open across a model call. Until this existed, an inbound webchat message was stored and
  // nothing ever answered it.
  const dispatch = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/clara-web-responder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({
      orgId: session.organization_id,
      sessionId: verifiedSessionId,
      conversationId,
      contactId,
      body: message,
    }),
  }).catch((e) => console.error("[webchat-api] clara dispatch failed:", e));

  // Keep the worker alive until the reply is written, or it is killed mid-model-call.
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(dispatch);

  return jsonResponse({
    message_id: newMessage.id,
    sent_at: newMessage.sent_at,
  }, 200);
}

async function handleGetMessages(req: Request, supabase: ReturnType<typeof createClient>) {
  const url = new URL(req.url);
  // Accept the token from either query string (GET-friendly) or Authorization: Bearer <token>.
  const providedToken = url.searchParams.get("session_token")
    || (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    || null;
  const since = url.searchParams.get("since");

  const verifiedSessionId = await verifySessionToken(providedToken);
  if (!verifiedSessionId) {
    console.warn("[webchat-api] messages rejected: missing or invalid session_token");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const { data: session } = await supabase
    .from("webchat_sessions")
    .select("conversation_id")
    .eq("id", verifiedSessionId)
    .maybeSingle();

  if (!session) return jsonResponse({ error: "Session not found" }, 404);

  // A session that has not sent anything yet has no conversation. Return empty rather than
  // querying `conversation_id = null`, which matches every message with a null conversation.
  if (!session.conversation_id) return jsonResponse({ messages: [] }, 200);

  let query = supabase
    .from("messages")
    .select("id, body, direction, sent_at, channel")
    .eq("conversation_id", session.conversation_id)
    .order("sent_at", { ascending: true });

  if (since) {
    query = query.gt("sent_at", since);
  }

  const { data: messages } = await query;

  return jsonResponse({
    messages: messages?.map((m) => ({
      id: m.id,
      body: m.body,
      direction: m.direction,
      sent_at: m.sent_at,
      is_agent: m.direction === "outbound",
    })) || [],
  }, 200);
}
