// clara-chat — the OS's in-app Clara assistant, running NATIVELY in the OS.
//
// Until 2026-10-22 this proxied the conversation to the old CLARA Next app
// (a separate Clara app's /api/chat) over a Cloudflare Access service token. That app is retired, so
// this now runs Clara's own owner brain in-process (the same runOwnerBrain used by her SMS and voice
// rails): persona + tool use (tasks, email as Clara with the owner CC'd, texts, calls, FRIDAY
// hand-offs, calendar, lookups, approvals) over the Anthropic API. No external hop, no old app.
//
// Auth: the caller MUST be the signed-in account owner (OWNER_USER_ID) or a SuperAdmin. Clara answers
// to the owner, and her owner brain reads clients, mail and money.
//
// Channel is "chat": the panel keeps its own on-screen history and sends it each turn, so the brain
// reasons over that history directly (no clara_owner_thread write — that store is the sms/voice thread).
import { getSupabaseClient } from "../_shared/auth.ts";
import { ownerCtx, claraNumberFor } from "../_shared/clara/runtime.ts";
import { runOwnerBrain, type Turn } from "../_shared/clara/owner-brain.ts";
import { canUseClara } from "../_shared/clara/agent-thread.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function errorResponse(code: string, message: string, status = 400): Response {
  return json({ success: false, error: { code, message } }, status);
}

interface ChatMessage { role: string; content: string }

// Resolve the caller's identity + active org, then confirm they may use Clara.
// deno-lint-ignore no-explicit-any
async function resolveCaller(req: Request, svc: any): Promise<{ userId: string; orgId: string } | null> {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await svc.auth.getUser(token);
  if (!user) return null;

  const { data: u } = await svc.from("users")
    .select("organization_id, super_admin_active_org_id")
    .eq("id", user.id).maybeSingle();
  if (!u) return null;

  // The owner brain reads the whole business (clients, mail, money), so only the account owner
  // (OWNER_USER_ID) or a SuperAdmin may use it; personal_assistant.view alone is no longer enough.
  if (!(await canUseClara(svc, user.id, Deno.env))) return null;

  // SuperAdmin may pivot active org (OrgSwitcher); honor it the way get_user_org_id() does.
  const orgId = (u.super_admin_active_org_id as string | null) || (u.organization_id as string | null);
  if (!orgId) return null;
  return { userId: user.id, orgId };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Use POST", 405);

  const svc = getSupabaseClient();
  const caller = await resolveCaller(req, svc);
  if (!caller) return errorResponse("FORBIDDEN", "Clara is not available for this account", 403);

  let messages: ChatMessage[];
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
  } catch {
    return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
  }
  if (messages.length === 0) return errorResponse("BAD_REQUEST", "messages[] is required", 400);

  // The latest user turn is the prompt; everything before it is the on-screen history.
  const last = messages[messages.length - 1];
  const text = String(last?.content ?? "").trim();
  if (!text) return errorResponse("BAD_REQUEST", "the last message has no content", 400);
  const history: Turn[] = messages.slice(0, -1).map((m) => ({
    role: m.role === "assistant" || m.role === "clara" ? "clara" : "user",
    content: String(m.content ?? ""),
  }));

  try {
    const claraNumber = await claraNumberFor(svc, Deno.env, caller.orgId);
    const ctx = ownerCtx(svc, Deno.env, { orgId: caller.orgId, claraNumber, channel: "chat", ownerVerified: true });
    const result = await runOwnerBrain(Deno.env, ctx, history, text);
    return json({ text: result.reply ?? "", engine: "clara" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[clara-chat]", msg);
    return errorResponse("BRAIN_ERROR", `Clara hit a snag: ${msg}`, 500);
  }
});
