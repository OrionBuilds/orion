/**
 * send-push: deliver one `notifications` row to the owner's enabled devices as a Web Push message.
 * Called by the trg_push_on_notification trigger (X-Cron-Secret). Needs secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and
 * VAPID_SUBJECT (mailto:...). A subscription the push service reports gone (404/410) is disabled; other failures are counted.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { isCronRequest } from "../_shared/auth.ts";
import { buildPushPayload, type NotificationRow } from "../_shared/push.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const MAX_FAILURES = 8;

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return json({ ok: false, error: "VAPID keys are not configured" }, 500);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com", pub, priv);

  const body = await req.json().catch(() => ({}));
  const id = String(body?.notification_id ?? "");
  if (!id) return json({ error: "notification_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: n } = await db.from("notifications").select("id, user_id, type, title, body, link, metadata").eq("id", id).maybeSingle();
  if (!n) return json({ ok: true, skipped: "notification not found" });
  const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth, failure_count").eq("user_id", (n as NotificationRow).user_id).is("disabled_at", null);
  if (!subs?.length) return json({ ok: true, skipped: "no subscriptions" });

  let pending = 0;
  if ((n as NotificationRow).type === "agent_approval") {
    const { data: u } = await db.from("users").select("organization_id").eq("id", (n as NotificationRow).user_id).maybeSingle();
    if (u) {
      const { count } = await db.from("workflow_approval_queue").select("id", { count: "exact", head: true }).eq("org_id", (u as { organization_id: string }).organization_id).eq("status", "pending_approval");
      pending = count ?? 0;
    }
  }
  const payload = buildPushPayload(n as NotificationRow, pending);
  const message = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url, tag: payload.tag });

  let sent = 0, gone = 0, failed = 0;
  for (const s of subs as { id: string; endpoint: string; p256dh: string; auth: string; failure_count: number }[]) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message, {
        TTL: payload.urgent ? 4 * 3600 : 3600,
        urgency: payload.urgent ? "high" : "normal",
        topic: payload.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "-"),
      });
      sent++;
      await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        gone++;
        await db.from("push_subscriptions").update({ disabled_at: new Date().toISOString() }).eq("id", s.id);
      } else {
        failed++;
        const failures = (s.failure_count ?? 0) + 1;
        await db.from("push_subscriptions").update({ failure_count: failures, ...(failures >= MAX_FAILURES ? { disabled_at: new Date().toISOString() } : {}) }).eq("id", s.id);
        console.warn("[send-push] delivery failed:", code, (e as Error).message?.slice(0, 160));
      }
    }
  }
  return json({ ok: true, sent, gone, failed });
});
