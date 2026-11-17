import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient, isServiceRoleRequest } from "../_shared/auth.ts";
import { dispatchMail, MailSelectorError } from "../_shared/mail-dispatch.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/**
 * POST { to[], subject, body, content_type?, cc?, bcc?, user_id?, from_connection_id? }
 * Sends from the caller's connected Microsoft mailbox (the primary unless from_connection_id names another of THEIR accounts, else 403). Service-role callers (other edge
 * functions, e.g. the agent runtime) must pass `user_id` to choose whose mailbox sends.
 * The owner (OWNER_CC_EMAIL secret) is CC'd on every send.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = getSupabaseClient();
    const body = await req.json();

    let userId: string;
    if (isServiceRoleRequest(req)) {
      if (!body.user_id) return json({ error: "user_id required for service calls" }, 400);
      userId = body.user_id;
    } else {
      const ctx = await extractUserContext(req, supabase);
      if (!ctx) return json({ error: "Unauthorized" }, 401);
      userId = ctx.id;
    }

    // The org's outbound provider decides the pipe (Microsoft Graph by default, Resend when configured).
    const sent = await dispatchMail(supabase, {
      userId,
      mail: {
        to: body.to ?? [],
        subject: body.subject ?? "",
        body: body.body ?? "",
        contentType: body.content_type,
        cc: body.cc,
        bcc: body.bcc,
      },
      ownerEmail: Deno.env.get("OWNER_CC_EMAIL"),
      fromConnectionId: typeof body.from_connection_id === "string" && body.from_connection_id ? body.from_connection_id : null,
    });

    return json({ success: true, provider: sent.provider, message_id: sent.messageId });
  } catch (e) {
    if (e instanceof MailSelectorError) return json({ error: e.message }, 403);
    const msg = (e as Error).message;
    console.error("[microsoft-mail-send]", msg);
    // Validation errors are the caller's; everything else is ours.
    return json({ error: msg }, msg.startsWith("sendMail:") ? 400 : 500);
  }
});
