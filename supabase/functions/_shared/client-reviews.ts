/**
 * Client reviews ("Ready for your review" in the client's project portal): pure helpers shared by
 * client-portal-auth (the client's Approve / Request changes / comment) and client-review-notify
 * (the one notice email). The status machine mirrors public.client_review_transition_ok
 * (migration 20261029200100_friday_os_tools.sql), which the database enforces with a trigger.
 *
 *   pending -> accepted | changes_requested | closed | superseded
 *   accepted | changes_requested -> closed | superseded
 *   closed, superseded: terminal
 */

export type ClientReviewStatus = "pending" | "accepted" | "changes_requested" | "closed" | "superseded";
export type ClientDecision = "approve" | "request_changes";

export const CLIENT_REVIEW_STATUSES: ClientReviewStatus[] = ["pending", "accepted", "changes_requested", "closed", "superseded"];

/** Statuses the client still sees in the portal. */
export const CLIENT_VISIBLE_REVIEW_STATUSES: ClientReviewStatus[] = ["pending", "accepted", "changes_requested"];

export function canTransition(from: string, to: string): boolean {
  if (!CLIENT_REVIEW_STATUSES.includes(from as ClientReviewStatus) || !CLIENT_REVIEW_STATUSES.includes(to as ClientReviewStatus)) return false;
  if (from === to) return true;
  if (from === "pending") return ["accepted", "changes_requested", "closed", "superseded"].includes(to);
  if (from === "accepted" || from === "changes_requested") return to === "closed" || to === "superseded";
  return false;
}

export function clientDecisionStatus(decision: ClientDecision): "accepted" | "changes_requested" {
  return decision === "approve" ? "accepted" : "changes_requested";
}

/** Parse the portal's decision value; null for anything else. */
export function parseClientDecision(v: unknown): ClientDecision | null {
  return v === "approve" || v === "request_changes" ? v : null;
}

/** The client's project portal page for a project. A blank base gives the relative path. */
export function portalUrl(appBase: string | null | undefined, projectId: string): string {
  const base = (appBase ?? "").trim().replace(/\/+$/, "");
  return `${base}/client-portal/projects/${encodeURIComponent(projectId)}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ReviewNoticeInput {
  clientName?: string | null;
  orgName: string;
  projectName?: string | null;
  title: string;
  summary?: string | null;
  portalUrl: string;
}

/** The one notice email: "something is ready for your review", with a link to the portal. */
export function reviewNoticeEmail(i: ReviewNoticeInput): { subject: string; html: string; text: string } {
  const greeting = i.clientName?.trim() ? `Hi ${i.clientName.trim()},` : "Hi,";
  const project = i.projectName?.trim() ? ` for ${i.projectName.trim()}` : "";
  const subject = `Ready for your review: ${i.title}`.slice(0, 200);
  const summary = (i.summary ?? "").trim();
  const text = [
    greeting,
    "",
    `${i.orgName} has something ready for your review${project}: ${i.title}.`,
    ...(summary ? ["", summary] : []),
    "",
    `Open your project portal to approve it or request changes: ${i.portalUrl}`,
    "",
    `— ${i.orgName}`,
  ].join("\n");
  const summaryHtml = summary
    ? `<p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;white-space:pre-line;">${escapeHtml(summary)}</p>`
    : "";
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
<tr><td style="padding:28px;">
<p style="margin:0 0 16px;font-size:15px;color:#0f172a;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px;font-size:15px;color:#0f172a;line-height:1.6;">${escapeHtml(i.orgName)} has something ready for your review${escapeHtml(project)}: <strong>${escapeHtml(i.title)}</strong>.</p>
${summaryHtml}
<p style="margin:24px 0;"><a href="${escapeHtml(i.portalUrl)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;">Open your project portal</a></p>
<p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">You can approve it or request changes there, and leave a comment for the team.</p>
<p style="margin:24px 0 0;font-size:13px;color:#64748b;">— ${escapeHtml(i.orgName)}</p>
</td></tr></table></body></html>`;
  return { subject, html, text };
}

export type NotifyReason = "not_requested" | "no_app_base_url" | "client_comms_off" | "already_notified" | "no_client_email";

/** Whether to send the notice now. Pure: the caller supplies what it looked up. */
export function decideNotify(i: {
  send: boolean;
  appBase: string | null | undefined;
  commsEnabled: boolean;
  alreadyNotified: boolean;
  email: string | null | undefined;
}): { send: true } | { send: false; reason: NotifyReason } {
  if (!i.send) return { send: false, reason: "not_requested" };
  if (!(i.appBase ?? "").trim()) return { send: false, reason: "no_app_base_url" };
  if (!i.commsEnabled) return { send: false, reason: "client_comms_off" };
  if (i.alreadyNotified) return { send: false, reason: "already_notified" };
  if (!(i.email ?? "").trim() || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test((i.email ?? "").trim())) return { send: false, reason: "no_client_email" };
  return { send: true };
}
