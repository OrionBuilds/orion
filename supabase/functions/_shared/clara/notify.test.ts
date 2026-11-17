import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { inQuietHours, inferCategory, markDigested, notifyOwner, pendingForDigest, type NotifyDeps } from "./notify.ts";

function setup(over: Partial<NotifyDeps> = {}, envMap: Record<string, string> = {}) {
  const f = new FakeSupabase({}, { unique: { clara_notifications: [["organization_id", "dedupe_key"]] } });
  const sent: string[] = [];
  const d: NotifyDeps = {
    orgId: "o",
    sendSms: (t) => { sent.push(`sms:${t}`); return Promise.resolve(true); },
    sendEmail: (s, t) => { sent.push(`email:${s}:${t}`); return Promise.resolve(true); },
    now: () => new Date("2026-10-20T18:00:00Z"), // 2pm ET
    env: { get: (k: string) => envMap[k] },
    ...over,
  };
  return { f, db: asClient(f), d, sent };
}

Deno.test("critical + category texts; critical without category emails; normal waits for the brief", async () => {
  const s = setup();
  assertEquals(await notifyOwner(s.db, { kind: "lead.inbound_call", priority: "critical", text: "a", dedupeKey: "k1" }, s.d), "sms"); // inferred revenue
  assertEquals(await notifyOwner(s.db, { kind: "misc.thing", priority: "critical", text: "b", dedupeKey: "k2" }, s.d), "email");
  assertEquals(await notifyOwner(s.db, { kind: "lead.inbound_call", priority: "normal", text: "c", dedupeKey: "k3" }, s.d), "queued");
  assertEquals(s.sent.length, 2);
  assertEquals((await pendingForDigest(s.db, "o")).map((p) => p.text), ["c"]);
  await markDigested(s.db, (await pendingForDigest(s.db, "o")).map((p) => p.id));
  assertEquals((await pendingForDigest(s.db, "o")).length, 0);
});

Deno.test("the same event notifies once", async () => {
  const s = setup();
  const r = { kind: "lead.inbound_call", priority: "critical" as const, text: "x", dedupeKey: "call:CA1" };
  assertEquals(await notifyOwner(s.db, r, s.d), "sms");
  assertEquals(await notifyOwner(s.db, r, s.d), "deduped");
  assertEquals(s.sent.length, 1);
});

Deno.test("quiet hours demote revenue SMS to email but never security/production", async () => {
  const night = setup({ now: () => new Date("2026-10-21T04:00:00Z") }, { CLARA_QUIET_HOURS: "22:00-07:00" }); // midnight ET
  assertEquals(await notifyOwner(night.db, { kind: "lead.x", priority: "critical", text: "a", dedupeKey: "a" }, night.d), "email");
  assertEquals(await notifyOwner(night.db, { kind: "injection.detected", priority: "critical", text: "b", dedupeKey: "b" }, night.d), "sms");
  assertEquals(inQuietHours("22:00-07:00", "America/New_York", new Date("2026-10-20T18:00:00Z")), false);
  assertEquals(inQuietHours(undefined, "America/New_York", new Date()), false);
});

Deno.test("failed sms falls back to email; both failing leaves it pending, never lost", async () => {
  const a = setup({ sendSms: () => Promise.resolve(false) });
  assertEquals(await notifyOwner(a.db, { kind: "lead.x", priority: "critical", text: "a", dedupeKey: "a" }, a.d), "email");
  const b = setup({ sendSms: () => Promise.resolve(false), sendEmail: () => Promise.reject(new Error("down")) });
  assertEquals(await notifyOwner(b.db, { kind: "lead.x", priority: "critical", text: "a", dedupeKey: "a" }, b.d), "failed");
  assertEquals((await pendingForDigest(b.db, "o")).length, 1);
  assertEquals(inferCategory("outbound.breaker.open"), "production");
});

