/**
 * Site monitoring for the FRIDAY ports. ONE uptime check (friday.website_system_monitoring + FRIDAY's
 * local "uptime" job merged, keeping the local job's flap damping) and the daily security-header sweep.
 *
 * Sites come from the OS: active projects with projects.netlify_site_url. Zero sites is an ERROR, never
 * a green "0 probed". Per-site state lives in friday_site_state (replaces uptime-state.json).
 *
 * Alerting is owner-only: rows in clara_notifications (origin='agent'); Clara's ladder delivers them
 * (clara-notify-flush). Nothing here contacts a client.
 *
 * Flap damping (unchanged from FRIDAY): a site is DOWN only after 2 consecutive failed checks; the
 * first alert is held to the 3rd fail (and is a production-emergency SMS only for a real production
 * URL, never a preview deploy); while still down it re-alerts at most every 6 h; recovery is a low
 * priority note that rides the brief and clears the alert clock.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Budget } from "./run-budget.ts";

export const SIX_H = 6 * 3_600_000;
export const PROBE_TIMEOUT_MS = 8_000;
export const SECURITY_TIMEOUT_MS = 10_000;

export interface SiteTarget { projectId: string; orgId: string; name: string; url: string }
export interface SiteState {
  org_id: string; project_id: string; name: string; url: string; status: "up" | "down"; consecutive_fails: number;
  last_down_alert_at: string | null; checked_at: string | null;
}

/** Bare hostnames mean https (a stored `example.com` used to be dropped silently). */
export function normaliseSiteUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { return new URL(url).toString().replace(/\/$/, ""); } catch { return null; }
}

export class NoSitesError extends Error {
  constructor(job: string) {
    super(`${job}: 0 sites to probe: no active OS project has projects.netlify_site_url. Set it on the OS projects; a monitor that probes nothing is a failure, not a pass.`);
  }
}

export async function resolveSites(db: SupabaseClient, job: string): Promise<SiteTarget[]> {
  const { data } = await db.from("projects").select("id, org_id, name, netlify_site_url").eq("status", "active").not("netlify_site_url", "is", null).limit(500);
  const seen = new Set<string>();
  const out: SiteTarget[] = [];
  for (const p of (data ?? []) as { id: string; org_id: string; name: string; netlify_site_url: string | null }[]) {
    const url = normaliseSiteUrl(p.netlify_site_url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ projectId: p.id, orgId: p.org_id, name: p.name || "project", url });
  }
  if (!out.length) throw new NoSitesError(job);
  return out;
}

export const isPreviewUrl = (url: string): boolean => /--[a-z0-9-]+\.netlify\.app/i.test(url);

export interface Alert { kind: string; priority: "critical" | "normal" | "low"; category?: "production"; text: string; dedupeKey: string }
export interface Step { next: { status: "up" | "down"; consecutive_fails: number; last_down_alert_at: string | null }; alert: Alert | null }

/** Pure: apply one probe result to a site's state. */
export function nextState(prev: Pick<SiteState, "status" | "consecutive_fails" | "last_down_alert_at"> | null, ok: boolean, t: { name: string; url: string }, now: Date): Step {
  const p = prev ?? { status: "up" as const, consecutive_fails: 0, last_down_alert_at: null };
  if (ok) {
    return {
      next: { status: "up", consecutive_fails: 0, last_down_alert_at: null }, // recovery clears the alert clock
      alert: p.status === "down" ? { kind: "uptime.up", priority: "low", text: `${t.name} is back up.`, dedupeKey: `up:${t.url}:${now.toISOString().slice(0, 13)}` } : null,
    };
  }
  const fails = p.consecutive_fails + 1;
  const next = { status: p.status, consecutive_fails: fails, last_down_alert_at: p.last_down_alert_at };
  if (fails < 2) return { next, alert: null };
  next.status = "down"; // only a CONFIRMED outage counts as down (so "back up" can't flap)
  const firstAlert = p.status !== "down" || !p.last_down_alert_at;
  const since = p.last_down_alert_at ? now.getTime() - Date.parse(p.last_down_alert_at) : Infinity;
  const due = firstAlert ? fails >= 3 : since > SIX_H;
  if (!due) return { next, alert: null };
  next.last_down_alert_at = now.toISOString();
  const emergency = firstAlert && fails >= 3 && !isPreviewUrl(t.url);
  return {
    next,
    alert: {
      kind: emergency ? "uptime.down" : "uptime", priority: "critical", ...(emergency ? { category: "production" as const } : {}),
      text: `${t.name} looks DOWN (${fails} checks${firstAlert ? "" : ", still down"}): ${t.url}. Check the host / last deploy; roll back if a recent deploy caused it.`,
      dedupeKey: `down:${t.url}:${firstAlert ? "first" : next.last_down_alert_at.slice(0, 13)}`,
    },
  };
}

export type Probe = (url: string, timeoutMs: number) => Promise<{ ok: boolean; finalUrl: string; headers: Headers } | null>;

export const httpProbe: Probe = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, finalUrl: res.url, headers: res.headers };
  } catch { return null; }
};

