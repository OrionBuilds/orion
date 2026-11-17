/**
 * Owner notifications (ported from CLARA's notify.ts + agent-core's notify-policy ladder).
 *
 *   critical + emergency category (revenue | production | security | family) -> SMS now
 *   critical without one                                                      -> immediate email
 *   normal / low                                                              -> held for the next brief
 *
 * Quiet hours demote an SMS to email unless the category is production or security (something is
 * actually down or under attack). dedupe_key is unique per org: callers embed the call SID or date,
 * so one event notifies once and a Twilio retry can't text twice. The row is written FIRST, so a
 * notification is never lost: if both channels fail it stays pending for the brief.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";

export type Priority = "critical" | "normal" | "low";
export type Category = "revenue" | "production" | "security" | "family";

export interface NotifyRequest {
  kind: string;
  priority: Priority;
  text: string;
  dedupeKey?: string;
  category?: Category;
}

export type NotifyResult = "sms" | "email" | "queued" | "deduped" | "failed";

export interface NotifyDeps {
  orgId: string;
  sendSms: (text: string) => Promise<boolean>;
  sendEmail: (subject: string, text: string) => Promise<boolean>;
  now: () => Date;
  env: Env;
}

// Kinds that predate the explicit category field. An explicit category always wins.
const KIND_CATEGORY_RULES: Array<[RegExp, Category]> = [
  [/injection/i, "security"],
  [/outbound\.breaker|call\.business|voice\.tts_unavailable/i, "production"],
  [/lead\.|work_line|vip/i, "revenue"],
];

export function inferCategory(kind: string): Category | undefined {
  return KIND_CATEGORY_RULES.find(([re]) => re.test(kind))?.[1];
}

/** True when `now` falls in the "HH:MM-HH:MM" window (may wrap midnight) in the given timezone. */
export function inQuietHours(spec: string | undefined, tz: string, now: Date): boolean {
  const m = (spec ?? "").match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const [s, e] = [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(now);
  const cur = (Number(parts.find((p) => p.type === "hour")!.value) % 24) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

// ── "Hold overnight, then text" (owner decision 2026-10-27) ──────────────────────────────────
// PR-ready build nudges must not text the owner during the quiet window (default 8pm-8am local):
// they are HELD and delivered as a text when the window ends (8am). Real outages (production /
// security categories) are NOT in this set and still page at any hour; this is scoped to the
// build-nudge kinds only, so no other notification behavior changes.
const DEFER_IN_QUIET_KINDS: RegExp[] = [/^approval\.merge_ready$/];
const PR_QUIET_DEFAULT = "20:00-08:00";
function isDeferKind(kind: string): boolean {
  return DEFER_IN_QUIET_KINDS.some((re) => re.test(kind));
}

/**
 * The next instant at local HH:MM in `tz` strictly after `now` (DST-safe). Used to release a held
 * notification at the end of the quiet window (e.g. the next local 8:00am).
 */
export function nextLocalTime(tz: string, hh: number, mm: number, now: Date): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const partsOf = (d: Date) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  // offset(ms) = (local wall clock read as if it were UTC) - (actual UTC instant)
  const offsetMs = (d: Date) => {
    const p = partsOf(d);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - d.getTime();
  };
  const utcForLocal = (y: number, mo: number, day: number) => {
    const guess = Date.UTC(y, mo - 1, day, hh, mm, 0);
    return new Date(guess - offsetMs(new Date(guess)));
  };
  const t = partsOf(now);
  let target = utcForLocal(+t.year, +t.month, +t.day);
  if (target.getTime() <= now.getTime()) {
    const n = partsOf(new Date(now.getTime() + 86_400_000));
    target = utcForLocal(+n.year, +n.month, +n.day);
  }
  return target;
}

export async function notifyOwner(db: SupabaseClient, req: NotifyRequest, d: NotifyDeps): Promise<NotifyResult> {
  const category = req.category ?? inferCategory(req.kind);
  const { data, error } = await db.from("clara_notifications").insert({
    organization_id: d.orgId, kind: req.kind, priority: req.priority, category: category ?? null,
    text: req.text, dedupe_key: req.dedupeKey ?? null,
  }).select("id").maybeSingle();
  if (error) {
    if (error.code === "23505") return "deduped";
    throw new Error(`clara_notifications insert failed: ${error.message}`);
  }
  const id = (data as { id: string } | null)?.id;
  if (!id) return "queued";
  return await deliverRow(db, { id, priority: req.priority, category, kind: req.kind, text: req.text }, d);
}

/**
 * Apply the ladder to one already-stored notification. Shared by notifyOwner (inline) and the flush
 * cron that delivers notifications other agents wrote through agent_notify_owner.
 */
export async function deliverRow(
  db: SupabaseClient, row: { id: string; priority: Priority; category?: Category; kind: string; text: string }, d: NotifyDeps,
): Promise<NotifyResult> {
  const mark = async (via: "sms" | "email") => {
    await db.from("clara_notifications").update({ delivered_via: via, delivered_at: d.now().toISOString() }).eq("id", row.id);
  };
  if (row.priority !== "critical") return "queued";

  const tz = d.env.get("CLARA_TZ") || "America/New_York";

  // Owner-held build nudges (e.g. "PR ready"): no text during the quiet window — hold the row and
  // let the flush text it once send_after (the window end, default 8am) passes. Category is ignored
  // here on purpose: inside the send window this is always a text, outside it is always held.
  if (isDeferKind(row.kind)) {
    const spec = d.env.get("CLARA_PR_QUIET_HOURS") || PR_QUIET_DEFAULT;
    if (inQuietHours(spec, tz, d.now())) {
      const end = spec.match(/-\s*(\d{1,2}):(\d{2})$/);
      const at = end ? nextLocalTime(tz, Number(end[1]), Number(end[2]), d.now()) : d.now();
      await db.from("clara_notifications").update({ send_after: at.toISOString() }).eq("id", row.id);
      return "queued"; // held; the flush delivers it (as a text) after send_after
    }
    if (await d.sendSms(row.text).catch(() => false)) { await mark("sms"); return "sms"; }
    if (await d.sendEmail(`Clara: ${row.kind}`, row.text).catch(() => false)) { await mark("email"); return "email"; }
    return "failed";
  }

  const quiet = inQuietHours(d.env.get("CLARA_QUIET_HOURS"), tz, d.now());
  const smsOk = row.category !== undefined && (!quiet || row.category === "production" || row.category === "security");
  if (smsOk && await d.sendSms(row.text).catch(() => false)) { await mark("sms"); return "sms"; }
  // Demoted (no category / quiet hours) or SMS failed: email, never silence.
  if (await d.sendEmail(`Clara: ${row.kind}`, row.text).catch(() => false)) { await mark("email"); return "email"; }
  return "failed"; // row stays pending, so the next flush (or the brief) still carries it
}

/** Deliver critical notifications that agents wrote with agent_notify_owner. Each row at most once. */
export async function flushAgentNotifications(db: SupabaseClient, orgDeps: (orgId: string) => NotifyDeps, limit = 20): Promise<{ delivered: number; failed: number }> {
  const nowIso = new Date().toISOString();
  const { data } = await db.from("clara_notifications").select("id, organization_id, kind, priority, category, text, send_after")
    .eq("origin", "agent").eq("priority", "critical").is("delivered_at", null).order("created_at").limit(limit);
  let delivered = 0, failed = 0;
  for (const r of (data ?? []) as { id: string; organization_id: string; kind: string; priority: Priority; category: Category | null; text: string; send_after: string | null }[]) {
    if (r.send_after && r.send_after > nowIso) continue; // held until its release time (e.g. 8am)
    const res = await deliverRow(db, { id: r.id, priority: r.priority, category: r.category ?? undefined, kind: r.kind, text: r.text }, orgDeps(r.organization_id));
    if (res === "failed") failed++;
    else if (res === "sms" || res === "email") delivered++; // "queued" = just held for later, not yet delivered
  }
  return { delivered, failed };
}

/** Pending items for the next brief; callers mark them delivered after sending. */
export async function pendingForDigest(db: SupabaseClient, orgId: string, limit = 50) {
  const nowIso = new Date().toISOString();
  const { data } = await db.from("clara_notifications").select("id, kind, text, created_at, send_after")
    .eq("organization_id", orgId).is("delivered_at", null).order("created_at").limit(limit);
  // A held row (send_after in the future) has its own release path; don't surface it in a brief early.
  return (data ?? []).filter((r) => { const s = (r as { send_after: string | null }).send_after; return !s || s <= nowIso; })
    .map((r) => r as { id: string; kind: string; text: string; created_at: string });
}

export async function markDigested(db: SupabaseClient, ids: string[], now = new Date()) {
  if (ids.length) await db.from("clara_notifications").update({ delivered_via: "digest", delivered_at: now.toISOString() }).in("id", ids);
}
