import { assertEquals, assert, assertRejects } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { makeBudget } from "./run-budget.ts";
import { NoSitesError, SIX_H, nextState, normaliseSiteUrl, runSecuritySweep, runWebsiteMonitoring, securityFindings, type Probe } from "./site-monitor.ts";

const T = { name: "Acme", url: "https://acme.com" };
const NOW = new Date("2026-10-20T12:00:00Z");
const up = { status: "up" as const, consecutive_fails: 0, last_down_alert_at: null };

Deno.test("flap damping: one fail is silent, 2 = down but quiet, 3rd = first (emergency) alert", () => {
  const a = nextState(up, false, T, NOW);
  assertEquals([a.next.consecutive_fails, a.next.status, a.alert], [1, "up", null]);
  const b = nextState({ ...a.next }, false, T, NOW);
  assertEquals([b.next.status, b.alert], ["down", null]);
  const c = nextState(b.next, false, T, NOW);
  assertEquals([c.alert?.kind, c.alert?.priority, c.alert?.category, c.next.last_down_alert_at], ["uptime.down", "critical", "production", NOW.toISOString()]);
});

Deno.test("a preview deploy never escalates to an emergency; a still-down site re-alerts only after 6 h", () => {
  const prev = nextState({ status: "down", consecutive_fails: 2, last_down_alert_at: null }, false, { name: "P", url: "https://x--pr-1.netlify.app" }, NOW);
  assertEquals([prev.alert?.kind, prev.alert?.category], ["uptime", undefined]);
  const alerted = { status: "down" as const, consecutive_fails: 5, last_down_alert_at: new Date(NOW.getTime() - 3_600_000).toISOString() };
  assertEquals(nextState(alerted, false, T, NOW).alert, null);
  const old = { ...alerted, last_down_alert_at: new Date(NOW.getTime() - SIX_H - 1000).toISOString() };
  const re = nextState(old, false, T, NOW);
  assertEquals([re.alert?.kind, re.alert?.category], ["uptime", undefined]);
});

Deno.test("recovery pages low priority once and clears the alert clock", () => {
  const r = nextState({ status: "down", consecutive_fails: 4, last_down_alert_at: NOW.toISOString() }, true, T, NOW);
  assertEquals([r.next, r.alert?.kind, r.alert?.priority], [{ status: "up", consecutive_fails: 0, last_down_alert_at: null }, "uptime.up", "low"]);
  assertEquals(nextState(up, true, T, NOW).alert, null);
});

Deno.test("urls normalise; headers produce one finding per gap", () => {
  assertEquals([normaliseSiteUrl("acme.com/"), normaliseSiteUrl(""), normaliseSiteUrl("http://a.io")], ["https://acme.com", null, "http://a.io"]);
  const h = new Headers({ "strict-transport-security": "max-age=1", "x-content-type-options": "nosniff" });
  assertEquals(securityFindings("A", "https://a.io/", h).map((f) => f.issue), ["x-frame-options", "referrer-policy"]);
  assertEquals(securityFindings("A", "http://a.io/", h)[0].issue, "no-https");
});

const seed = (over: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  projects: [
    { id: "p1", org_id: "o", name: "Acme", status: "active", netlify_site_url: "acme.com" },
    { id: "p2", org_id: "o", name: "NoSite", status: "active", netlify_site_url: null },
  ],
  friday_site_state: [], clara_notifications: [], ...over,
}, { unique: { clara_notifications: [["organization_id", "dedupe_key"]] } });
const probeOf = (ok: boolean, headers: Record<string, string> = {}): Probe => (url) => Promise.resolve(ok ? { ok: true, finalUrl: url + "/", headers: new Headers(headers) } : null);

Deno.test("monitoring: ticks escalate once, write owner-only notifications, and prune archived sites", async () => {
  const f = seed({ friday_site_state: [{ project_id: "gone", org_id: "o", name: "Old", url: "https://old", status: "down", consecutive_fails: 66, last_down_alert_at: null }] });
  const run = () => runWebsiteMonitoring({ db: asClient(f), probe: probeOf(false), now: NOW, budget: makeBudget() });
  const r1 = await run(); const r2 = await run(); const r3 = await run(); const r4 = await run();
  assertEquals([r1.alerts, r2.alerts, r3.alerts, r4.alerts], [0, 0, 1, 0]);
  assertEquals([r1.pruned, r1.probed, r3.down], [1, 1, ["Acme"]]);
  const n = f.rows("clara_notifications");
  assertEquals(n.length, 1);
  assertEquals([n[0].origin, n[0].source_agent, n[0].priority, n[0].category, n[0].kind], ["agent", "friday", "critical", "production", "uptime.down"]);
  assertEquals(f.rows("friday_site_state").map((s) => s.project_id), ["p1"]);
  // Recovery: a low-priority note.
  const r5 = await runWebsiteMonitoring({ db: asClient(f), probe: probeOf(true), now: NOW, budget: makeBudget() });
  assertEquals([r5.alerts, f.rows("clara_notifications")[1].priority], [1, "low"]);
});

Deno.test("zero sites is an error, never a green pass", async () => {
  const f = seed({ projects: [{ id: "p2", org_id: "o", name: "NoSite", status: "active", netlify_site_url: null }] });
  await assertRejects(() => runWebsiteMonitoring({ db: asClient(f), probe: probeOf(true), budget: makeBudget() }), NoSitesError);
  await assertRejects(() => runSecuritySweep({ db: asClient(f), probe: probeOf(true), budget: makeBudget() }), NoSitesError);
});

Deno.test("security sweep: one alert per site, stored findings, deduped across days; unreachable-only is an error", async () => {
  const f = seed();
  const s = await runSecuritySweep({ db: asClient(f), probe: probeOf(true, { "strict-transport-security": "x" }), now: NOW, budget: makeBudget() });
  assertEquals([s.probed, s.findings, s.sitesWithFindings, s.alerts], [1, 3, 1, 1]);
  const n = f.rows("clara_notifications")[0];
  assertEquals([n.kind, n.priority, n.dedupe_key], ["site.security_headers", "normal", "site.security_headers:Acme"]);
  assert(String(n.text).includes("x-frame-options"));
  assertEquals((f.rows("friday_site_state")[0].security_findings as unknown[]).length, 3);
  assertEquals((await runSecuritySweep({ db: asClient(f), probe: probeOf(true, { "strict-transport-security": "x" }), now: NOW, budget: makeBudget() })).alerts, 0);
  await assertRejects(() => runSecuritySweep({ db: asClient(f), probe: probeOf(false), budget: makeBudget() }), Error, "0 of 1");
});
