// Client Portal Auth — contact-scoped portal authentication and invite dispatch.
//
// Replaces the per-project `portal-auth` function. Actions:
//   - send-invite             (service-role or authed admin) → email invite link
//   - send-code               (anon) → send 6-digit OTP to contact email
//   - verify-code             (anon) → validate OTP, return session token
//   - validate-session        (anon) → check session token, return contact info
//   - fetch-projects          (session) → all projects for the authed contact
//   - fetch-project           (session) → one project detail
//   - mark-step-up-verified   (session) → update last_otp_verified_at
//   - list-sessions           (session) → active sessions for device mgmt
//   - logout                  (session) → revoke current session + pending codes
//   - list-client-reviews / decide-client-review / add-client-review-comment
//                             (session) → "Ready for your review" (Approve / Request changes / comment)
//   - get-caio / get-caio-document
//                             (session) → read-only CAIO engagement (gates, approved docs, client-visible registers)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { loadOrgEmailDefaults, sendOrgEmail } from "../_shared/email-defaults.ts";
import { parseUuid, shapeCaioDocument, shapeCaioPortal } from "../_shared/caio-portal.ts";
import { CLIENT_VISIBLE_REVIEW_STATUSES, canTransition, clientDecisionStatus, parseClientDecision } from "../_shared/client-reviews.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// -----------------------------------------------------------------
// Helpers (lifted from portal-auth/index.ts)
// -----------------------------------------------------------------

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateSecureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Byte-wise equality that runs in time proportional to the input length
 * regardless of where the first mismatch occurs. Used for hash and secret
 * comparisons where a prefix-match timing leak would let an attacker
 * incrementally guess the value.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function generateOtpCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***@***.***";
  const masked = local.length <= 2
    ? local[0] + "***"
    : local[0] + "***" + local[local.length - 1];
  return `${masked}@${domain}`;
}

