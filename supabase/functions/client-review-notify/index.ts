/**
 * client-review-notify: the ONE notice email for a client review ("Ready for your review").
 *
 * Called by the client_reviews_create MCP tool (an agent's user JWT) or a staff user.
 *   POST { review_id: uuid, send: boolean }  →  { portal_url, notified, notify_reason? }
 *
 * Rules (friday-fix-contract.md §2, §6):
 *   - the review must be in the caller's (active) org;
 *   - never sends when the org's client-comms switch (organizations.agent_client_comms_enabled) is off;
 *   - at most one email per review: notified_at is claimed atomically before sending and released
 *     again if Resend fails (notify_error records why);
 *   - the sent notice is logged into the client's conversation (channel email, outbound).
 * APP_BASE_URL is the app's public URL; without it there is no absolute portal link, so nothing is
 * sent and the relative path is returned.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { loadOrgEmailDefaults, sendOrgEmail, type OrgEmailDefaults } from "../_shared/email-defaults.ts";
import { decideNotify, portalUrl, reviewNoticeEmail } from "../_shared/client-reviews.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The org's sender name + Email Services Defaults. The address comes from the org's default
 * From Address (else the platform's verified Resend sender) via sendOrgEmail — never
 * organizations.email, which is usually not on a verified Resend domain.
 */
async function orgSender(db: SupabaseClient, orgId: string): Promise<{ name: string; defaults: OrgEmailDefaults }> {
  const [{ data: org }, defaults] = await Promise.all([
    db.from("organizations").select("name, display_name").eq("id", orgId).maybeSingle(),
    loadOrgEmailDefaults(db, orgId),
  ]);
  const o = org as { name: string | null; display_name: string | null } | null;
  return { name: defaults.fromName || o?.display_name || o?.name || "Client Portal", defaults };
}

Deno.serve(async (req: Request) => {
  const pre = handleCors(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const db = getSupabaseClient();
  const user = await extractUserContext(req, db);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { review_id?: unknown; send?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const reviewId = typeof body.review_id === "string" && UUID_RE.test(body.review_id) ? body.review_id : null;
  if (!reviewId) return json({ error: "review_id (uuid) is required" }, 400);
  const send = body.send === true;

  const { data: r, error: rErr } = await db.from("client_reviews")
    .select("id, org_id, project_id, title, summary, notified_at").eq("id", reviewId).maybeSingle();
  if (rErr) return json({ error: rErr.message }, 500);
  const review = r as { id: string; org_id: string; project_id: string; title: string; summary: string; notified_at: string | null } | null;
  if (!review || review.org_id !== user.orgId) return json({ error: "Review not found" }, 404);

  const appBase = Deno.env.get("APP_BASE_URL")?.trim() || null;
  const url = portalUrl(appBase, review.project_id);

  const [{ data: org }, { data: proj }] = await Promise.all([
    db.from("organizations").select("agent_client_comms_enabled").eq("id", review.org_id).maybeSingle(),
    db.from("projects").select("name, contact_id").eq("id", review.project_id).maybeSingle(),
  ]);
  const project = proj as { name: string; contact_id: string | null } | null;
  type ContactRow = { first_name: string | null; last_name: string | null; email: string | null };
  let contact: ContactRow | null = null;
  if (project?.contact_id) {
    const { data } = await db.from("contacts").select("first_name, last_name, email")
      .eq("id", project.contact_id).eq("organization_id", review.org_id).maybeSingle();
    contact = (data as ContactRow | null) ?? null;
  }

  const decision = decideNotify({
    send, appBase,
    commsEnabled: (org as { agent_client_comms_enabled: boolean } | null)?.agent_client_comms_enabled === true,
    alreadyNotified: !!review.notified_at,
    email: contact?.email,
  });
  if (!decision.send) return json({ portal_url: url, notified: false, notify_reason: decision.reason });

  const creds = getResendEnvCreds();
  if (!creds) return json({ portal_url: url, notified: false, notify_reason: "email_not_configured" });

  // Claim the one send. A concurrent or repeated call finds notified_at set and stops here.
  const { data: claimed } = await db.from("client_reviews").update({ notified_at: new Date().toISOString(), notify_error: null })
    .eq("id", review.id).is("notified_at", null).select("id");
  if (!claimed || claimed.length === 0) return json({ portal_url: url, notified: false, notify_reason: "already_notified" });

  const sender = await orgSender(db, review.org_id);
  const clientName = `${contact?.first_name ?? ""} ${contact?.last_name ?? ""}`.trim() || null;
  const mail = reviewNoticeEmail({ clientName, orgName: sender.name, projectName: project?.name, title: review.title, summary: review.summary, portalUrl: url });
  // Transactional (a notice about the client's own project): defaults for from / reply-to,
  // no unsubscribe link, not blocked by a marketing suppression.
  const res = await sendOrgEmail(db, review.org_id, {
    fromName: sender.name,
    contactId: project?.contact_id ?? null,
    to: contact!.email!.trim(),
    toName: clientName ?? undefined,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    transactional: true,
    categories: ["client_review"],
    defaults: sender.defaults,
  });
  if (!res.ok) {
    // Release the claim so a later call can try again; say why.
    await db.from("client_reviews").update({ notified_at: null, notify_error: `${res.status}: ${res.error ?? "send failed"}`.slice(0, 500) }).eq("id", review.id);
    return json({ portal_url: url, notified: false, notify_reason: "send_failed", error: res.error ?? null });
  }

  const { error: logErr } = await db.rpc("conversation_log_message", {
    p_org: review.org_id, p_channel: "email", p_direction: "outbound", p_body: mail.text,
    p_project_id: review.project_id, p_contact_id: project?.contact_id ?? null, p_subject: mail.subject,
    p_external_id: `client_review_notice:${review.id}`,
    p_metadata: { source: "client_review_notice", review_id: review.id, resend_id: res.messageId ?? null, sent_by_user_id: user.id },
    p_sender_name: sender.name,
  });
  if (logErr) console.warn("[client-review-notify] sent but not logged to conversations:", logErr.message);

  return json({ portal_url: url, notified: true });
});