/** Owner-only notification row (idempotent on dedupe_key); Clara's ladder delivers it. */
export async function notifyOwnerRow(db: SupabaseClient, orgId: string, a: { kind: string; priority: "critical" | "normal" | "low"; category?: string; text: string; dedupeKey: string }): Promise<boolean> {
  const { error } = await db.from("clara_notifications").insert({
    organization_id: orgId, kind: a.kind, priority: a.priority, category: a.category ?? null, text: a.text.slice(0, 3900),
    dedupe_key: a.dedupeKey, origin: "agent", source_agent: "friday",
  });
  if (error && error.code !== "23505") { console.error(`[friday] notify insert failed: ${error.message}`); return false; }
  return !error;
}

async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await f(items[k]); }
  }));
  return out;
}

export interface MonitorResult { probed: number; down: string[]; alerts: number; pruned: number }

export async function runWebsiteMonitoring(d: { db: SupabaseClient; probe?: Probe; now?: Date; budget: Budget }): Promise<MonitorResult> {
  const probe = d.probe ?? httpProbe;
  const now = d.now ?? new Date();
  const sites = await resolveSites(d.db, "website_system_monitoring");
  const { data: st } = await d.db.from("friday_site_state").select("*").limit(1000);
  const state = new Map(((st ?? []) as SiteState[]).map((s) => [s.project_id, s]));
  const results = await mapLimit(sites, 8, async (s) => ({ s, res: await probe(s.url, d.budget.timeout(PROBE_TIMEOUT_MS)) }));
  let alerts = 0;
  const down: string[] = [];
  for (const { s, res } of results) {
    const ok = Boolean(res?.ok);
    const prev = state.get(s.projectId) ?? null;
    const step = nextState(prev, ok, s, now);
    if (step.next.status === "down") down.push(s.name);
    await d.db.from("friday_site_state").upsert({
      org_id: s.orgId, project_id: s.projectId, name: s.name, url: s.url, ...step.next, checked_at: now.toISOString(),
    }, { onConflict: "project_id" });
    if (step.alert && await notifyOwnerRow(d.db, s.orgId, step.alert)) alerts++;
  }
  // Drop state for anything no longer probed, so an archived project's last reading isn't frozen as a live outage.
  const monitored = new Set(sites.map((s) => s.projectId));
  const stale = [...state.keys()].filter((id) => !monitored.has(id));
  if (stale.length) await d.db.from("friday_site_state").delete().in("project_id", stale);
  return { probed: sites.length, down, alerts, pruned: stale.length };
}

// ── Security-header sweep ────────────────────────────────────────────────────

/** Only headers whose ABSENCE is a real finding on a brochure site (deliberately not CSP, which is per-app). */
export const SECURITY_HEADERS: Array<{ header: string; why: string }> = [
  { header: "strict-transport-security", why: "no HSTS: a downgrade to http is possible on first visit" },
  { header: "x-content-type-options", why: "no nosniff: browsers may MIME-sniff a response into script" },
  { header: "x-frame-options", why: "no frame protection: the site can be iframed for clickjacking" },
  { header: "referrer-policy", why: "no referrer policy: full URLs leak to third parties" },
];

export interface Finding { site: string; issue: string; detail: string }

export function securityFindings(site: string, finalUrl: string, headers: Headers): Finding[] {
  const f: Finding[] = [];
  if (!/^https:/i.test(finalUrl)) f.push({ site, issue: "no-https", detail: `resolved to ${finalUrl.split("?")[0]}: not served over https` });
  for (const { header, why } of SECURITY_HEADERS) if (!headers.get(header)) f.push({ site, issue: header, detail: why });
  return f;
}

export interface SweepResult { probed: number; findings: number; sitesWithFindings: number; alerts: number }

export async function runSecuritySweep(d: { db: SupabaseClient; probe?: Probe; now?: Date; budget: Budget }): Promise<SweepResult> {
  const probe = d.probe ?? httpProbe;
  const now = d.now ?? new Date();
  const sites = await resolveSites(d.db, "site_security_sweep");
  const results = await mapLimit(sites, 8, async (s) => ({ s, res: await probe(s.url, d.budget.timeout(SECURITY_TIMEOUT_MS)) }));
  let probed = 0, total = 0, alerts = 0;
  const flagged = new Set<string>();
  for (const { s, res } of results) {
    // Reachability is the uptime check's job: skipping rather than double-reporting keeps one outage to one alert.
    if (!res) continue;
    probed++;
    const findings = securityFindings(s.name, res.finalUrl, res.headers);
    total += findings.length;
    await d.db.from("friday_site_state").upsert({
      org_id: s.orgId, project_id: s.projectId, name: s.name, url: s.url, security_findings: findings, security_checked_at: now.toISOString(),
    }, { onConflict: "project_id" });
    if (findings.length) {
      flagged.add(s.name);
      // One alert per SITE, deduped on the name so a standing gap is one row, not one per day.
      const ok = await notifyOwnerRow(d.db, s.orgId, {
        kind: "site.security_headers", priority: "normal", dedupeKey: `site.security_headers:${s.name}`,
        text: `${s.name} is missing security headers: ${findings.map((x) => x.issue).join(", ")}.`,
      });
      if (ok) alerts++;
    }
  }
  if (probed === 0) throw new Error(`site_security_sweep: 0 of ${sites.length} site(s) could be probed (all unreachable): nothing was checked.`);
  return { probed, findings: total, sitesWithFindings: flagged.size, alerts };
}
