import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * email-unsubscribe — public unsubscribe endpoint for `tracked_links` slugs whose metadata is
 * `{ kind: "unsubscribe", email, ... }`. No JWT (verify_jwt = false in config.toml): mail
 * clients and recipients call it anonymously.
 *
 * Two link generations share this endpoint:
 *
 *  1. Org-default links minted by _shared/email-defaults.ts for every non-transactional Resend
 *     email (metadata.confirm === true). These carry RFC 8058 headers:
 *       List-Unsubscribe: <…/functions/v1/email-unsubscribe/:slug>
 *       List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *     - POST (mail-client one-click, or the app's /unsubscribe/:slug confirm page) acts.
 *     - GET never acts (security scanners prefetch links); it 302s to the app's confirm page.
 *
 *  2. Legacy prospecting links (minted via the `tracked_links_create` MCP tool, no `confirm`):
 *     unchanged — any request acts immediately and returns a confirmation page.
 *
 * Acting = insert an email suppression (UNIQUE(org_id,kind,value_key,channel); a repeat is a
 * harmless 23505) and stamp contacts.unsubscribed_email_at. Every Resend send path checks
 * `suppressions` before sending (_shared/email-defaults.ts isEmailSuppressed).
 *
 * `destination_url` on the row is a placeholder the table requires; it is ignored here.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlPage(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#333;max-width:520px;margin:80px auto;padding:0 24px;text-align:center}
h1{font-size:18px;font-weight:600;color:#111;margin-bottom:8px}
p{color:#666}
</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
  return new Response(html, { status, headers: { ...corsHeaders, "Content-Type": "text/html" } });
}

function jsonRes(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function appBaseUrl(): string {
  return (
    Deno.env.get("APP_BASE_URL") ||
    Deno.env.get("APP_URL") ||
    Deno.env.get("PUBLIC_SITE_URL") ||
    "https://app.example.com"
  ).replace(/\/+$/, "");
}

interface TrackedLinkMetadata {
  kind?: string;
  email?: string;
  company_id?: string;
  confirm?: boolean;
  group_id?: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const fail = (status: number, title: string, body: string) =>
    wantsJson ? jsonRes(status, { ok: false, error: body }) : htmlPage(status, title, body);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return fail(500, "Server error", "Unsubscribe is misconfigured.");

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const slug = pathParts[pathParts.length - 1];
    if (!slug || slug === "email-unsubscribe") {
      return fail(400, "Missing link", "No unsubscribe link slug was provided.");
    }

    const { data: link, error } = await supabase
      .from("tracked_links")
      .select("id, org_id, contact_id, metadata, is_active")
      .eq("slug", slug)
      .maybeSingle();

    const meta = (link?.metadata ?? {}) as TrackedLinkMetadata;
    if (error || !link || meta.kind !== "unsubscribe" || link.is_active === false) {
      return fail(404, "Link not found", "This unsubscribe link doesn't exist or is no longer active.");
    }

    const email = meta.email?.trim().toLowerCase();
    if (!email) return fail(400, "Link incomplete", "This unsubscribe link is missing the address to remove — nothing was changed. Reply STOP or UNSUBSCRIBE to the email itself instead.");

    // Org-default links: GET only shows the confirm page (link scanners prefetch GETs).
    if (meta.confirm === true && req.method !== "POST") {
      if (wantsJson) return jsonRes(200, { ok: true, email, confirmed: false });
      return new Response(null, {
        status: 302,
        headers: { ...corsHeaders, Location: `${appBaseUrl()}/unsubscribe/${encodeURIComponent(slug)}` },
      });
    }

    // Suppress the address — the authoritative record, independent of whether anything below
    // succeeds. A second click hits suppressions' UNIQUE(org_id,kind,value_key,channel)
    // constraint (code 23505) — a harmless no-op, not a failure.
    const { error: suppressErr } = await supabase.from("suppressions").insert({
      org_id: link.org_id,
      kind: "email",
      value: email,
      channel: "email",
      reason: "unsubscribe",
      source: "link",
      company_id: meta.company_id ?? null,
      evidence: { tracked_link_id: link.id, slug, group_id: meta.group_id ?? null, method: req.method },
    });
    if (suppressErr && suppressErr.code !== "23505") {
      console.error("[email-unsubscribe] suppressions insert failed:", suppressErr);
      return fail(500, "Server error", "We couldn't process that request. Reply STOP or UNSUBSCRIBE to the email itself instead.");
    }

    if (link.contact_id) {
      await supabase
        .from("contacts")
        .update({ unsubscribed_email_at: new Date().toISOString() })
        .eq("id", link.contact_id)
        .is("unsubscribed_email_at", null)
        .then(() => undefined, () => undefined);
    }

    if (wantsJson) return jsonRes(200, { ok: true, email, confirmed: true });
    return htmlPage(200, "You're unsubscribed", `${email} will not receive any further emails from us. If this was a mistake, just reply to any of our previous emails and let us know.`);
  } catch (err) {
    console.error("[email-unsubscribe] error:", err);
    return fail(500, "Server error", "Something went wrong processing that request. Reply STOP or UNSUBSCRIBE to the email itself instead.");
  }
});
