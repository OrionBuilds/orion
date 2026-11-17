/**
 * email-delivery-status — ask Resend what actually happened to a message we sent.
 *
 * WHY THIS EXISTS. On 2026-08-03 a contract signature request went to a client, the OS recorded it
 * as sent with a Resend message id, and the client never saw it. Nothing in the estate could answer
 * the only question that mattered — was it delivered, bounced, or filed as spam? — because the
 * signature-email path writes to neither `messages` nor `email_test_logs`, so the Resend webhook
 * had no row to attach delivery events to. "Resend accepted it" and "the recipient got it" are
 * different claims, and the OS could only ever make the first one.
 *
 * Read-only. It sends nothing and changes nothing.
 *
 * TWO WAYS IN, and the difference is deliberate:
 *
 *   1. X-Diag-Key (shared secret) + { messageId } — for scripts and operators. Can look up ANY
 *      message id, which is why it is gated on a secret rather than a user session.
 *
 *   2. Authorization: Bearer <user JWT> + { contractId } — for the app UI. The caller does NOT get
 *      to name a message id: the function resolves it from the contract's own signature-request row
 *      and refuses if the contract does not belong to the caller's organization. Letting a
 *      signed-in user pass an arbitrary id would leak other orgs' recipients and subject lines,
 *      since Resend ids are global to the account.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds, getResendEmail } from "../_shared/resend.ts";
import { corsHeaders } from "../_shared/cors.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Constant-time compare so the shared key cannot be probed byte by byte. */
function keyMatches(presented: string, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const body = await req.json().catch(() => null) as { messageId?: string; contractId?: string } | null;

  const creds = getResendEnvCreds();
  if (!creds) return json({ error: "Resend is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)" }, 503);

  // ── Path 1: operator, with the shared key ────────────────────────────────────────────────────
  //
  // NOT the service-role key. The obvious implementation — compare the bearer against
  // SUPABASE_SERVICE_ROLE_KEY, which is what _shared/auth.ts does — is broken on this project:
  // Supabase migrated it to the `sb_`-prefixed format, so it no longer equals the `service_role`
  // JWT any external caller would present. String-equality against a platform key silently stops
  // matching the day the platform rotates its key format.
  const diagKey = (Deno.env.get("EMAIL_DIAG_KEY") ?? "").trim();
  const presentedDiag = (req.headers.get("x-diag-key") ?? "").trim();
  if (presentedDiag) {
    if (!diagKey || !keyMatches(presentedDiag, diagKey)) return json({ error: "unauthorized" }, 401);
    const messageId = String(body?.messageId ?? "").trim();
    if (!messageId) return json({ error: "messageId is required" }, 400);
    return respond(creds.apiKey, messageId);
  }

  // ── Path 2: the app, with the signed-in user's session ───────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "unauthorized" }, 401);

  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: { user }, error: authErr } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
  if (authErr || !user) return json({ error: "unauthorized" }, 401);

  const contractId = String(body?.contractId ?? "").trim();
  if (!contractId) return json({ error: "contractId is required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: userRow } = await supabase
    .from("users").select("organization_id").eq("id", user.id).maybeSingle();
  const orgId = userRow?.organization_id;
  if (!orgId) return json({ error: "user has no organization" }, 403);

  // The org check is the whole point of this path — without it a signed-in user of ANY org could
  // read another org's signature-request recipients.
  const { data: reqRow } = await supabase
    .from("contract_signature_requests")
    .select("id, org_id, sendgrid_message_id, signer_email, last_sent_at")
    .eq("contract_id", contractId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!reqRow) return json({ ok: true, status: "no_request", message: "No signature request for this contract." });
  if (reqRow.org_id !== orgId) return json({ error: "not found" }, 404);

  const messageId = (reqRow.sendgrid_message_id as string | null)?.trim();
  if (!messageId) {
    // A real state, not an error: the request exists but no send was ever recorded against it.
    return json({
      ok: true,
      status: "not_sent",
      message: "No email send is recorded for this signature request.",
      signerEmail: reqRow.signer_email,
    });
  }

  return respond(creds.apiKey, messageId, reqRow.signer_email as string | null, reqRow.last_sent_at as string | null);
});

async function respond(
  apiKey: string,
  messageId: string,
  signerEmail?: string | null,
  lastSentAt?: string | null,
): Promise<Response> {
  const result = await getResendEmail(apiKey, messageId);
  if (!result.ok) return json({ ok: false, messageId, error: result.error }, 502);
  const e = result.email;
  return json({
    ok: true,
    status: "found",
    messageId,
    to: e?.to,
    from: e?.from,
    subject: e?.subject,
    // The whole point of the endpoint. Null means Resend has accepted it but reported no delivery
    // event yet — which is NOT the same as delivered and must never be rendered as such.
    lastEvent: e?.last_event ?? null,
    createdAt: e?.created_at ?? null,
    signerEmail: signerEmail ?? null,
    lastSentAt: lastSentAt ?? null,
  });
}
