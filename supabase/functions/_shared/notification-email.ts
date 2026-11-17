/**
 * The one HTML/text layout for internal alert emails (notification-dispatcher).
 * Pure: no I/O, every value escaped, empty rows dropped, the CTA URL repeated as plain text so
 * the link survives clients that strip buttons.
 */

export interface NotificationEmailInput {
  subject: string;
  heading: string;
  /** One sentence under the heading, e.g. "Sarah Lee assigned you a task." */
  intro?: string;
  rows?: Array<[string, string]>;
  cta?: { label: string; url: string };
  footer?: string;
}

export interface NotificationEmail { subject: string; html: string; text: string }

export function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const DEFAULT_FOOTER = "Automated notification from Orion.";

export function buildNotificationEmail(i: NotificationEmailInput): NotificationEmail {
  const rows = (i.rows ?? []).filter(([k, v]) => k && typeof v === "string" && v.trim() !== "");
  const footer = i.footer ?? DEFAULT_FOOTER;

  const tr = rows.map(([k, v]) =>
    `<tr><td style="padding:5px 14px 5px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>` +
    `<td style="padding:5px 0;color:#0f172a;font-size:13px;line-height:1.45;">${escapeHtml(v.trim()).replace(/\r?\n/g, "<br>")}</td></tr>`
  ).join("");
  const button = i.cta
    ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(i.cta.url)}" style="display:inline-block;background:#0891b2;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(i.cta.label)}</a></p>` +
      `<p style="margin:8px 0 0;color:#94a3b8;font-size:11px;word-break:break-all;">${escapeHtml(i.cta.url)}</p>`
    : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
    <h2 style="margin:0 0 6px;font-size:18px;">${escapeHtml(i.heading)}</h2>
    ${i.intro ? `<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.5;">${escapeHtml(i.intro)}</p>` : ""}
    ${tr ? `<table style="border-collapse:collapse;">${tr}</table>` : ""}
    ${button}
    <p style="margin:24px 0 0;color:#94a3b8;font-size:11px;">${escapeHtml(footer)}</p>
  </div>`;

  const text = [
    i.heading,
    i.intro ?? "",
    "",
    ...rows.map(([k, v]) => `${k}: ${v.trim()}`),
    i.cta ? `\n${i.cta.label}: ${i.cta.url}` : "",
    "",
    footer,
  ].filter((l, idx, arr) => !(l === "" && arr[idx - 1] === "")).join("\n").trim();

  return { subject: i.subject, html, text };
}
