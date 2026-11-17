/**
 * notification-dispatcher
 *
 * Called by the `notify_dispatch_on_event` DB trigger (AFTER INSERT on event_outbox, via pg_net
 * with the project anon JWT) with { event_id }. Turns the event into:
 *   1. in-app `notifications` rows (bell + toast) for admins and/or the assigned user, with a deep
 *      link to the record, and
 *   2. a Resend email per recipient that says what happened (task, appointment, lead, …) and links
 *      the same record.
 *
 * The outbox payloads are thin, so the event is enriched from the entity rows first
 * (_shared/notification-enrich.ts); what each event says and links is in
 * _shared/notification-events.ts; the HTML layout is _shared/notification-email.ts.
 *
 * Recipient mailboxes are hardcoded here (single place to edit). Auth is enforced by the platform
 * (verify_jwt=true) and the event is re-loaded from the DB by id, so callers cannot inject content.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { appBaseUrl, loadOrgEmailDefaults, sendOrgEmail } from "../_shared/email-defaults.ts";
import { buildNotificationEmail } from "../_shared/notification-email.ts";
import { enrichEvent, loadRecipient } from "../_shared/notification-enrich.ts";
import { BRIEF_BOUND_EVENT_TYPES, EVENTS, renderEvent, type Payload } from "../_shared/notification-events.ts";

// ── Team recipient mailboxes (NOTIFY_INFO_EMAIL / NOTIFY_ADMIN_EMAIL / NOTIFY_ACCOUNTING_EMAIL) ──
const ADDR = {
  INFO: Deno.env.get("NOTIFY_INFO_EMAIL")?.trim() || "info@example.com",
  ADMIN: Deno.env.get("NOTIFY_ADMIN_EMAIL")?.trim() || "admin@example.com",
  ACCOUNTING: Deno.env.get("NOTIFY_ACCOUNTING_EMAIL")?.trim() || "accounting@example.com",
} as const;

function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function resolveAdminUserIds(sb: SupabaseClient, orgId: string): Promise<Array<{ id: string; email: string | null; name: string | null }>> {
  const { data: roles } = await sb.from("roles").select("id, name, hierarchy_level");
  const adminNames = ["superadmin", "super admin", "admin", "owner"];
  const adminRoleIds = (roles || [])
    .filter((r: { name: string | null; hierarchy_level: number | null }) =>
      (typeof r.hierarchy_level === "number" && r.hierarchy_level <= 2) ||
      adminNames.includes((r.name || "").toLowerCase()))
    .map((r: { id: string }) => r.id);
  if (adminRoleIds.length === 0) return [];
  const { data: users } = await sb
    .from("users")
    .select("id, email, name")
    .eq("organization_id", orgId)
    .in("role_id", adminRoleIds)
    .eq("status", "active");
  return users || [];
}

/** The user an event is "for": the enriched payload names them under one of these keys. */
function resolveAssignedUserId(p: Payload): string | null {
  const keys = ["assigned_to_user_id", "assigned_user_id", "reviewer_user_id", "owner_id"];
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const sb = getServiceClient();
    const body = await req.json().catch(() => ({}));
    const eventId = body.event_id as string | undefined;
    if (!eventId) return errorResponse("MISSING_EVENT_ID", "event_id required");

    const { data: event } = await sb
      .from("event_outbox")
      .select("id, org_id, event_type, entity_type, entity_id, contact_id, payload")
      .eq("id", eventId)
      .maybeSingle();
    if (!event) return jsonResponse({ skipped: "event not found" });

    const eventType = event.event_type as string;
    const cfg = EVENTS[eventType];
    if (!cfg) return jsonResponse({ skipped: `no config for ${eventType}` });

    const orgId = event.org_id as string;
    const entityId = event.entity_id as string;

    // Gate: skip externally-synced (e.g. QuickBooks) invoices — only alert on CRM-native invoices
    // (provider IS NULL), matching dashboard scoping.
    if (eventType === "invoice_created" || eventType === "invoice_paid" || eventType === "invoice_overdue") {
      const { data: inv } = await sb.from("invoices").select("provider").eq("id", entityId).maybeSingle();
      if (inv && inv.provider) return jsonResponse({ skipped: "external invoice" });
    }

    // Gate: CRs/tickets an agent mirrored from a request it already intook are not new news.
    if (eventType === "change_request_created" || eventType === "support_ticket_created") {
      const table = eventType === "change_request_created" ? "project_change_requests" : "project_support_tickets";
      const { data: row } = await sb.from(table).select("source").eq("id", entityId).maybeSingle();
      const agentSource = eventType === "change_request_created" ? "ai" : "internal";
      if (row && row.source === agentSource) return jsonResponse({ skipped: "agent-mirrored" });
    }

    // ── Enrich from the entity rows, then apply the event's own gate ──
    const payload = await enrichEvent(sb, {
      event_type: eventType,
      entity_type: event.entity_type as string | null,
      entity_id: entityId,
      contact_id: event.contact_id as string | null,
      payload: (event.payload || {}) as Payload,
    });
    const gateReason = cfg.gate?.(payload);
    if (gateReason) return jsonResponse({ skipped: gateReason });

    // ── Resolve recipients ──
    const admins = cfg.toast.includes("admins") || cfg.emailTo.includes("admin")
      ? await resolveAdminUserIds(sb, orgId)
      : [];
    const assignedId = resolveAssignedUserId(payload);
    const assigned = assignedId && (cfg.toast.includes("assigned") || cfg.emailTo.includes("assigned"))
      ? await loadRecipient(sb, assignedId)
      : null;

    // ── Per-user notification preferences (missing row = enabled) ──
    const prefUserIds = new Set<string>();
    admins.forEach((a) => prefUserIds.add(a.id));
    if (assigned) prefUserIds.add(assigned.id);
    const disabled = new Set<string>(); // `${userId}:${channel}`
    if (prefUserIds.size > 0) {
      const { data: prefs } = await sb
        .from("user_notification_preferences")
        .select("user_id, channel")
        .eq("event_type", eventType)
        .eq("enabled", false)
        .in("user_id", Array.from(prefUserIds));
      (prefs || []).forEach((pr: { user_id: string; channel: string }) => disabled.add(`${pr.user_id}:${pr.channel}`));
    }

    const view = renderEvent(cfg, payload, entityId, appBaseUrl());

    // ── In-app notifications (toast + bell) ──
    const toastUserIds = new Set<string>();
    if (cfg.toast.includes("admins")) admins.forEach((a) => toastUserIds.add(a.id));
    if (cfg.toast.includes("assigned") && assigned) toastUserIds.add(assigned.id);
    for (const uid of Array.from(toastUserIds)) {
      if (disabled.has(`${uid}:in_app`)) toastUserIds.delete(uid);
    }
    if (toastUserIds.size > 0) {
      const rows = Array.from(toastUserIds).map((uid) => ({
        user_id: uid,
        type: cfg.notifType,
        title: view.title,
        body: view.body,
        link: view.link,
        metadata: { event_id: eventId, event_type: eventType, entity_type: event.entity_type, entity_id: entityId },
      }));
      await sb.from("notifications").insert(rows);
    }

    // ── Email (Resend; org Email Services Defaults for from / reply-to) ──
    // Internal operational alerts to the org's own mailboxes/users: transactional (no unsubscribe
    // link; per-user opt-outs above already apply). Agent accounts never get email.
    const creds = getResendEnvCreds();
    const emailResults: Array<{ to: string; ok: boolean; error?: string }> = [];
    if (creds) {
      const defaults = await loadOrgEmailDefaults(sb, orgId);
      const addresses = new Set<string>();
      for (const r of cfg.emailTo) {
        if (r === "info") addresses.add(ADDR.INFO);
        else if (r === "admin") {
          if (!BRIEF_BOUND_EVENT_TYPES.has(eventType)) addresses.add(ADDR.ADMIN);
        } else if (r === "accounting") addresses.add(ADDR.ACCOUNTING);
        else if (r === "assigned" && assigned?.email && !assigned.isAgent && !disabled.has(`${assigned.id}:email`)) addresses.add(assigned.email);
      }
      const mail = buildNotificationEmail({
        subject: view.subject, heading: view.heading, intro: view.intro, rows: view.rows, cta: view.cta,
      });
      for (const to of addresses) {
        const res = await sendOrgEmail(sb, orgId, {
          fromName: defaults.fromName ?? creds.fromName ?? "Orion",
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          categories: ["notification", eventType],
          transactional: true,
          defaults,
        });
        emailResults.push({ to, ok: res.ok, error: res.error });
        if (!res.ok) console.error(`[notification-dispatcher] email to ${to} failed:`, res.error);
      }
    } else {
      console.warn("[notification-dispatcher] Resend not configured; email skipped");
    }

    return jsonResponse({
      ok: true,
      event_type: eventType,
      link: view.link,
      toasted: toastUserIds.size,
      emailed: emailResults.filter((e) => e.ok).map((e) => e.to),
    });
  } catch (err) {
    console.error("[notification-dispatcher] error:", err);
    return errorResponse("INTERNAL_ERROR", err instanceof Error ? err.message : "error", 500);
  }
});
