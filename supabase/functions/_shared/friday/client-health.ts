/**
 * client-health-report (ported from FRIDAY's clientHealth.ts + the friday.client_health_report handler):
 * a weekly, owner-only, read-only status line per active project, plus one combined owner summary.
 *
 *   tasks       completed in the last 7 days, open / in progress (project_tasks)
 *   delivered   portal updates posted + release sign-offs filed in the last 7 days
 *               (replaces FRIDAY's "runs with artifacts": there is no local run store any more)
 *   uptime      the flap-damped state the website-monitoring job keeps in friday_site_state
 *   engineering site url, repo count, target end date
 *
 * Delivery: one clara_notifications row (priority normal, so it rides the owner's next brief), deduped per
 * ISO week. Nothing client-visible is produced.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { isoWeek } from "./weekly-update.ts";
import { notifyOwnerRow } from "./site-monitor.ts";

export const WEEK_MS = 7 * 86_400_000;

export interface Sections {
  tasks: { completed7d: number; open: number; inProgress: number; recentDoneTitles: string[] };
  delivered: { portalUpdates7d: number; signoffsFiled7d: number };
  uptime: { monitored: boolean; status?: "up" | "down"; consecutiveFails?: number; lastDownAlertAt?: string | null };
  engineering: { siteUrl?: string; repoCount: number; targetEndDate?: string };
}
export interface Report { clientName: string; projectId: string; projectName: string; sections: Sections; text: string }

export function composeText(clientName: string, projectName: string, s: Sections): string {
  const parts: string[] = [];
  if (s.tasks.completed7d > 0) {
    const titles = s.tasks.recentDoneTitles.length ? ` (${s.tasks.recentDoneTitles.join("; ")})` : "";
    parts.push(`${s.tasks.completed7d} task(s) wrapped this week${titles}`);
  } else parts.push("no tasks closed this week");
  parts.push(s.tasks.open > 0 ? `${s.tasks.open} open (${s.tasks.inProgress} in progress)` : "board clear");
  if (s.delivered.portalUpdates7d || s.delivered.signoffsFiled7d) {
    const bits: string[] = [];
    if (s.delivered.portalUpdates7d) bits.push(`${s.delivered.portalUpdates7d} portal update(s)`);
    if (s.delivered.signoffsFiled7d) bits.push(`${s.delivered.signoffsFiled7d} sign-off(s)`);
    parts.push(`delivered: ${bits.join(" + ")}`);
  }
  if (s.uptime.monitored) {
    parts.push(s.uptime.status === "down"
      ? `site DOWN (${s.uptime.consecutiveFails ?? "?"} consecutive failed checks${s.uptime.lastDownAlertAt ? `, last paged ${s.uptime.lastDownAlertAt.slice(0, 16)}Z` : ""})`
      : "site up");
  }
  if (s.engineering.targetEndDate) parts.push(`target ${s.engineering.targetEndDate}`);
  return `${clientName} — ${projectName}: ${parts.join(" · ")}.`;
}

export function ownerSummary(reports: Report[], generatedAt: string): string {
  const clients = new Set(reports.map((r) => r.clientName)).size;
  const down = reports.filter((r) => r.sections.uptime.status === "down");
  const wrapped = reports.reduce((n, r) => n + r.sections.tasks.completed7d, 0);
  const lines = [
    `FRIDAY weekly client health — ${generatedAt.slice(0, 10)}: ${reports.length} active project(s) across ${clients} client(s), ${wrapped} task(s) wrapped this week, ${down.length} site(s) down.`,
    ...reports.map((r) => `• ${r.text}`),
  ];
  if (down.length) lines.push(`Down right now: ${down.map((r) => `${r.projectName} (${r.sections.engineering.siteUrl})`).join(", ")}.`);
  return lines.join("\n");
}

export async function buildClientHealthReports(db: SupabaseClient, orgId: string, now: Date): Promise<Report[]> {
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const { data: ps } = await db.from("projects").select("id, name, contact_id, netlify_site_url, repo_urls, target_end_date").eq("org_id", orgId).eq("status", "active").limit(200);
  const projects = (ps ?? []) as { id: string; name: string; contact_id: string | null; netlify_site_url: string | null; repo_urls: string[] | null; target_end_date: string | null }[];
  if (!projects.length) return [];
  const ids = projects.map((p) => p.id);
  const cids = [...new Set(projects.map((p) => p.contact_id).filter(Boolean))] as string[];
  const [{ data: cs }, { data: ts }, { data: acts }, { data: rels }, { data: sites }] = await Promise.all([
    db.from("contacts").select("id, first_name, last_name").in("id", cids),
    db.from("project_tasks").select("project_id, title, status, completed_at, updated_at").in("project_id", ids).limit(2000),
    db.from("project_activity_log").select("project_id, created_at").eq("event_type", "milestone").in("project_id", ids).gte("created_at", since).limit(2000),
    db.from("project_release_approvals").select("project_id, created_at").in("project_id", ids).gte("created_at", since).limit(500),
    db.from("friday_site_state").select("project_id, status, consecutive_fails, last_down_alert_at").in("project_id", ids),
  ]);
  const names = new Map(((cs ?? []) as { id: string; first_name: string | null; last_name: string | null }[]).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unknown client"]));
  const tasks = (ts ?? []) as { project_id: string; title: string; status: string; completed_at: string | null; updated_at: string }[];
  const siteBy = new Map(((sites ?? []) as { project_id: string; status: "up" | "down"; consecutive_fails: number; last_down_alert_at: string | null }[]).map((s) => [s.project_id, s]));
  const count = (rows: unknown, id: string) => ((rows ?? []) as { project_id: string }[]).filter((r) => r.project_id === id).length;

  return projects.map((p) => {
    const mine = tasks.filter((t) => t.project_id === p.id);
    const done = mine.filter((t) => t.status === "completed" && (t.completed_at ?? t.updated_at) >= since).sort((a, b) => ((a.completed_at ?? a.updated_at) < (b.completed_at ?? b.updated_at) ? 1 : -1));
    const open = mine.filter((t) => t.status !== "completed" && t.status !== "cancelled");
    const site = siteBy.get(p.id);
    const sections: Sections = {
      tasks: { completed7d: done.length, open: open.length, inProgress: open.filter((t) => t.status === "in_progress").length, recentDoneTitles: done.slice(0, 3).map((t) => t.title.slice(0, 60)) },
      delivered: { portalUpdates7d: count(acts, p.id), signoffsFiled7d: count(rels, p.id) },
      uptime: p.netlify_site_url
        ? { monitored: true, status: site?.status ?? "up", consecutiveFails: site?.consecutive_fails ?? 0, lastDownAlertAt: site?.last_down_alert_at ?? null }
        : { monitored: false },
      engineering: { siteUrl: p.netlify_site_url ?? undefined, repoCount: (p.repo_urls ?? []).length, targetEndDate: p.target_end_date ?? undefined },
    };
    const clientName = (p.contact_id && names.get(p.contact_id)) || "Unknown client";
    return { clientName, projectId: p.id, projectName: p.name, sections, text: composeText(clientName, p.name, sections) };
  });
}

export async function runClientHealthReport(d: { db: SupabaseClient; orgId: string; now?: Date; enabled?: boolean }): Promise<{ projects: number; wrapped7d: number; down: number; posted: boolean }> {
  const now = d.now ?? new Date();
  const reports = await buildClientHealthReports(d.db, d.orgId, now);
  const summary = ownerSummary(reports, now.toISOString());
  const wrapped7d = reports.reduce((n, r) => n + r.sections.tasks.completed7d, 0);
  const down = reports.filter((r) => r.sections.uptime.status === "down").length;
  const posted = d.enabled === false || !reports.length ? false : await notifyOwnerRow(d.db, d.orgId, {
    kind: "friday.client_health_report", priority: "normal", dedupeKey: `friday.client_health_report:${isoWeek(now)}`, text: summary,
  });
  return { projects: reports.length, wrapped7d, down, posted };
}
