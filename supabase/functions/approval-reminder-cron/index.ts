/**
 * approval-reminder-cron
 *
 * Scheduled task (every 30 minutes via pg_cron or Supabase scheduled functions).
 * Two responsibilities:
 *
 *   1. **Auto-expire stale approvals** — call expire_stale_approvals() RPC
 *      which walks every pending row past its expires_at and applies its
 *      expiration_branch ('approve' | 'reject' | 'escalate').
 *
 *   2. **Send reminder emails** — for pending approvals where
 *      last_reminder_sent_at is older than 24h (or null), send a nudge to
 *      every approver_user_id whose email we can resolve. Updates
 *      last_reminder_sent_at + reminder_count to avoid duplicate spam.
 *
 * Triggered via Supabase scheduled functions or an external cron POST.
 * No body required; service-role auth.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { appBaseUrl, loadOrgEmailDefaults, sendOrgEmail } from "../_shared/email-defaults.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function getSupabase() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

interface ApprovalReminderRow {
  id: string;
  org_id: string;
  title: string | null;
  description: string | null;
  approver_user_ids: string[];
  reminder_count: number;
  last_reminder_sent_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** Escapes a value for interpolation into the reminder email's HTML body. */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendReminderEmails(
  supabase: ReturnType<typeof getSupabase>,
  approval: ApprovalReminderRow
): Promise<{ sent: number; failed: number }> {
  if (!approval.approver_user_ids?.length) return { sent: 0, failed: 0 };

  const { data: users, error: usersError } = await supabase
    .from("users")
    .select("id, email, name")
    .in("id", approval.approver_user_ids);

  if (usersError) {
    console.error(
      `[approval-reminder-cron] failed to load approvers for ${approval.id}:`,
      usersError
    );
    return { sent: 0, failed: 0 };
  }
  if (!users?.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  // The approvals page has no per-item route; the queue opens on the pending tab.
  const dashboardUrl = `${appBaseUrl()}/automation/approvals`;
  const defaults = await loadOrgEmailDefaults(supabase, approval.org_id);

  for (const user of users) {
    if (!user.email) continue;
    try {
      const subject = `Reminder: ${approval.title || "approval needed"}`;
      const html = `
        <p>Hi ${escapeHtml(user.name ?? "")},</p>
        <p>This approval has been waiting for ${
          approval.last_reminder_sent_at
            ? "another"
            : "more than"
        } 24 hours:</p>
        <p><strong>${escapeHtml(approval.title ?? "Approval")}</strong></p>
        <p>${escapeHtml(approval.description ?? "")}</p>
        <p><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:white;text-decoration:none;border-radius:6px;">Review in dashboard</a></p>
        ${approval.expires_at ? `<p style="font-size:12px;color:#6b7280;">This approval auto-expires on ${escapeHtml(approval.expires_at)}.</p>` : ""}
      `;

      // Org default sender via Resend. Transactional: an internal approver nudge, not marketing,
      // so no unsubscribe footer or suppression check. (This used to POST email-send with the
      // service-role key, which email-send rejects, so reminders were never delivered.)
      const res = await sendOrgEmail(supabase, approval.org_id, {
        to: user.email,
        subject,
        html,
        categories: ["approval_reminder"],
        transactional: true,
        defaults,
      });

      if (res.ok) sent++;
      else {
        failed++;
        console.error(`[approval-reminder-cron] email to ${user.email} failed:`, res.error);
      }
    } catch (err) {
      console.error(`[approval-reminder-cron] failed to email ${user.email}:`, err);
      failed++;
    }
  }

  // Audit: log the reminder dispatch to workflow_approval_decisions.
  // (Was `.insert(...).catch(...)`: the query builder has no .catch, so that threw a TypeError
  // and aborted the run after the first approval.)
  const { error: auditError } = await supabase.from("workflow_approval_decisions").insert({
    approval_id: approval.id,
    org_id: approval.org_id,
    decision: "reminder_sent",
    comment: `Reminder #${approval.reminder_count + 1} sent to ${sent} approver(s)`,
    via_magic_link: false,
  });
  if (auditError) console.error("[ApprovalReminderCron] Failed to log reminder dispatch:", auditError);

  return { sent, failed };
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // This function expires approvals and sends reminder emails, all with the service-role
  // key. It previously had no caller check at all - the "optional" note that used to sit
  // here was never implemented, and the only thing holding it shut was verify_jwt=true at
  // the gateway. It now runs verify_jwt=false so pg_cron can reach it with a shared secret
  // instead of a service-role JWT, which means the check has to be real.
  //
  // isCronRequest compares X-Cron-Secret against CRON_SECRET in constant time and fails
  // closed when either side is missing.
  if (!isCronRequest(req)) {
    console.warn("[approval-reminder-cron] rejected request with missing/invalid cron secret");
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = getSupabase();

  // ─── 1. Auto-expire stale approvals ─────────────────────────────────
  let expiredCount = 0;
  try {
    const { data, error } = await supabase.rpc("expire_stale_approvals");
    if (error) {
      console.error("[approval-reminder-cron] expire_stale_approvals error:", error);
    } else {
      expiredCount = data ?? 0;
    }
  } catch (err) {
    console.error("[approval-reminder-cron] expire RPC threw:", err);
  }

  // ─── 2. Send reminders for >24h pending approvals ───────────────────
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: stale, error: staleErr } = await supabase
    .from("workflow_approval_queue")
    .select(
      "id, org_id, title, description, approver_user_ids, reminder_count, last_reminder_sent_at, expires_at, created_at"
    )
    .eq("status", "pending_approval")
    .or(`last_reminder_sent_at.is.null,last_reminder_sent_at.lt.${cutoff}`)
    .limit(50);

  if (staleErr) {
    console.error("[approval-reminder-cron] stale query error:", staleErr);
  }

  let totalSent = 0;
  let totalFailed = 0;
  if (stale?.length) {
    for (const row of stale as ApprovalReminderRow[]) {
      // Skip if reminder already sent enough times (cap at 4 to avoid spam).
      if (row.reminder_count >= 4) continue;
      const result = await sendReminderEmails(supabase, row);
      totalSent += result.sent;
      totalFailed += result.failed;

      if (result.sent > 0) {
        await supabase
          .from("workflow_approval_queue")
          .update({
            last_reminder_sent_at: new Date().toISOString(),
            reminder_count: row.reminder_count + 1,
          })
          .eq("id", row.id);
      }
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      expired: expiredCount,
      reminders_sent: totalSent,
      reminders_failed: totalFailed,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