function deriveDeviceLabel(userAgent: string): string {
  if (/iPhone|iPad/.test(userAgent)) return "iOS Device";
  if (/Android/.test(userAgent)) return "Android Device";
  if (/Windows/.test(userAgent)) return "Windows Browser";
  if (/Mac/.test(userAgent)) return "Mac Browser";
  if (/Linux/.test(userAgent)) return "Linux Browser";
  return "Browser";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function isServiceRoleRequest(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // Without both sides present the length check below would let `Bearer ` (empty token) match an
  // unset key and grant service-role access.
  if (!token || !expected) return false;
  if (token.length !== expected.length) return false;
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function getAuthedUserOrgId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  try {
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { user }, error } = await anonClient.auth.getUser(token);
    if (error || !user) return null;
    const service = getServiceClient();
    const { data: userRow } = await service
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .maybeSingle();
    return userRow?.organization_id ?? null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------
// HMAC-signed invite token
// -----------------------------------------------------------------

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signInvitePayload(payload: object): Promise<string | null> {
  const secret = Deno.env.get("CLIENT_PORTAL_INVITE_HMAC_SECRET");
  if (!secret) {
    // HMAC secret not configured — return null so the invite link
    // goes to /client-portal without a signed token. The client will
    // just need to type their email manually on the login page.
    console.warn("[client-portal-auth] CLIENT_PORTAL_INVITE_HMAC_SECRET not set — invite links will not include a signed token");
    return null;
  }
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const sig = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${body}.${sig}`;
}

/** Invite links are emailed; anything older than this must go through the normal email login. */
const INVITE_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

async function verifyInvitePayload(
  token: string
): Promise<{ org_id: string; contact_id: string; iat: number } | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const secret = Deno.env.get("CLIENT_PORTAL_INVITE_HMAC_SECRET") || "";
    // `signInvitePayload` refuses to sign without the secret, so verifying without it can only
    // ever accept a token an attacker minted with the empty key.
    if (!secret) {
      console.error("[client-portal-auth] CLIENT_PORTAL_INVITE_HMAC_SECRET not set \u2014 rejecting invite token");
      return null;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expectedBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body)
    );
    const expected = Array.from(new Uint8Array(expectedBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!timingSafeEqualHex(expected, sig)) return null;
    const padded = body.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
    const parsed = JSON.parse(decoded) as { org_id?: string; contact_id?: string; iat?: number };
    if (!parsed.org_id || !parsed.contact_id || typeof parsed.iat !== "number") return null;
    if (Math.floor(Date.now() / 1000) - parsed.iat > INVITE_TOKEN_MAX_AGE_SECONDS) return null;
    return { org_id: parsed.org_id, contact_id: parsed.contact_id, iat: parsed.iat };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------
// Email templates
// -----------------------------------------------------------------

function buildInvitationEmailHtml(params: {
  clientName: string;
  projectName: string;
  orgName: string;
  portalUrl: string;
  supportEmail: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Welcome to your Client Portal</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="background:#ffffff;border-radius:12px;padding:48px 40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#2563eb;letter-spacing:0.05em;text-transform:uppercase;">${params.orgName}</p>
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#0f172a;line-height:1.3;">Your Client Portal is ready</h1>
          <p style="margin:0 0 12px;font-size:15px;color:#64748b;line-height:1.6;">Hi ${params.clientName},</p>
          <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
            You now have access to the client portal for your project <strong style="color:#0f172a;">${params.projectName}</strong>. From there you can track progress, submit change requests, open support tickets, and view shared documents.
          </p>
          <p style="margin:0 0 24px;font-size:15px;color:#64748b;line-height:1.6;">
            If you have more than one project with us, they will all appear in the same portal after you sign in.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${params.portalUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open Client Portal</a>
          </div>
          <p style="margin:0 0 24px;font-size:13px;color:#94a3b8;text-align:center;">
            When you open the portal you will be asked for a 6-digit verification code, which we will email to you.
          </p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px;">
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
            Need help? Contact us at <a href="mailto:${params.supportEmail}" style="color:#2563eb;text-decoration:none;">${params.supportEmail}</a>
          </p>
        </td></tr>
        <tr><td style="padding:20px 0;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">This is a transactional email sent on behalf of ${params.orgName}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildOtpEmailHtml(params: {
  clientName: string;
  orgName: string;
  code: string;
  expirationMinutes: number;
  supportEmail: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your Verification Code</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="background:#ffffff;border-radius:12px;padding:48px 40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#2563eb;letter-spacing:0.05em;text-transform:uppercase;">${params.orgName}</p>
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;line-height:1.3;">Verify Your Access</h1>
          <p style="margin:0 0 32px;font-size:15px;color:#64748b;line-height:1.6;">
            Hi ${params.clientName}, use the code below to sign in to the client portal.
          </p>
          <div style="background:#f1f5f9;border-radius:10px;padding:28px;text-align:center;margin-bottom:32px;">
            <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;">Verification Code</p>
            <p style="margin:0;font-size:42px;font-weight:700;color:#0f172a;letter-spacing:0.2em;font-family:'Courier New',monospace;">${params.code}</p>
          </div>
          <p style="margin:0 0 24px;font-size:13px;color:#94a3b8;text-align:center;">
            This code expires in <strong style="color:#64748b;">${params.expirationMinutes} minutes</strong>. Do not share it with anyone.
          </p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 24px;">
          <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
            If you did not request this code, you can safely ignore this email.<br><br>
            Need help? Contact us at <a href="mailto:${params.supportEmail}" style="color:#2563eb;text-decoration:none;">${params.supportEmail}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// -----------------------------------------------------------------
// Internal: send email via Resend directly (same pattern as the
// original portal-auth edge function). This is more reliable than
// routing through the email-send function because it avoids auth
// context issues with internal edge-function-to-edge-function calls.
// -----------------------------------------------------------------

async function sendTransactionalEmail(
  supabase: SupabaseClient,
  orgId: string,
  params: {
    toEmail: string;
    toName?: string;
    subject: string;
    htmlBody: string;
    /** The client contact: picks the brand sender (contacts.brand). */
    contactId?: string | null;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const creds = getResendEnvCreds();
    if (!creds) {
      return { success: false, error: "Mailgun credentials not configured" };
    }

    // Org Email Services Defaults (from address, reply-to). Sign-in codes / invites are
    // transactional: no unsubscribe link, never blocked by a marketing suppression.
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    const defaults = await loadOrgEmailDefaults(supabase, orgId);

    // From: the org's default From Address, else the platform's verified Resend sender
    // (never organizations.email, which is usually not on a verified Resend domain).
    const sendRes = await sendOrgEmail(supabase, orgId, {
      fromName: defaults.fromName ?? org?.name ?? "Client Portal",
      contactId: params.contactId ?? null,
      to: params.toEmail,
      toName: params.toName,
      subject: params.subject,
      html: params.htmlBody,
      transactional: true,
      categories: ["client_portal"],
      defaults,
    });

    if (!sendRes.ok) {
      console.error(`[client-portal-auth] Resend ${sendRes.status}: ${sendRes.error}`);
      // Error string kept verbatim for response-shape compatibility.
      return { success: false, error: `Mailgun error ${sendRes.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("[client-portal-auth] sendTransactionalEmail error:", err);
    return { success: false, error: String(err) };
  }
}

// -----------------------------------------------------------------
// Org resolution (shared by send-code / verify-code / send-invite)
// -----------------------------------------------------------------

async function getOrgInfo(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ name: string; supportEmail: string }> {
  const { data: org } = await supabase
    .from("organizations")
    .select("name, email")
    .eq("id", orgId)
    .maybeSingle();
  return {
    name: org?.name ?? "Client Portal",
    supportEmail: org?.email ?? Deno.env.get("RESEND_FROM_EMAIL") ?? "",
  };
}

async function resolveContactByEmail(
  supabase: SupabaseClient,
  email: string,
  orgId: string | null
): Promise<{ id: string; organization_id: string; first_name: string | null; last_name: string | null; email: string } | null> {
  // TODO(multi-tenant, codex finding #15): when the same email exists as a contact in
  // more than one organization, this email-only lookup binds the OTP/session to
  // whichever row was updated most recently — the other org's portal becomes
  // unreachable except via its signed invite link. Single-tenant today so this
  // cannot fire, but a real fix needs an org selector in the login flow (or
  // org-scoped login URLs). Until then: keep the ordering deterministic
  // (updated_at desc) and log loudly when the ambiguity actually occurs.
  let query = supabase
    .from("contacts")
    .select("id, organization_id, first_name, last_name, email, merged_into_contact_id")
    .ilike("email", email)
    .order("updated_at", { ascending: false })
    .limit(5);
  if (orgId) query = query.eq("organization_id", orgId);
  const { data: rows } = await query;
  const data = rows?.[0];
  if (!data) return null;

  const distinctOrgs = new Set((rows ?? []).map((r: { organization_id: string }) => r.organization_id));
  if (distinctOrgs.size > 1) {
    console.warn(
      `[client-portal-auth] email ${maskEmail(email)} matches contacts in ${distinctOrgs.size} organizations — binding to most recently updated (org ${data.organization_id}). Other orgs' portals are unreachable by email login.`,
    );
  }

  // Follow a merge pointer so signing in with a merged-away contact's email lands
  // on the surviving contact. Without this, duplicate contacts split a person in
  // two: the session bound to one row while their projects lived on the other,
  // and the portal dashboard came up empty (the exact bug reported 2026-08-24 —
  // two clients' projects sat on duplicate contact rows). One hop only;
  // merge chains are collapsed at merge time, not followed here.
  if ((data as any).merged_into_contact_id) {
    const { data: survivor } = await supabase
      .from("contacts")
      .select("id, organization_id, first_name, last_name, email")
      .eq("id", (data as any).merged_into_contact_id)
      .maybeSingle();
    if (survivor) return survivor as any;
  }
  return data as any;
}

async function resolveSessionContact(
  supabase: SupabaseClient,
  sessionToken: string
): Promise<{
  session_id: string;
  contact_id: string;
  org_id: string;
  last_otp_verified_at: string | null;
  expires_at: string;
} | null> {
  if (!sessionToken) return null;
  const tokenHash = await sha256(sessionToken);
  const { data: session } = await supabase
    .from("client_portal_sessions")
    .select("id, contact_id, org_id, last_otp_verified_at, expires_at, revoked_at")
    .eq("session_token_hash", tokenHash)
    .maybeSingle();
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;

  // A revoked ACCOUNT must kill live sessions too, not only future logins.
  // Before this check, staff revoking a compromised account left every
  // already-issued session (up to 30 days) fully working. (Codex finding #3.)
  if (await isAccountRevoked(supabase, session.org_id, session.contact_id)) return null;

  return {
    session_id: session.id,
    contact_id: session.contact_id,
    org_id: session.org_id,
    last_otp_verified_at: session.last_otp_verified_at,
    expires_at: session.expires_at,
  };
}

/**
 * True when the (org, contact) portal account exists and is revoked. A missing
 * account row is NOT revoked — send-code auto-creates accounts for known
 * contacts, so absence means "never provisioned", not "banned".
 */
async function isAccountRevoked(
  supabase: SupabaseClient,
  orgId: string,
  contactId: string
): Promise<boolean> {
  const { data: account } = await supabase
    .from("client_portal_accounts")
    .select("status")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .maybeSingle();
  return account?.status === "revoked";
}

// -----------------------------------------------------------------
// Action: send-invite
// -----------------------------------------------------------------

async function handleSendInvite(
  supabase: SupabaseClient,
  req: Request,
  payload: { projectId?: string; contactId?: string }
): Promise<Response> {
  if (!payload.projectId) return json({ error: "Missing projectId" }, 400);

  const authedOrgId = await getAuthedUserOrgId(req);
  const isServiceRole = isServiceRoleRequest(req);
  const isAuthedAdmin = authedOrgId !== null;

  if (!isServiceRole && !isAuthedAdmin) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Load project with contact info
  const { data: project } = await supabase
    .from("projects")
    .select("id, org_id, name, status, contact_id, contact:contacts(id, first_name, last_name, email)")
    .eq("id", payload.projectId)
    .maybeSingle();

  if (!project) return json({ error: "Project not found" }, 404);

  if (isAuthedAdmin && authedOrgId !== project.org_id) {
    return json({ error: "Forbidden" }, 403);
  }

  // Don't invite someone to a project they'll never see. The portal dashboard
  // (fetch-projects) hides `archived` projects, so an invite to one lands the
  // client on a permanently-empty dashboard — the "some clients see no projects"
  // report traced back to invites that outlived their project. Auto-invites
  // (service role, e.g. FRIDAY) are silently skipped so a mirror pass can't
  // resurrect the invite; a human admin gets a clear error to act on.
  if (project.status === "archived") {
    console.warn(`[client-portal-auth] send-invite refused for project ${project.id}: status=archived`);
    if (isServiceRole && !isAuthedAdmin) {
      return json({ success: true, skipped: true, skippedReason: "project_archived" });
    }
    return json({ error: "This project is archived — the client can't see it in the portal. Restore the project before inviting them." }, 409);
  }

  let contact = (project.contact as unknown) as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;

  // Multi-POC: an explicit contactId invites an ADDITIONAL member instead of the
  // primary. It must already be granted on this project (project_contacts, which
  // mirrors the primary in) — an invite can never be a back door onto a project
  // the contact was not given.
  if (payload.contactId && payload.contactId !== contact?.id) {
    const { data: membership } = await supabase
      .from("project_contacts")
      .select("contact_id, contact:contacts(id, first_name, last_name, email)")
      .eq("project_id", project.id)
      .eq("contact_id", payload.contactId)
      .maybeSingle();
    if (!membership) {
      return json({ error: "Contact is not a member of this project — add them first" }, 400);
    }
    contact = (membership.contact as unknown) as typeof contact;
  }

  if (!contact || !contact.email) {
    console.warn(`[client-portal-auth] send-invite skipped for project ${project.id}: no contact email`);
    return json({ success: true, skipped: true, skippedReason: "no_contact_email" });
  }

  // Upsert the portal account
  const { data: existingAccount } = await supabase
    .from("client_portal_accounts")
    .select("id, invite_sent_at, invite_count")
    .eq("org_id", project.org_id)
    .eq("contact_id", contact.id)
    .maybeSingle();

  // Throttle: auto-invites (service role) are capped at 1 per 24 hours per (org, contact).
  if (isServiceRole && !isAuthedAdmin && existingAccount?.invite_sent_at) {
    const last = new Date(existingAccount.invite_sent_at).getTime();
    if (Date.now() - last < 24 * 60 * 60 * 1000) {
      return json({ success: true, skipped: true, skippedReason: "throttled" });
    }
  }

  let accountId: string;
  if (existingAccount) {
    accountId = existingAccount.id;
    await supabase
      .from("client_portal_accounts")
      .update({
        status: "active",
        invite_sent_at: new Date().toISOString(),
        invite_count: (existingAccount.invite_count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", accountId);
  } else {
    const { data: created, error: insertError } = await supabase
      .from("client_portal_accounts")
      .insert({
        org_id: project.org_id,
        contact_id: contact.id,
        status: "active",
        invite_sent_at: new Date().toISOString(),
        invite_count: 1,
      })
      .select("id")
      .single();
    if (insertError || !created) {
      return json({ error: "Failed to create portal account", details: insertError?.message }, 500);
    }
    accountId = created.id;
  }

  // Build invite link (with signed token if HMAC secret is configured)
  const inviteToken = await signInvitePayload({
    org_id: project.org_id,
    contact_id: contact.id,
    iat: Math.floor(Date.now() / 1000),
  });
  // The app's public URL: APP_BASE_URL, else the origin the invite was sent from (no vendor default).
  const appBase = (Deno.env.get("APP_BASE_URL") ?? req.headers.get("origin") ?? "").replace(/\/+$/, "");
  if (!appBase) return json({ error: "APP_BASE_URL is not configured" }, 500);
  const portalUrl = inviteToken
    ? `${appBase}/client-portal?invite=${encodeURIComponent(inviteToken)}`
    : `${appBase}/client-portal`;

  const orgInfo = await getOrgInfo(supabase, project.org_id);
  const clientName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "there";

  const htmlBody = buildInvitationEmailHtml({
    clientName,
    projectName: project.name,
    orgName: orgInfo.name,
    portalUrl,
    supportEmail: orgInfo.supportEmail,
  });

  const emailResult = await sendTransactionalEmail(supabase, project.org_id, {
    toEmail: contact.email,
    toName: clientName,
    subject: `Your client portal for ${project.name}`,
    htmlBody,
    contactId: (contact as { id?: string }).id ?? project.contact_id ?? null,
  });

  if (!emailResult.success) {
    console.error(`[client-portal-auth] send-invite failed for project ${project.id}: ${emailResult.error}`);
    return json({ success: false, error: emailResult.error }, 500);
  }

  await supabase.from("client_portal_events").insert({
    org_id: project.org_id,
    account_id: accountId,
    contact_id: contact.id,
    project_id: project.id,
    event_type: "invite_sent",
    metadata: { project_name: project.name, throttle_bypassed: isAuthedAdmin },
  });

  return json({ success: true });
}

// -----------------------------------------------------------------
// Action: send-code
// -----------------------------------------------------------------

async function handleSendCode(
  supabase: SupabaseClient,
  req: Request,
  payload: { email?: string; inviteToken?: string }
): Promise<Response> {
  // Default masked response — we always return this on success or invalid email.
  const maskedResponse = (email: string) =>
    json({
      success: true,
      maskedEmail: maskEmail(email),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

  let contactId: string | null = null;
  let orgId: string | null = null;
  let email: string | null = null;

  // Invite-token takes precedence
  if (payload.inviteToken) {
    const decoded = await verifyInvitePayload(payload.inviteToken);
    if (decoded) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("id, organization_id, email")
        .eq("id", decoded.contact_id)
        .eq("organization_id", decoded.org_id)
        .maybeSingle();
      if (contact?.email) {
        contactId = contact.id;
        orgId = contact.organization_id;
        email = contact.email;
      }
    }
  }

  // Fallback: email lookup
  if (!contactId && payload.email) {
    const contact = await resolveContactByEmail(supabase, payload.email, null);
    if (contact) {
      contactId = contact.id;
      orgId = contact.organization_id;
      email = contact.email;
    }
  }

  if (!contactId || !orgId || !email) {
    // Return masked success regardless to prevent enumeration.
    return maskedResponse(payload.email ?? "unknown@example.com");
  }

  // Per-IP send throttle: cap OTP sends per source IP per window. Enumerated
  // in F-39 - without this, an attacker who knows any set of real contact
  // emails can spam OTP mails at the per-contact 60s limit by cycling through
  // contacts from a single IP.  Reuses client_portal_events (which we already
  // write ip_address to below) as the throttle ledger, so no new table.
  const requestIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || null;
  const IP_WINDOW_MIN = 15;
  const IP_MAX_SENDS = 10;
  if (requestIp) {
    const since = new Date(Date.now() - IP_WINDOW_MIN * 60_000).toISOString();
    const { count: recentIpSends } = await supabase
      .from("client_portal_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "otp_sent")
      .eq("ip_address", requestIp)
      .gt("created_at", since);
    if ((recentIpSends ?? 0) >= IP_MAX_SENDS) {
      console.warn(`[client-portal-auth] IP throttle hit: ${requestIp} sent ${recentIpSends} codes in ${IP_WINDOW_MIN}m`);
      return json({ success: false, rateLimited: true, maskedEmail: maskEmail(email) }, 200);
    }
  }

  // Ensure a portal account exists. If the contact exists in the DB but
  // was never formally invited (no client_portal_accounts row), auto-create
  // one so the OTP flow works. This lets any contact who knows their email
  // sign in without waiting for an admin-triggered invite.
  let portalAccountId: string;
  const { data: existingAccount } = await supabase
    .from("client_portal_accounts")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .maybeSingle();

  // Revoked accounts must not receive codes. Before this check, "revoked" only
  // gated nothing: the contact could request a fresh OTP and mint a brand-new
  // 30-day session immediately after staff revoked them. Respond with the same
  // masked success as an unknown email so revocation isn't probeable from the
  // login form. (Codex finding #3; re-inviting via send-invite un-revokes.)
  if (existingAccount?.status === "revoked") {
    console.warn(`[client-portal-auth] send-code refused: account revoked (org ${orgId}, contact ${contactId})`);
    return maskedResponse(email);
  }

  if (existingAccount) {
    portalAccountId = existingAccount.id;
  } else {
    const { data: newAccount, error: createErr } = await supabase
      .from("client_portal_accounts")
      .insert({ org_id: orgId, contact_id: contactId, status: "active" })
      .select("id")
      .single();
    if (createErr || !newAccount) {
      console.error("[client-portal-auth] Failed to auto-create portal account:", createErr?.message);
      return maskedResponse(email);
    }
    portalAccountId = newAccount.id;
  }

  // Per-contact rate limits: 60-second minimum spacing AND an hourly cap. The
  // existing 60s spacing prevents rapid-fire per contact but leaves a
  // theoretical 60 sends/hour ceiling per contact = 1440/day. The hourly cap
  // makes the ceiling per contact match the per-IP cap.
  const PER_CONTACT_HOURLY_CAP = 6;
  const { data: recentContactCodes } = await supabase
    .from("client_portal_auth_codes")
    .select("created_at")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .gt("created_at", new Date(Date.now() - 60 * 60_000).toISOString())
    .order("created_at", { ascending: false });

  if ((recentContactCodes?.length ?? 0) >= PER_CONTACT_HOURLY_CAP) {
    return json({ success: false, rateLimited: true, maskedEmail: maskEmail(email) }, 200);
  }
  if (recentContactCodes?.[0] && Date.now() - new Date(recentContactCodes[0].created_at).getTime() < 60_000) {
    return json({ success: false, rateLimited: true, maskedEmail: maskEmail(email) }, 200);
  }

  // Invalidate any prior pending codes for this contact
  await supabase
    .from("client_portal_auth_codes")
    .update({ invalidated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .is("consumed_at", null)
    .is("invalidated_at", null);

  // Generate + store
  const code = generateOtpCode();
  const codeHash = await sha256(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data: codeRow, error: insertErr } = await supabase
    .from("client_portal_auth_codes")
    .insert({
      org_id: orgId,
      contact_id: contactId,
      code_hash: codeHash,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (insertErr || !codeRow) {
    return json({ error: "Failed to create auth code" }, 500);
  }

  // Send OTP email
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("first_name, last_name")
    .eq("id", contactId)
    .maybeSingle();

  const orgInfo = await getOrgInfo(supabase, orgId);
  const clientName = `${contactRow?.first_name ?? ""} ${contactRow?.last_name ?? ""}`.trim() || "there";

  const htmlBody = buildOtpEmailHtml({
    clientName,
    orgName: orgInfo.name,
    code,
    expirationMinutes: 10,
    supportEmail: orgInfo.supportEmail,
  });

  const emailResult = await sendTransactionalEmail(supabase, orgId, {
    toEmail: email,
    toName: clientName,
    subject: `Your ${orgInfo.name} portal verification code`,
    htmlBody,
    contactId,
  });

  // A failed send must not masquerade as success: the client would sit waiting
  // for a code that never left, and each blind retry would eat into the hourly
  // send caps until they were locked out entirely. Delete the code row so the
  // failed attempt doesn't count against the per-contact throttle (which counts
  // code rows), and say honestly that the email didn't go out. No otp_sent
  // event either — the per-IP throttle counts those. (Codex finding #14.)
  if (!emailResult.success) {
    console.error(`[client-portal-auth] OTP email send failed for contact ${contactId}: ${emailResult.error}`);
    await supabase.from("client_portal_auth_codes").delete().eq("id", codeRow.id);
    return json({ success: false, error: "email_send_failed", maskedEmail: maskEmail(email) }, 502);
  }

  await supabase.from("client_portal_events").insert({
    org_id: orgId,
    account_id: portalAccountId,
    contact_id: contactId,
    event_type: "otp_sent",
    metadata: {},
    ip_address: requestIp,
    user_agent: req.headers.get("user-agent") ?? null,
  });

  return maskedResponse(email);
}

// -----------------------------------------------------------------
// Action: verify-code
// -----------------------------------------------------------------

async function handleVerifyCode(
  supabase: SupabaseClient,
  req: Request,
  payload: { email?: string; code?: string; rememberDevice?: boolean; inviteToken?: string; sessionToken?: string }
): Promise<Response> {
  if (!payload.code || payload.code.length !== 6) {
    return json({ success: false, error: "Invalid code format" }, 400);
  }

  // Per-IP verify throttle. Even with per-code max_attempts, an attacker can
  // request a new code and try again - so cap failed verifies per IP per
  // window. Counts session_created (success) OR otp_verify_failed events on
  // this IP. Under the cap, verify still proceeds; over it, refuse.
  const requestIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || null;
  const VERIFY_WINDOW_MIN = 60;
  const VERIFY_IP_MAX_FAILS = 20;
  if (requestIp) {
    const since = new Date(Date.now() - VERIFY_WINDOW_MIN * 60_000).toISOString();
    const { count: recentIpFails } = await supabase
      .from("client_portal_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "otp_verify_failed")
      .eq("ip_address", requestIp)
      .gt("created_at", since);
    if ((recentIpFails ?? 0) >= VERIFY_IP_MAX_FAILS) {
      console.warn(`[client-portal-auth] verify IP throttle hit: ${requestIp} had ${recentIpFails} fails in ${VERIFY_WINDOW_MIN}m`);
      return json({ success: false, rateLimited: true, error: "Too many attempts" }, 401);
    }
  }

  // Resolve contact the same way as send-code
  let contactId: string | null = null;
  let orgId: string | null = null;

  if (payload.inviteToken) {
    const decoded = await verifyInvitePayload(payload.inviteToken);
    if (decoded) {
      contactId = decoded.contact_id;
      orgId = decoded.org_id;
    }
  }
  if (!contactId && payload.email) {
    const contact = await resolveContactByEmail(supabase, payload.email, null);
    if (contact) {
      contactId = contact.id;
      orgId = contact.organization_id;
    }
  }

  if (!contactId || !orgId) {
    return json({ success: false, error: "Invalid credentials" }, 401);
  }

  // A code issued moments before staff revoked the account must not still be
  // redeemable for a fresh session. (Codex finding #3.)
  if (await isAccountRevoked(supabase, orgId, contactId)) {
    return json({ success: false, error: "Invalid credentials" }, 401);
  }

  // Find the most recent non-consumed, non-invalidated, non-expired code
  const { data: authCode } = await supabase
    .from("client_portal_auth_codes")
    .select("id, code_hash, expires_at, attempts, max_attempts")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .is("consumed_at", null)
    .is("invalidated_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!authCode) {
    return json({ success: false, error: "No active code. Request a new one." }, 401);
  }

  if (authCode.attempts >= authCode.max_attempts) {
    await supabase
      .from("client_portal_auth_codes")
      .update({ invalidated_at: new Date().toISOString() })
      .eq("id", authCode.id);
    return json({ success: false, maxAttemptsExceeded: true, error: "Too many attempts" }, 401);
  }

  // Atomically claim an attempt BEFORE comparing. The old read-compare-write
  // sequence let N concurrent guesses all read the same count and all write
  // count+1 — a parallel burst spent one attempt from the 5-attempt budget, so
  // max_attempts bounded nothing. The SECURITY DEFINER RPC does a single
  // `attempts = attempts + 1 ... RETURNING`, so concurrent requests serialize
  // on the row and each one consumes a real attempt. (Codex finding #5;
  // migration 20260824221000.)
  const { data: bumpRows, error: bumpErr } = await supabase.rpc("portal_otp_bump_attempts", {
    p_code_id: authCode.id,
  });
  const bump = (Array.isArray(bumpRows) ? bumpRows[0] : bumpRows) as
    | { new_attempts: number; code_max_attempts: number }
    | null
    | undefined;
  if (bumpErr || !bump) {
    // Code was consumed/invalidated/expired between the read and the bump.
    return json({ success: false, error: "No active code. Request a new one." }, 401);
  }
  if (bump.new_attempts > bump.code_max_attempts) {
    await supabase
      .from("client_portal_auth_codes")
      .update({ invalidated_at: new Date().toISOString() })
      .eq("id", authCode.id);
    return json({ success: false, maxAttemptsExceeded: true, error: "Too many attempts" }, 401);
  }

  const expectedHash = await sha256(payload.code);
  // Constant-time hash compare. The two strings are always the same length
  // (both hex-encoded SHA-256 = 64 chars) so `!==` was already length-safe,
  // but the byte-wise compare avoids leaking prefix-match timing.
  if (!constantTimeStringEqual(expectedHash, authCode.code_hash)) {
    // Log the failed attempt so per-IP throttling can count it on the next request.
    await supabase.from("client_portal_events").insert({
      org_id: orgId,
      contact_id: contactId,
      event_type: "otp_verify_failed",
      metadata: { code_id: authCode.id, attempts: bump.new_attempts },
      ip_address: requestIp,
      user_agent: req.headers.get("user-agent") ?? null,
    });
    const remaining = Math.max(0, bump.code_max_attempts - bump.new_attempts);
    return json({ success: false, attemptsRemaining: remaining, error: "Incorrect code" }, 401);
  }

  // Consume the code. Conditional on "not yet consumed" so two concurrent
  // correct submissions can't both redeem it — only the one that wins the
  // update proceeds.
  const { data: consumed } = await supabase
    .from("client_portal_auth_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", authCode.id)
    .is("consumed_at", null)
    .select("id");
  if (!consumed || consumed.length === 0) {
    return json({ success: false, error: "No active code. Request a new one." }, 401);
  }

  // Step-up mode: when the caller already holds a valid session for this same
  // contact, the freshly verified OTP stamps THAT session's last_otp_verified_at
  // instead of minting a new session. This is what makes step-up real — the
  // stamp only ever moves on an actual OTP verification, never on an
  // unauthenticated claim. (Codex finding #4.)
  if (payload.sessionToken) {
    const existing = await resolveSessionContact(supabase, payload.sessionToken);
    if (existing && existing.contact_id === contactId && existing.org_id === orgId) {
      const stampNow = new Date().toISOString();
      await supabase
        .from("client_portal_sessions")
        .update({ last_otp_verified_at: stampNow })
        .eq("id", existing.session_id);
      return json({
        success: true,
        stepUp: true,
        sessionId: existing.session_id,
        lastOtpVerifiedAt: stampNow,
        expiresAt: existing.expires_at,
      });
    }
  }

  // Create a session
  const sessionToken = generateSecureToken();
  const sessionHash = await sha256(sessionToken);
  const ttlMs = payload.rememberDevice ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const userAgent = req.headers.get("user-agent") ?? "";
  const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const { data: sessionRow, error: sessionErr } = await supabase
    .from("client_portal_sessions")
    .insert({
      org_id: orgId,
      contact_id: contactId,
      session_token_hash: sessionHash,
      remember_device: !!payload.rememberDevice,
      expires_at: expiresAt,
      last_otp_verified_at: new Date().toISOString(),
      ip_address: ipAddress,
      user_agent: userAgent,
    })
    .select("id")
    .single();

  if (sessionErr || !sessionRow) {
    return json({ success: false, error: "Failed to create session" }, 500);
  }

  // Update account last_login_at
  const { data: account } = await supabase
    .from("client_portal_accounts")
    .update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .select("id")
    .maybeSingle();

  if (account) {
    await supabase.from("client_portal_events").insert({
      org_id: orgId,
      account_id: account.id,
      contact_id: contactId,
      event_type: "session_created",
      metadata: { remember_device: !!payload.rememberDevice, device_label: deriveDeviceLabel(userAgent) },
      ip_address: ipAddress,
      user_agent: userAgent,
    });
  }

  return json({
    success: true,
    sessionToken,
    sessionId: sessionRow.id,
    expiresAt,
  });
}

// -----------------------------------------------------------------
// Action: validate-session
// -----------------------------------------------------------------

async function handleValidateSession(
  supabase: SupabaseClient,
  payload: { sessionToken?: string }
): Promise<Response> {
  if (!payload.sessionToken) return json({ valid: false }, 200);
  const session = await resolveSessionContact(supabase, payload.sessionToken);
  if (!session) return json({ valid: false }, 200);

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email")
    .eq("id", session.contact_id)
    .maybeSingle();

  const orgInfo = await getOrgInfo(supabase, session.org_id);

  return json({
    valid: true,
    sessionId: session.session_id,
    contactId: session.contact_id,
    contactName: `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim(),
    contactEmail: contact?.email ?? null,
    orgId: session.org_id,
    orgName: orgInfo.name,
    supportEmail: orgInfo.supportEmail,
    lastOtpVerifiedAt: session.last_otp_verified_at,
    expiresAt: session.expires_at,
  });
}

// -----------------------------------------------------------------
// Action: fetch-projects
// -----------------------------------------------------------------

async function handleFetchProjects(
  supabase: SupabaseClient,
  payload: { sessionToken?: string }
): Promise<Response> {
  const session = await resolveSessionContact(supabase, payload.sessionToken ?? "");
  if (!session) return json({ error: "Unauthorized" }, 401);

  // All projects the contact is a member of (project_contacts includes the
  // primary contact via trigger), plus a direct contact_id match as a safety
  // net for any row created before the membership backfill.
  const { data: memberRows } = await supabase
    .from("project_contacts")
    .select("project_id")
    .eq("org_id", session.org_id)
    .eq("contact_id", session.contact_id);
  const memberIds = (memberRows ?? []).map((r: { project_id: string }) => r.project_id);

  let query = supabase
    .from("projects")
    .select(
      "id, org_id, name, description, status, priority, start_date, target_end_date, progress_percent, budget_amount, currency, stage_id, pipeline_id, contact_id, created_at, stage:project_stages(id, name, sort_order, color)"
    )
    .eq("org_id", session.org_id)
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  query = memberIds.length > 0
    ? query.or(`contact_id.eq.${session.contact_id},id.in.(${memberIds.join(",")})`)
    : query.eq("contact_id", session.contact_id);
  const { data: projects, error } = await query;

  if (error) {
    console.error("[client-portal-auth] fetch-projects query failed:", error);
    return json({ error: "Failed to load projects", details: error.message }, 500);
  }

  return json({ success: true, projects: projects ?? [] });
}

// -----------------------------------------------------------------
// Action: fetch-project
// -----------------------------------------------------------------

async function handleFetchProject(
  supabase: SupabaseClient,
  payload: { sessionToken?: string; projectId?: string }
): Promise<Response> {
  if (!payload.projectId) return json({ error: "Missing projectId" }, 400);
  const session = await resolveSessionContact(supabase, payload.sessionToken ?? "");
  if (!session) return json({ error: "Unauthorized" }, 401);

  // Authorization is the membership check; the row fetch must not re-filter on
  // contact_id or added POCs would 404 on a project they are members of.
  if (!(await contactOwnsProject(supabase, { contact_id: session.contact_id, org_id: session.org_id }, payload.projectId))) {
    return json({ error: "Project not found" }, 404);
  }
  const project = unwrap(await supabase
    .from("projects")
    .select(
      "*, stage:project_stages(id, name, sort_order, color), pipeline:project_pipelines(id, name), contact:contacts(id, first_name, last_name, email)"
    )
    .eq("id", payload.projectId)
    .eq("org_id", session.org_id)
    .maybeSingle(), "fetch-project query failed");

  if (!project) return json({ error: "Project not found" }, 404);

  const orgInfo = await getOrgInfo(supabase, session.org_id);

  // Everything the frontend project bridge needs, resolved HERE with the service
  // role. The bridge used to read projects/organizations/client_portal_accounts
  // directly with the anon client — every one of those reads died when F-41
  // dropped the anon policies (2026-07-30), so each project detail page showed
  // "Project not found" from that day on. The dashboard kept working because it
  // already went through this function. Reported by a client 2026-08-24.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("id, name, email, phone, website")
    .eq("id", session.org_id)
    .maybeSingle();

  let accountId: string | null = null;
  const { data: existingAccount } = await supabase
    .from("client_portal_accounts")
    .select("id")
    .eq("org_id", session.org_id)
    .eq("contact_id", session.contact_id)
    .maybeSingle();
  if (existingAccount) {
    accountId = existingAccount.id;
  } else {
    const { data: newAccount } = await supabase
      .from("client_portal_accounts")
      .insert({ org_id: session.org_id, contact_id: session.contact_id, status: "active" })
      .select("id")
      .single();
    accountId = newAccount?.id ?? null;
  }

  return json({
    success: true,
    project,
    orgName: orgInfo.name,
    supportEmail: orgInfo.supportEmail,
    organization: orgRow ?? null,
    accountId,
    contactId: session.contact_id,
  });
}

// -----------------------------------------------------------------
// Portal data actions (session-validated, service-role). These replace the V1 portal's
// direct anon reads/writes on project_change_requests / project_change_orders /
// project_support_tickets / *_comments so the token-blind anon RLS policies can be dropped.
// Every action authenticates the session AND authorizes the target row against the session's
// contact (a contact may only touch its own projects' data).
// -----------------------------------------------------------------

/**
 * Unwraps a Supabase result, throwing on failure so the entry point reports a 500 instead
 * of the caller treating a query error as "no rows" (empty data or a misleading 403).
 */
function unwrap<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

/** Returns true if the given project belongs to the session's contact + org. */
async function contactOwnsProject(supabase: SupabaseClient, session: { contact_id: string; org_id: string }, projectId: string): Promise<boolean> {
  // Membership model: a project is visible to its primary contact
  // (projects.contact_id, mirrored into project_contacts by trigger) and to any
  // additional POC in project_contacts. Companies routinely have several people
  // on one engagement (e.g. three people at one client company) and each signs in with
  // their own email; keying on the single contact_id locked all but one of them
  // out. The primary-contact check is kept alongside the membership lookup so a
  // missed backfill row can never revoke access the old model granted.
  const primary = unwrap(await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("org_id", session.org_id)
    .eq("contact_id", session.contact_id)
    .maybeSingle(), "project ownership lookup failed");
  if (primary) return true;

  // The membership row's own org_id is caller-supplied at insert time, so it is
  // NOT sufficient on its own: a forged row {org: A, contact: A, project: B}
  // would authorize A's contact into B's project. Verify the REFERENCED
  // project's org through the embed — the row only counts if the project it
  // points at actually belongs to the session's organization. (Codex review
  // finding #2, 2026-08-24; the INSERT policy is tightened in the same change.)
  const member = unwrap(await supabase
    .from("project_contacts")
    .select("id, project:projects!inner(org_id)")
    .eq("project_id", projectId)
    .eq("org_id", session.org_id)
    .eq("contact_id", session.contact_id)
    .eq("projects.org_id", session.org_id)
    .maybeSingle(), "project membership lookup failed");
  return !!member;
}

/** Resolve the project_id of a change request and confirm the session's contact owns it. */
async function contactOwnsChangeRequest(supabase: SupabaseClient, session: { contact_id: string; org_id: string }, requestId: string): Promise<boolean> {
  const data = unwrap(
    await supabase.from("project_change_requests").select("project_id").eq("id", requestId).maybeSingle(),
    "change request lookup failed",
  );
  return !!data?.project_id && (await contactOwnsProject(supabase, session, data.project_id as string));
}

async function contactOwnsTicket(supabase: SupabaseClient, session: { contact_id: string; org_id: string }, ticketId: string): Promise<boolean> {
  const data = unwrap(
    await supabase.from("project_support_tickets").select("project_id").eq("id", ticketId).maybeSingle(),
    "support ticket lookup failed",
  );
  return !!data?.project_id && (await contactOwnsProject(supabase, session, data.project_id as string));
}

/** Projects the contact can see: their own (projects.contact_id) plus any project_contacts POC. */
async function contactVisibleProjectIds(supabase: SupabaseClient, sess: { contact_id: string; org_id: string }): Promise<string[]> {
  const { data: memberRows } = await supabase
    .from("project_contacts").select("project_id, project:projects!inner(org_id)")
    .eq("org_id", sess.org_id).eq("contact_id", sess.contact_id).eq("projects.org_id", sess.org_id);
  const { data: ownRows } = await supabase
    .from("projects").select("id")
    .eq("org_id", sess.org_id).eq("contact_id", sess.contact_id);
  return [...new Set([
    ...((memberRows ?? []) as { project_id: string }[]).map((r) => r.project_id),
    ...((ownRows ?? []) as { id: string }[]).map((r) => r.id),
  ])];
}

interface ClientReviewRow { id: string; org_id: string; project_id: string; title: string; status: string }

async function loadClientReview(supabase: SupabaseClient, sess: { org_id: string }, id: string): Promise<ClientReviewRow | null> {
  if (!id) return null;
  const { data } = await supabase.from("client_reviews")
    .select("id, org_id, project_id, title, status").eq("id", id).eq("org_id", sess.org_id).maybeSingle();
  return (data as ClientReviewRow | null) ?? null;
}

/** Log a client's portal action into their conversation (inbound). Best-effort: never fails the action. */
async function logPortalInbound(
  supabase: SupabaseClient, sess: { contact_id: string; org_id: string }, review: ClientReviewRow,
  body: string, externalId: string, senderName: string,
): Promise<void> {
  try {
    const { error } = await supabase.rpc("conversation_log_message", {
      p_org: sess.org_id, p_channel: "portal", p_direction: "inbound", p_body: body,
      p_project_id: review.project_id, p_contact_id: sess.contact_id, p_subject: `Review: ${review.title}`.slice(0, 300),
      p_external_id: externalId, p_metadata: { source: "client_review", review_id: review.id }, p_sender_name: senderName,
    });
    if (error) console.warn("[client-portal-auth] review action not logged to conversations:", error.message);
  } catch (e) {
    console.warn("[client-portal-auth] review action not logged to conversations:", e);
  }
}

async function handlePortalData(
  supabase: SupabaseClient,
  action: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const session = await resolveSessionContact(supabase, String(payload.sessionToken ?? ""));
  if (!session) return json({ error: "Unauthorized" }, 401);
  const sess = { contact_id: session.contact_id, org_id: session.org_id };

  switch (action) {
    case "list-change-requests": {
      const projectId = String(payload.projectId ?? "");
      if (!(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);
      let q = supabase.from("project_change_requests")
        .select("*, change_orders:project_change_orders(*)")
        .eq("project_id", projectId).order("created_at", { ascending: false });
      const sf = payload.statusFilter as string[] | undefined;
      if (sf?.length) q = q.in("status", sf);
      const data = unwrap(await q, "list-change-requests failed");
      return json({ success: true, data: data ?? [] });
    }
    case "get-change-request": {
      const id = String(payload.requestId ?? "");
      if (!(await contactOwnsChangeRequest(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const data = unwrap(await supabase.from("project_change_requests")
        .select("*, change_orders:project_change_orders(*)").eq("id", id).maybeSingle(), "get-change-request failed");
      return json({ success: true, data: data ?? null });
    }
    case "list-change-request-comments": {
      const id = String(payload.changeRequestId ?? "");
      if (!(await contactOwnsChangeRequest(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const data = unwrap(await supabase.from("project_change_request_comments")
        .select("*").eq("change_request_id", id).eq("client_visible", true).order("created_at", { ascending: true }), "list-change-request-comments failed");
      return json({ success: true, data: data ?? [] });
    }
    case "list-support-tickets": {
      const projectId = String(payload.projectId ?? "");
      if (!(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);
      const data = unwrap(await supabase.from("project_support_tickets")
        .select("*").eq("project_id", projectId).order("created_at", { ascending: false }), "list-support-tickets failed");
      return json({ success: true, data: data ?? [] });
    }
    case "get-support-ticket": {
      const id = String(payload.ticketId ?? "");
      if (!(await contactOwnsTicket(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const data = unwrap(await supabase.from("project_support_tickets").select("*").eq("id", id).maybeSingle(), "get-support-ticket failed");
      return json({ success: true, data: data ?? null });
    }
    case "list-ticket-comments": {
      const id = String(payload.ticketId ?? "");
      if (!(await contactOwnsTicket(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const data = unwrap(await supabase.from("project_support_ticket_comments")
        .select("*").eq("ticket_id", id).eq("is_internal", false).order("created_at", { ascending: true }), "list-ticket-comments failed");
      return json({ success: true, data: data ?? [] });
    }
    case "list-project-activity": {
      const projectId = String(payload.projectId ?? "");
      if (!(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);
      // Client-safe whitelist only. project_overdue (internal SLA nagging) and
      // cost_added / financial events must never reach the portal feed.
      const CLIENT_VISIBLE_EVENTS = [
        "project_created", "stage_changed", "status_changed", "task_completed",
        "client_request_submitted", "client_request_completed",
        "change_request_submitted", "change_request_approved", "change_request_rejected",
        "milestone",
      ];
      const data = unwrap(await supabase.from("project_activity_log")
        .select("id, event_type, summary, payload, created_at")
        .eq("project_id", projectId)
        .in("event_type", CLIENT_VISIBLE_EVENTS)
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(payload.limit ?? 50) || 50, 200)), "list-project-activity failed");
      // Expose only the curated narrative fields from payload — the raw
      // payload of other event types carries internal ids and sources that must
      // never reach the portal (source, source_ref, shas stay server-side).
      const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
      const rows = (data ?? []).map((r: Record<string, unknown>) => {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        const sec = p.sections && typeof p.sections === "object" && !Array.isArray(p.sections)
          ? (p.sections as Record<string, unknown>)
          : null;
        return {
          id: r.id,
          event_type: r.event_type,
          summary: r.summary,
          created_at: r.created_at,
          title: str(p.title),
          detail: str(p.detail),
          sections: sec
            ? {
                context: str(sec.context),
                changes: str(sec.changes),
                impact: str(sec.impact),
                live_now: str(sec.live_now),
                check: Array.isArray(sec.check)
                  ? (sec.check.filter((x): x is string => typeof x === "string").slice(0, 5))
                  : [],
              }
            : null,
          is_live: typeof p.is_live === "boolean" ? p.is_live : null,
          kind: str(p.kind),
        };
      });
      return json({ success: true, data: rows });
    }
    case "approve-change-request":
    case "reject-change-request": {
      // Sensitive (billable) decisions require a RECENT OTP, not just session
      // possession — otherwise a stolen remember-device token is enough to
      // approve scope changes for a month. last_otp_verified_at only moves via
      // verify-code, so this check is backed by a real email round-trip.
      // Frontends already gate these behind PortalStepUpModal; this is the
      // server-side enforcement that was missing. (Codex finding #4.)
      const STEP_UP_WINDOW_MS = 30 * 60 * 1000;
      const verifiedAt = session.last_otp_verified_at ? new Date(session.last_otp_verified_at).getTime() : 0;
      if (Date.now() - verifiedAt > STEP_UP_WINDOW_MS) {
        return json({ error: "step_up_required" }, 403);
      }
      const id = String(payload.requestId ?? "");
      if (!(await contactOwnsChangeRequest(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const now = new Date().toISOString();
      const patch = action === "approve-change-request"
        ? { client_decision: "approved", status: "approved", approved_at: now, updated_at: now }
        : { client_decision: "declined", status: "rejected", rejected_at: now, updated_at: now };
      const { error } = await supabase.from("project_change_requests").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }
    case "list-release-approvals": {
      // Per-build sign-offs for the contact's projects. Same visibility rule as
      // fetch-projects: the contact's own projects plus any project_contacts POC.
      const { data: memberRows } = await supabase
        .from("project_contacts").select("project_id")
        .eq("org_id", session.org_id).eq("contact_id", session.contact_id);
      const memberIds = (memberRows ?? []).map((r: { project_id: string }) => r.project_id);
      const { data: ownRows } = await supabase
        .from("projects").select("id")
        .eq("org_id", session.org_id).eq("contact_id", session.contact_id);
      const visibleIds = [...new Set([...memberIds, ...((ownRows ?? []) as { id: string }[]).map((r) => r.id)])];
      if (visibleIds.length === 0) return json({ success: true, data: [] });
      const data = unwrap(await supabase.from("project_release_approvals")
        .select("id, project_id, title, changelog, status, created_at, client_decided_at")
        .in("project_id", visibleIds)
        .in("status", ["pending", "approved", "merged"])
        .order("created_at", { ascending: false })
        .limit(50), "list-release-approvals failed");
      return json({ success: true, data: data ?? [] });
    }
    case "decide-release-approval": {
      // Client sign-off on a specific build — a billable go-live decision, so it
      // requires a RECENT OTP just like change-request approvals.
      const STEP_UP_WINDOW_MS = 30 * 60 * 1000;
      const verifiedAt = session.last_otp_verified_at ? new Date(session.last_otp_verified_at).getTime() : 0;
      if (Date.now() - verifiedAt > STEP_UP_WINDOW_MS) return json({ error: "step_up_required" }, 403);
      const id = String(payload.approvalId ?? "");
      const decision = payload.decision === "approve" ? "approve" : payload.decision === "reject" ? "reject" : null;
      if (!id || !decision) return json({ error: "approvalId and decision required" }, 400);
      const { data: appr } = await supabase.from("project_release_approvals")
        .select("id, project_id, status").eq("id", id).maybeSingle();
      if (!appr) return json({ error: "Not found" }, 404);
      if (!(await contactOwnsProject(supabase, sess, appr.project_id as string))) return json({ error: "Forbidden" }, 403);
      // Only a still-pending build can be decided; merged/decided rows are terminal.
      if (appr.status !== "pending") return json({ error: "This build has already been decided." }, 409);
      const now = new Date().toISOString();
      const { error } = await supabase.from("project_release_approvals").update({
        status: decision === "approve" ? "approved" : "rejected",
        client_decided_at: now, client_decided_by: session.contact_id, updated_at: now,
      }).eq("id", id).eq("status", "pending");
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }
    // CAIO Delivery: read-only. Ids come from the request, org/contact only from the session.
    // A malformed or unowned project id gets the same 403, so existence is never revealed.
    case "get-caio":
    case "get-caio-document": {
      const projectId = parseUuid(payload.projectId);
      if (!projectId || !(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);
      if (action === "get-caio") {
        const { data, error } = await supabase.rpc("caio_portal_payload", { p_project: projectId });
        if (error) throw new Error(`caio_portal_payload failed: ${error.message}`);
        return json({ success: true, data: shapeCaioPortal(data) });
      }
      const documentId = parseUuid(payload.documentId);
      if (!documentId) return json({ error: "Not found" }, 404);
      const { data, error } = await supabase.rpc("caio_portal_document", { p_project: projectId, p_document: documentId });
      if (error) throw new Error(`caio_portal_document failed: ${error.message}`);
      const doc = shapeCaioDocument(data);
      if (!doc) return json({ error: "Not found" }, 404);
      return json({ success: true, data: doc });
    }

    // ── Client reviews ("Ready for your review": Approve / Request changes / comment) ──────
    // A review is feedback on delivered work, not a billable go-live or scope decision (those are
    // release approvals and change requests, which demand a recent OTP). A valid session is enough;
    // requiring step-up here would only add friction to "looks good" / "please change X".
    case "list-client-reviews": {
      const projectFilter = payload.projectId ? String(payload.projectId) : null;
      let visibleIds: string[];
      if (projectFilter) {
        if (!(await contactOwnsProject(supabase, sess, projectFilter))) return json({ error: "Forbidden" }, 403);
        visibleIds = [projectFilter];
      } else {
        visibleIds = await contactVisibleProjectIds(supabase, sess);
      }
      if (visibleIds.length === 0) return json({ success: true, data: [] });
      const reviews = unwrap(await supabase.from("client_reviews")
        .select("id, project_id, title, summary, preview_url, round, status, client_comment, decided_at, created_at, updated_at")
        .eq("org_id", sess.org_id)
        .in("project_id", visibleIds)
        .in("status", CLIENT_VISIBLE_REVIEW_STATUSES)
        .order("created_at", { ascending: false })
        .limit(50), "list-client-reviews failed") as Array<Record<string, unknown>> | null;
      const ids = (reviews ?? []).map((r) => r.id as string);
      const comments = ids.length
        ? (unwrap(await supabase.from("client_review_comments")
          .select("id, review_id, author_type, author_name, body, created_at")
          .in("review_id", ids)
          .order("created_at", { ascending: true }), "list-client-review-comments failed") as Array<Record<string, unknown>> | null) ?? []
        : [];
      const data = (reviews ?? []).map((r) => ({
        ...r,
        comments: comments.filter((c) => c.review_id === r.id).map((c) => ({
          id: c.id, author_type: c.author_type, author_name: c.author_name, body: c.body, created_at: c.created_at,
        })),
      }));
      return json({ success: true, data });
    }
    case "decide-client-review": {
      const id = String(payload.reviewId ?? "");
      const decision = parseClientDecision(payload.decision);
      const comment = String(payload.comment ?? "").trim().slice(0, 10000);
      if (!id || !decision) return json({ error: "reviewId and decision ('approve' or 'request_changes') required" }, 400);
      if (decision === "request_changes" && !comment) return json({ error: "Tell us what should change." }, 400);
      const review = await loadClientReview(supabase, sess, id);
      if (!review) return json({ error: "Not found" }, 404);
      if (!(await contactOwnsProject(supabase, sess, review.project_id))) return json({ error: "Forbidden" }, 403);
      const to = clientDecisionStatus(decision);
      if (review.status !== "pending" || !canTransition(review.status, to)) {
        return json({ error: "This review has already been decided." }, 409);
      }
      const now = new Date().toISOString();
      const { data: updated, error } = await supabase.from("client_reviews").update({
        status: to, client_comment: comment || null, decided_by_contact_id: sess.contact_id, decided_at: now,
      }).eq("id", id).eq("status", "pending").select("id");
      if (error) return json({ error: error.message }, 500);
      if (!updated || updated.length === 0) return json({ error: "This review has already been decided." }, 409);
      const contact = await getSessionContactRow(supabase, sess);
      if (comment) {
        await supabase.from("client_review_comments").insert({
          org_id: sess.org_id, review_id: id, author_type: "client", author_name: contact.name,
          author_contact_id: sess.contact_id, body: comment,
        }).then(({ error: e }) => { if (e) console.error("[client-portal-auth] review comment not saved:", e.message); });
      }
      const verdict = decision === "approve" ? "Approved" : "Requested changes";
      await logPortalInbound(supabase, sess, review, `${verdict}: ${review.title}${comment ? `\n\n${comment}` : ""}`,
        `portal:client_review:${id}:${decision}`, contact.name);
      return json({ success: true, data: { status: to } });
    }
    case "add-client-review-comment": {
      const id = String(payload.reviewId ?? "");
      const body = String(payload.body ?? "").trim().slice(0, 10000);
      if (!id || !body) return json({ error: "reviewId and body required" }, 400);
      const review = await loadClientReview(supabase, sess, id);
      if (!review) return json({ error: "Not found" }, 404);
      if (!(await contactOwnsProject(supabase, sess, review.project_id))) return json({ error: "Forbidden" }, 403);
      if (!CLIENT_VISIBLE_REVIEW_STATUSES.includes(review.status as typeof CLIENT_VISIBLE_REVIEW_STATUSES[number])) {
        return json({ error: "This review is closed." }, 409);
      }
      const contact = await getSessionContactRow(supabase, sess);
      const { data: row, error } = await supabase.from("client_review_comments").insert({
        org_id: sess.org_id, review_id: id, author_type: "client", author_name: contact.name,
        author_contact_id: sess.contact_id, body,
      }).select("id").maybeSingle();
      if (error || !row) return json({ error: error?.message ?? "Comment not saved" }, 500);
      await logPortalInbound(supabase, sess, review, `Comment on "${review.title}":\n\n${body}`,
        `portal:client_review:${id}:${(row as { id: string }).id}`, contact.name);
      return json({ success: true, data: { id: (row as { id: string }).id } });
    }
    case "add-change-request-comment": {
      const id = String(payload.changeRequestId ?? "");
      if (!(await contactOwnsChangeRequest(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const { error } = await supabase.from("project_change_request_comments").insert({
        change_request_id: id, org_id: sess.org_id, body: String(payload.body ?? ""),
        is_internal: false, client_visible: true, portal_reply: true,
        author_type: "client", author_name: String(payload.authorName ?? "Client"),
      });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }
    case "add-ticket-comment": {
      const id = String(payload.ticketId ?? "");
      if (!(await contactOwnsTicket(supabase, sess, id))) return json({ error: "Forbidden" }, 403);
      const { error } = await supabase.from("project_support_ticket_comments").insert({
        ticket_id: id, org_id: sess.org_id, body: String(payload.body ?? ""),
        is_internal: false, author_type: "client", author_name: String(payload.authorName ?? "Client"),
      });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    // ── Submission actions ──────────────────────────────────────────────────
    // These replace the V2 portal's client-side anon-key inserts into
    // project_change_requests / project_support_tickets, so the WITH CHECK
    // (true) anon INSERT policies can be dropped (Codex finding #6; migration
    // 20260824222000). org, client identity, and project membership all come
    // from the SESSION here — nothing tenant-scoped is trusted from the body.

    case "create-change-request": {
      const projectId = String(payload.projectId ?? "");
      if (!(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);
      const title = String(payload.title ?? "").trim();
      const description = String(payload.description ?? "").trim();
      if (!title || !description) return json({ error: "Missing title or description" }, 400);

      const contact = await getSessionContactRow(supabase, sess);
      const accessToken = generateSecureToken();
      const requestRow = unwrap(await supabase.from("project_change_requests").insert({
        org_id: sess.org_id,
        project_id: projectId,
        client_name: contact.name,
        client_email: contact.email,
        client_phone: contact.phone,
        title,
        request_type: String(payload.requestType ?? "other"),
        priority: String(payload.priority ?? "medium"),
        description,
        requested_due_date: payload.requestedDueDate ? String(payload.requestedDueDate) : null,
        attachments: [],
        // 'public_form', NOT 'portal': project_change_requests.source is
        // CHECK (source IN ('public_form','internal','ai')) — 'portal' is the
        // SUPPORT-ticket value. Writing 'portal' here (6a34244, 2026-08-24)
        // failed every portal change request with a 500 until 2026-09-14.
        // 'public_form' is what the portal wrote before the insert moved here,
        // and what change-request-notify labels "Client Portal".
        source: "public_form",
        status: "submitted",
        access_token_hash: await sha256(accessToken),
      }).select("*").single(), "create-change-request insert failed");

      // Audit + activity trails were written client-side before (and the anon
      // audit insert has been broken since F-41) — write them here where they
      // can't be skipped or forged. Best-effort: the request row is the record.
      await supabase.from("project_change_request_audit").insert({
        org_id: sess.org_id, change_request_id: (requestRow as { id: string }).id,
        event_type: "submitted", actor_type: "client", actor_name: contact.name,
        metadata: { source: "portal", title },
      });
      await supabase.from("project_activity_log").insert({
        org_id: sess.org_id, project_id: projectId, event_type: "change_request_submitted",
        summary: `Change request submitted: "${title}"`,
        payload: { change_request_id: (requestRow as { id: string }).id, client_name: contact.name },
      });
      return json({ success: true, data: requestRow });
    }

    case "create-support-ticket": {
      const projectId = String(payload.projectId ?? "");
      if (!(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);
      const title = String(payload.title ?? "").trim();
      const description = String(payload.description ?? "").trim();
      if (!title || !description) return json({ error: "Missing title or description" }, 400);

      const contact = await getSessionContactRow(supabase, sess);
      const priority = String(payload.priority ?? "medium");
      const businessImpact = String(payload.businessImpact ?? "minimal");
      const severity = computeSeverityScore(priority, businessImpact);
      const accessToken = generateSecureToken();
      const str = (k: string) => (payload[k] == null || payload[k] === "" ? null : String(payload[k]));

      const ticketRow = unwrap(await supabase.from("project_support_tickets").insert({
        org_id: sess.org_id,
        project_id: projectId,
        client_name: contact.name,
        client_email: contact.email,
        client_phone: contact.phone,
        title,
        service_category: String(payload.serviceCategory ?? "other"),
        request_type: String(payload.requestType ?? "general_inquiry"),
        priority,
        description,
        steps_to_reproduce: str("stepsToReproduce"),
        expected_behavior: str("expectedBehavior"),
        actual_behavior: str("actualBehavior"),
        affected_area: str("affectedArea"),
        affected_feature: str("affectedFeature"),
        affected_integration: str("affectedIntegration"),
        environment: String(payload.environment ?? "production"),
        browser_info: str("browserInfo"),
        error_messages: str("errorMessages"),
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
        business_impact: businessImpact,
        impact_description: str("impactDescription"),
        users_affected_count: Number(payload.usersAffectedCount ?? 1) || 1,
        workaround_available: !!payload.workaroundAvailable,
        preferred_contact_method: String(payload.preferredContactMethod ?? "email"),
        availability_window: str("availabilityWindow"),
        expected_resolution_date: str("expectedResolutionDate"),
        status: "new",
        severity_score: severity,
        source: "portal",
        access_token_hash: await sha256(accessToken),
      }).select("*").single(), "create-support-ticket insert failed");

      await supabase.from("project_support_ticket_audit").insert({
        org_id: sess.org_id, ticket_id: (ticketRow as { id: string }).id,
        event_type: "submitted", actor_type: "client", actor_name: contact.name,
        metadata: { source: "portal", title, severity_score: severity },
      });
      await supabase.from("project_activity_log").insert({
        org_id: sess.org_id, project_id: projectId, event_type: "support_ticket_submitted",
        summary: `Support ticket submitted: "${title}"`,
        payload: { support_ticket_id: (ticketRow as { id: string }).id, client_name: contact.name, severity_score: severity },
      });
      return json({ success: true, data: ticketRow });
    }

    case "upload-ticket-attachment": {
      // Replaces the anonymous direct-to-bucket upload (the bucket INSERT
      // policy admitted any anon caller for any path — Codex finding #7).
      // Session required; size and extension are enforced HERE, not in the
      // picker; the path is rooted at the session's org.
      const projectId = String(payload.projectId ?? "");
      if (!(await contactOwnsProject(supabase, sess, projectId))) return json({ error: "Forbidden" }, 403);

      const fileName = String(payload.fileName ?? "file");
      const dataBase64 = String(payload.dataBase64 ?? "");
      const ext = (fileName.split(".").pop() || "").toLowerCase();
      const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "pdf", "doc", "docx", "txt", "log", "csv"]);
      if (!ALLOWED_EXT.has(ext)) return json({ error: "File type not allowed" }, 400);

      let bytes: Uint8Array;
      try {
        const bin = atob(dataBase64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return json({ error: "Invalid file data" }, 400);
      }
      const MAX_BYTES = 10 * 1024 * 1024;
      if (bytes.length === 0 || bytes.length > MAX_BYTES) {
        return json({ error: "File is empty or exceeds 10MB" }, 400);
      }

      const filePath = `${sess.org_id}/portal/${crypto.randomUUID()}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from("support-ticket-attachments")
        .upload(filePath, bytes, { upsert: false, contentType: String(payload.contentType ?? "application/octet-stream") });
      if (uploadErr) return json({ error: `Upload failed: ${uploadErr.message}` }, 500);

      const { data: urlData } = supabase.storage.from("support-ticket-attachments").getPublicUrl(filePath);
      return json({
        success: true,
        data: { name: fileName, url: urlData.publicUrl, size: bytes.length, type: String(payload.contentType ?? "") },
      });
    }

    default:
      return json({ error: `Unknown portal-data action: ${action}` }, 400);
  }
}

/** The session contact's identity fields, resolved server-side so submissions
 *  can never impersonate a different client. */
async function getSessionContactRow(
  supabase: SupabaseClient,
  sess: { contact_id: string; org_id: string },
): Promise<{ name: string; email: string | null; phone: string | null }> {
  const { data } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", sess.contact_id)
    .maybeSingle();
  return {
    name: `${data?.first_name ?? ""} ${data?.last_name ?? ""}`.trim() || "Client",
    email: data?.email ?? null,
    phone: data?.phone ?? null,
  };
}

/** Mirrors the frontend's severity heuristic so portal-submitted tickets score
 *  the same as staff-submitted ones. */
function computeSeverityScore(priority: string, businessImpact: string): number {
  const priorityScores: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const impactScores: Record<string, number> = {
    minimal: 1, internal_only: 2, team_productivity: 3,
    client_facing: 4, operations_blocked: 5, revenue_affecting: 5,
  };
  const p = priorityScores[priority] ?? 2;
  const i = impactScores[businessImpact] ?? 2;
  return Math.min(Math.round((p + i) / 2 * 2.5), 10);
}

// -----------------------------------------------------------------
// Action: mark-step-up-verified
// -----------------------------------------------------------------

async function handleMarkStepUpVerified(
  supabase: SupabaseClient,
  payload: { sessionToken?: string }
): Promise<Response> {
  const session = await resolveSessionContact(supabase, payload.sessionToken ?? "");
  if (!session) return json({ error: "Unauthorized" }, 401);

  // Deliberately a READ-ONLY no-op now. This action used to refresh
  // last_otp_verified_at on nothing but possession of the session token, which
  // made step-up a client-side ceremony: a stolen month-old token could call
  // mark-step-up-verified and then approve billable change requests without
  // ever touching the client's inbox. The timestamp now moves ONLY inside
  // verify-code (a real OTP check, passing the session token in step-up mode).
  // The action is kept as a state read so already-deployed frontends calling it
  // keep working. (Codex finding #4.)
  return json({ success: true, lastOtpVerifiedAt: session.last_otp_verified_at });
}

// -----------------------------------------------------------------
// Action: list-sessions
// -----------------------------------------------------------------

async function handleListSessions(
  supabase: SupabaseClient,
  payload: { sessionToken?: string }
): Promise<Response> {
  const session = await resolveSessionContact(supabase, payload.sessionToken ?? "");
  if (!session) return json({ error: "Unauthorized" }, 401);

  const { data: sessions } = await supabase
    .from("client_portal_sessions")
    .select("id, created_at, expires_at, remember_device, user_agent, ip_address")
    .eq("org_id", session.org_id)
    .eq("contact_id", session.contact_id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  return json({
    success: true,
    currentSessionId: session.session_id,
    sessions: (sessions ?? []).map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      rememberDevice: s.remember_device,
      deviceLabel: deriveDeviceLabel(s.user_agent ?? ""),
      isCurrent: s.id === session.session_id,
    })),
  });
}

// -----------------------------------------------------------------
// Action: logout
// -----------------------------------------------------------------

async function handleLogout(
  supabase: SupabaseClient,
  payload: { sessionToken?: string }
): Promise<Response> {
  const session = await resolveSessionContact(supabase, payload.sessionToken ?? "");
  if (!session) return json({ success: true });

  await supabase
    .from("client_portal_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", session.session_id);

  // Invalidate any outstanding auth codes so a replayed code from email can't re-auth
  await supabase
    .from("client_portal_auth_codes")
    .update({ invalidated_at: new Date().toISOString() })
    .eq("contact_id", session.contact_id)
    .is("consumed_at", null)
    .is("invalidated_at", null);

  const { data: account } = await supabase
    .from("client_portal_accounts")
    .select("id")
    .eq("org_id", session.org_id)
    .eq("contact_id", session.contact_id)
    .maybeSingle();

  if (account) {
    await supabase.from("client_portal_events").insert({
      org_id: session.org_id,
      account_id: account.id,
      contact_id: session.contact_id,
      event_type: "logout",
    });
  }

  return json({ success: true });
}

// -----------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = getServiceClient();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "send-invite":
        return await handleSendInvite(supabase, req, body as { projectId?: string; contactId?: string });
      case "send-code":
        return await handleSendCode(supabase, req, body as { email?: string; inviteToken?: string });
      case "verify-code":
        return await handleVerifyCode(
          supabase,
          req,
          body as { email?: string; code?: string; rememberDevice?: boolean; inviteToken?: string; sessionToken?: string }
        );
      case "validate-session":
        return await handleValidateSession(supabase, body as { sessionToken?: string });
      case "fetch-projects":
        return await handleFetchProjects(supabase, body as { sessionToken?: string });
      case "fetch-project":
        return await handleFetchProject(
          supabase,
          body as { sessionToken?: string; projectId?: string }
        );
      case "mark-step-up-verified":
        return await handleMarkStepUpVerified(supabase, body as { sessionToken?: string });
      case "list-sessions":
        return await handleListSessions(supabase, body as { sessionToken?: string });
      case "logout":
        return await handleLogout(supabase, body as { sessionToken?: string });
      // Session-validated portal data reads/writes (replace V1 anon table access)
      case "list-change-requests":
      case "get-change-request":
      case "list-change-request-comments":
      case "list-support-tickets":
      case "get-support-ticket":
      case "list-ticket-comments":
      case "list-project-activity":
      case "approve-change-request":
      case "reject-change-request":
      case "add-change-request-comment":
      case "add-ticket-comment":
      case "create-change-request":
      case "create-support-ticket":
      case "upload-ticket-attachment":
      case "get-caio":
      case "get-caio-document":
      case "list-client-reviews":
      case "decide-client-review":
      case "add-client-review-comment":
        return await handlePortalData(supabase, action, body);
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error(`[client-portal-auth] action=${action} failed:`, err);
    return json({ error: "Internal server error", details: String(err) }, 500);
  }
});