Deno.test("PR-ready text holds during the quiet window and is set to release at the next 8am", async () => {
  const night = setup({ now: () => new Date("2026-10-21T04:00:00Z") }); // midnight ET; default PR window 20:00-08:00
  const res = await notifyOwner(night.db, { kind: "approval.merge_ready", priority: "critical", text: "PR ready", category: "production", dedupeKey: "pr1" }, night.d);
  assertEquals(res, "queued");
  assertEquals(night.sent.length, 0); // no text at midnight even though category is production
  const row = night.f.rows("clara_notifications").find((r) => r.dedupe_key === "pr1")!;
  assertEquals(row.send_after, "2026-10-21T12:00:00.000Z"); // next 08:00 ET (EDT = UTC-4)
});

Deno.test("PR-ready text sends immediately inside the 8am-8pm window", async () => {
  const day = setup(); // 2pm ET
  const res = await notifyOwner(day.db, { kind: "approval.merge_ready", priority: "critical", text: "PR ready", category: "production", dedupeKey: "pr2" }, day.d);
  assertEquals(res, "sms");
  assertEquals(day.sent, ["sms:PR ready"]);
});

import { flushAgentNotifications } from "./notify.ts";

Deno.test("flush holds a PR-ready row until its release time, then texts it", async () => {
  const f = new FakeSupabase({ clara_notifications: [
    { id: "h1", organization_id: "o", origin: "agent", priority: "critical", category: "production", kind: "approval.merge_ready", text: "PR ready", delivered_at: null, send_after: "2026-10-21T12:00:00.000Z", created_at: "2026-10-21T04:00:00Z" },
  ] });
  const sent: string[] = [];
  const depsAt = (iso: string) => (org: string): NotifyDeps => ({ orgId: org, env: { get: () => undefined }, now: () => new Date(iso), sendSms: (t) => { sent.push(t); return Promise.resolve(true); }, sendEmail: () => Promise.resolve(true) });
  assertEquals(await flushAgentNotifications(asClient(f), depsAt("2026-10-21T06:00:00Z")), { delivered: 0, failed: 0 }); // 2am ET: still held
  assertEquals(sent.length, 0);
  assertEquals(await flushAgentNotifications(asClient(f), depsAt("2026-10-21T13:00:00Z")), { delivered: 1, failed: 0 }); // 9am ET: released
  assertEquals(sent, ["PR ready"]);
});

Deno.test("agent-written critical notifications are delivered by the flush, once, and normal ones are left for the brief", async () => {
  const f = new FakeSupabase({ clara_notifications: [
    { id: "n1", organization_id: "o", origin: "agent", priority: "critical", category: "production", kind: "uptime.down", text: "Site X is down", delivered_at: null, created_at: "2026-10-20T10:00:00Z" },
    { id: "n2", organization_id: "o", origin: "agent", priority: "normal", category: null, kind: "run.done", text: "A run finished", delivered_at: null, created_at: "2026-10-20T10:01:00Z" },
    { id: "n3", organization_id: "o", origin: "clara", priority: "critical", category: "revenue", kind: "lead", text: "inline-delivered elsewhere", delivered_at: null, created_at: "2026-10-20T10:02:00Z" },
  ] });
  const sent: string[] = [];
  const deps = (org: string): NotifyDeps => ({ orgId: org, env: { get: () => undefined }, now: () => new Date("2026-10-20T18:00:00Z"), sendSms: (t) => { sent.push(`sms:${t}`); return Promise.resolve(true); }, sendEmail: () => Promise.resolve(true) });
  assertEquals(await flushAgentNotifications(asClient(f), deps), { delivered: 1, failed: 0 });
  assertEquals(sent, ["sms:Site X is down"]);
  assertEquals(await flushAgentNotifications(asClient(f), deps), { delivered: 0, failed: 0 }); // nothing re-sent
  assertEquals(f.rows("clara_notifications").find((r) => r.id === "n2")!.delivered_at, null);
  assertEquals(f.rows("clara_notifications").find((r) => r.id === "n3")!.delivered_at, null);
});
