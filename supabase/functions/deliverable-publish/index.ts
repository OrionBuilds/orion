import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds } from "../_shared/resend.ts";
import { sendOrgEmail } from "../_shared/email-defaults.ts";
import { extractUserContext, isServiceRoleRequest } from "../_shared/auth.ts";

// Track D: publish + deliver a client deliverable (branded portal page + branded HTML email).
// PDF is deferred - portal page + email first.
//
// Actions:
//   create_and_send  (authenticated staff OR agent JWT OR service role): insert/complete a
//                     deliverable, mint a one-shot public token, email the client a branded
//                     message with a deep link, mark delivered. Returns { id, portal_url }.
//   get_public       (anon + raw token): verify token against access_token_hash under the service
//                     role, return the deliverable content for the public page. This is the ONLY
//                     public read path - the table has no anon RLS policy (avoids the token-blind
//                     hole that F-39-era change-request/ticket policies had).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const COMPANY = {
  name: Deno.env.get("BUSINESS_NAME")?.trim() || "Your Company",
  email: Deno.env.get("BUSINESS_INFO_EMAIL")?.trim() || "info@example.com",
  phone: Deno.env.get("BUSINESS_PHONE")?.trim() || "+1 555 010 0100",
};
const ACCENT = "#22d3ee";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function brandedEmail(title: string, summary: string, portalUrl: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f7fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <div style="max-width:600px;margin:0 auto;padding:24px">
    <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:20px 28px">
      <div style="color:#fff;font-size:18px;font-weight:700">${COMPANY.name}</div>
    </div>
    <div style="height:4px;background:${ACCENT}"></div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px">
      <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
      <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 24px">${escapeHtml(summary || "Your latest update is ready to view.")}</p>
      <a href="${portalUrl}" style="display:inline-block;background:${ACCENT};color:#062a2e;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px">View your report</a>
      <p style="font-size:12px;color:#94a3b8;margin:28px 0 0;border-top:1px solid #f1f5f9;padding-top:16px">
        Questions? Contact us at ${COMPANY.email} or ${COMPANY.phone}.<br/>${COMPANY.name}
      </p>
    </div>
  </div></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const appUrl = Deno.env.get("APP_URL") || Deno.env.get("APP_BASE_URL") || "https://app.example.com";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonRes({ error: "invalid json" }, 400); }
  const action = body.action as string;

  try {
    // --- public read (anon + token) --------------------------------------------------------
    if (action === "get_public") {
      const id = body.id as string;
      const token = body.token as string;
      if (!id || !token) return jsonRes({ error: "id and token required" }, 400);
      const { data: row } = await admin
        .from("client_deliverables")
        .select("id, org_id, title, summary, html_content, status, access_token_hash, delivered_at, created_at")
        .eq("id", id)
        .maybeSingle();
      if (!row || !row.access_token_hash) return jsonRes({ error: "not found" }, 404);
      const hash = await sha256Hex(token);
      // constant-time-ish compare
      if (hash.length !== row.access_token_hash.length) return jsonRes({ error: "forbidden" }, 403);
      let diff = 0;
      for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ row.access_token_hash.charCodeAt(i);
      if (diff !== 0) return jsonRes({ error: "forbidden" }, 403);
      return jsonRes({
        id: row.id, title: row.title, summary: row.summary, html_content: row.html_content,
        created_at: row.created_at, company: COMPANY,
      });
    }

    // --- create_and_send (staff / agent / service role) ------------------------------------
    if (action === "create_and_send") {
      // authorize: service role, or an org member (staff/agent) whose org matches
      let orgId = body.org_id as string | undefined;
      let createdBy: string | null = null;
      if (!isServiceRoleRequest(req)) {
        const ctx = await extractUserContext(req, admin);
        if (!ctx) return jsonRes({ error: "Unauthorized" }, 401);
        if (!ctx.orgId) return jsonRes({ error: "No organization for caller" }, 403);
        if (orgId && orgId !== ctx.orgId && !ctx.isSuperAdmin) return jsonRes({ error: "Forbidden" }, 403);
        orgId = ctx.isSuperAdmin && orgId ? orgId : ctx.orgId;
        createdBy = ctx.userId ?? null;
      }
      if (!orgId) return jsonRes({ error: "org_id required" }, 400);

      const title = body.title as string;
      const html = body.html_content as string;
      const recipientEmail = (body.recipient_email as string) || "";
      if (!title || !html) return jsonRes({ error: "title and html_content required" }, 400);

      // one-shot public token
      const rawToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const tokenHash = await sha256Hex(rawToken);

      const { data: inserted, error: insErr } = await admin
        .from("client_deliverables")
        .insert({
          org_id: orgId,
          project_id: (body.project_id as string) ?? null,
          contact_id: (body.contact_id as string) ?? null,
          recipient_email: recipientEmail || null,
          recipient_name: (body.recipient_name as string) ?? null,
          source: (body.source as string) ?? "manual",
          source_ref: (body.source_ref as string) ?? null,
          title,
          summary: (body.summary as string) ?? null,
          html_content: html,
          status: "published",
          access_token_hash: tokenHash,
          published_at: new Date().toISOString(),
          created_by_user_id: createdBy,
        })
        .select("id")
        .single();
      if (insErr || !inserted) return jsonRes({ error: `insert failed: ${insErr?.message}` }, 500);

      const portalUrl = `${appUrl}/deliverable/${inserted.id}?token=${rawToken}`;

      let emailed = false;
      if (recipientEmail && body.send !== false) {
        const creds = getResendEnvCreds();
        if (creds) {
          // Org Email Services Defaults (from, reply-to); a client deliverable is transactional.
          const res = await sendOrgEmail(admin, orgId, {
            transactional: true,
            contactId: (body.contact_id as string | null) ?? null,
            to: recipientEmail,
            toName: (body.recipient_name as string) ?? undefined,
            subject: title,
            html: brandedEmail(title, (body.summary as string) ?? "", portalUrl),
            categories: ["client_deliverable"],
          });
          emailed = res.ok;
        }
      }

      await admin.from("client_deliverables").update({
        status: "delivered",
        delivered_at: new Date().toISOString(),
        delivered_channel: emailed ? "email" : "portal_only",
        updated_at: new Date().toISOString(),
      }).eq("id", inserted.id);

      return jsonRes({ id: inserted.id, portal_url: portalUrl, emailed });
    }

    return jsonRes({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("[deliverable-publish] error:", e);
    return jsonRes({ error: e instanceof Error ? e.message : "internal error" }, 500);
  }
});
