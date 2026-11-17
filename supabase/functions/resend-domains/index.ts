/**
 * resend-domains — the Email Services Domains tab + open/click tracking, backed by Resend's
 * Domains API. The Resend key (RESEND_API_KEY secret) never leaves this function.
 *
 * Body: { action, orgId?, ... }  (orgId is optional; it is always the caller's org unless the
 * caller is a SuperAdmin pivoting orgs)
 *
 *   list                      -> { domains }                         (email.settings.view)
 *   sync                      -> pull GET /domains into email_domains (email.settings.manage)
 *   create  { domain }        -> POST /domains, store row + DNS records (email.settings.manage)
 *   verify  { domainId }      -> POST /domains/:id/verify, then GET to refresh status/records
 *   delete  { domainId }      -> remove the local row only (the domain stays in Resend)
 *   get-tracking              -> current open/click tracking (Resend when reported, else defaults)
 *   set-tracking { trackOpens, trackClicks }
 *                             -> PATCH /domains/:id on every org domain, then persist the flags
 *                                into email_defaults (Resend tracks per domain, not per message)
 *
 * email_domains / email_defaults are keyed by `org_id` (NOT organization_id).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  createResendDomain,
  getResendDomain,
  getResendEnvCreds,
  listResendApiKeys,
  resolveResendApiKey,
  listResendDomains,
  mapResendDomainStatus,
  mapResendRecords,
  updateResendDomainTracking,
  verifyResendDomain,
  type ResendDomain,
} from "../_shared/resend.ts";
import { extractUserContext } from "../_shared/auth.ts";
import type { UserContext } from "../_shared/types.ts";

// Same rule as _shared/permissions.ts hasPermission (inlined: that module drags in unrelated
// type errors under `deno check`).
function hasPermission(user: UserContext, permission: string): boolean {
  return user.isSuperAdmin || user.permissions.includes(permission);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MANAGE = "email.settings.manage";
const VIEW = "email.settings.view";
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // F-25: verify caller identity + derive orgId from JWT.
    const userContext = await extractUserContext(req, supabase);
    if (!userContext) return jsonRes({ error: "Unauthorized" }, 401);
    if (!userContext.orgId) return jsonRes({ error: "No organization for caller" }, 403);

    const body = await req.json().catch(() => ({}));
    const bodyOrgId = body.orgId as string | undefined;
    if (bodyOrgId && bodyOrgId !== userContext.orgId && !userContext.isSuperAdmin) {
      console.warn(`[resend-domains] org mismatch: body=${bodyOrgId} caller=${userContext.orgId}`);
      return jsonRes({ error: "Forbidden" }, 403);
    }
    const orgId = userContext.isSuperAdmin && bodyOrgId ? bodyOrgId : userContext.orgId;
    const action = (body.action as string) ?? "list";

    const canManage = hasPermission(userContext, MANAGE);
    const canView = canManage || hasPermission(userContext, VIEW);
    const needsManage = ["sync", "create", "verify", "delete", "set-tracking"].includes(action);
    if (needsManage && !canManage) return jsonRes({ error: "Permission denied (email.settings.manage)" }, 403);
    if (!needsManage && !canView) return jsonRes({ error: "Permission denied (email.settings.view)" }, 403);

    if (action === "list") {
      const { data, error } = await supabase
        .from("email_domains")
        .select("*")
        .eq("org_id", orgId)
        .order("domain");
      if (error) return jsonRes({ error: error.message }, 500);
      return jsonRes({ domains: data ?? [] });
    }

    if (action === "delete") {
      const domainId = body.domainId as string | undefined;
      if (!domainId) return jsonRes({ error: "domainId required" }, 400);
      const { error } = await supabase.from("email_domains").delete().eq("id", domainId).eq("org_id", orgId);
      if (error) return jsonRes({ error: error.message }, 500);
      return jsonRes({ ok: true });
    }

    const creds = getResendEnvCreds();
    if (!creds) {
      return jsonRes({ error: "Resend is not configured. Add the Resend API key in Settings → Integrations." }, 400);
    }

    if (action === "sync") {
      // Every configured key (one per Resend team / sending domain) contributes its domains.
      let inserted = 0;
      let updated = 0;
      let total = 0;
      const errors: string[] = [];
      for (const key of listResendApiKeys()) {
        const result = await listResendDomains(key.apiKey);
        if (!result.ok) { errors.push(`${key.label}: ${result.error ?? "Resend sync failed"}`); continue; }
        total += result.domains.length;
        for (const d of result.domains) {
          if (!d.name) continue;
          // The list endpoint omits records; fetch each domain for its DNS records.
          const detail = await getResendDomain(key.apiKey, String(d.id));
          const full = detail.ok && detail.domain ? detail.domain : d;
          const r = await upsertDomainRow(supabase, orgId, full);
          if (r.error) errors.push(`${d.name}: ${r.error}`);
          else if (r.inserted) inserted++;
          else updated++;
        }
      }
      if (errors.length > 0) {
        return jsonRes({ ok: false, inserted, updated, total, error: errors.join("; ") }, total === 0 ? 502 : 500);
      }
      return jsonRes({ ok: true, inserted, updated, total });
    }

    if (action === "create") {
      const name = normalizeDomain(String(body.domain ?? ""));
      if (!DOMAIN_RE.test(name)) return jsonRes({ error: `"${body.domain ?? ""}" is not a valid domain` }, 400);

      const { data: existing } = await supabase
        .from("email_domains")
        .select("id")
        .eq("org_id", orgId)
        .eq("domain", name)
        .maybeSingle();
      if (existing) return jsonRes({ error: `${name} is already added` }, 409);

      const keyFor = (resolveResendApiKey(name) ?? creds).apiKey;
      let created = await createResendDomain(keyFor, name);
      if (!created.ok) {
        // Already registered in this Resend account -> link the existing domain instead.
        const list = await listResendDomains(keyFor);
        const match = list.ok ? list.domains.find((d) => d.name?.toLowerCase() === name) : undefined;
        if (!match) return jsonRes({ error: created.error ?? "Resend rejected the domain" }, created.status >= 400 ? created.status : 502);
        const detail = await getResendDomain(keyFor, String(match.id));
        created = detail.ok ? { ok: true, status: 200, domain: detail.domain } : { ok: true, status: 200, domain: match };
      }

      const r = await upsertDomainRow(supabase, orgId, created.domain!);
      if (r.error) return jsonRes({ error: r.error }, 500);
      return jsonRes({ ok: true, domain: r.row });
    }

    if (action === "verify") {
      const domainId = body.domainId as string | undefined;
      if (!domainId) return jsonRes({ error: "domainId required" }, 400);
      const { data: row } = await supabase
        .from("email_domains")
        .select("id, domain, provider_domain_id")
        .eq("id", domainId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (!row) return jsonRes({ error: "Domain not found" }, 404);

      const verifyKey = (resolveResendApiKey(row.domain as string) ?? creds).apiKey;
      const resendId = await resolveResendId(verifyKey, row.domain as string, row.provider_domain_id as string | null);
      if (!resendId) return jsonRes({ error: `${row.domain} is not registered in Resend — use Add Domain or Sync` }, 404);

      const v = await verifyResendDomain(verifyKey, resendId);
      if (!v.ok) return jsonRes({ error: v.error ?? "Resend verify failed" }, v.status >= 400 ? v.status : 502);

      const detail = await getResendDomain(verifyKey, resendId);
      if (!detail.ok || !detail.domain) return jsonRes({ error: detail.error ?? "Could not reload domain from Resend" }, 502);
      const r = await upsertDomainRow(supabase, orgId, detail.domain);
      if (r.error) return jsonRes({ error: r.error }, 500);
      return jsonRes({ ok: true, valid: r.row?.status === "verified", domain: r.row });
    }

    if (action === "get-tracking") {
      const { data: defaults } = await supabase
        .from("email_defaults")
        .select("track_opens, track_clicks")
        .eq("org_id", orgId)
        .maybeSingle();
      const fallback = {
        trackOpens: (defaults?.track_opens as boolean | undefined) ?? true,
        trackClicks: (defaults?.track_clicks as boolean | undefined) ?? true,
      };

      const { data: rows } = await supabase
        .from("email_domains")
        .select("domain, provider_domain_id")
        .eq("org_id", orgId);
      const reported: Array<{ domain: string; open_tracking: boolean; click_tracking: boolean }> = [];
      for (const r of rows ?? []) {
        const k = (resolveResendApiKey(r.domain as string) ?? creds).apiKey;
        const id = await resolveResendId(k, r.domain as string, r.provider_domain_id as string | null);
        if (!id) continue;
        const d = await getResendDomain(k, id);
        if (d.ok && typeof d.domain?.open_tracking === "boolean" && typeof d.domain?.click_tracking === "boolean") {
          reported.push({ domain: r.domain as string, open_tracking: d.domain.open_tracking, click_tracking: d.domain.click_tracking });
        }
      }
      if (reported.length === 0) return jsonRes({ ...fallback, source: "defaults", domains: [] });
      return jsonRes({
        trackOpens: reported.every((r) => r.open_tracking),
        trackClicks: reported.every((r) => r.click_tracking),
        source: "resend",
        domains: reported,
      });
    }

    if (action === "set-tracking") {
      if (typeof body.trackOpens !== "boolean" || typeof body.trackClicks !== "boolean") {
        return jsonRes({ error: "trackOpens and trackClicks (boolean) required" }, 400);
      }
      const tracking = { openTracking: body.trackOpens as boolean, clickTracking: body.trackClicks as boolean };

      const { data: rows } = await supabase
        .from("email_domains")
        .select("id, domain, provider_domain_id")
        .eq("org_id", orgId);
      const updatedDomains: string[] = [];
      const errors: string[] = [];
      for (const r of rows ?? []) {
        const k = (resolveResendApiKey(r.domain as string) ?? creds).apiKey;
        const id = await resolveResendId(k, r.domain as string, r.provider_domain_id as string | null);
        if (!id) continue; // local-only row (not in Resend) — nothing to update
        const res = await updateResendDomainTracking(k, id, tracking);
        if (res.ok) {
          updatedDomains.push(r.domain as string);
          if (id !== r.provider_domain_id) {
            await supabase.from("email_domains").update({ provider_domain_id: id }).eq("id", r.id);
          }
        } else {
          errors.push(`${r.domain}: ${res.error ?? `HTTP ${res.status}`}`);
        }
      }
      if (errors.length > 0) {
        return jsonRes({ ok: false, error: `Resend tracking update failed — ${errors.join("; ")}`, updatedDomains }, 502);
      }

      const { error: upErr } = await supabase
        .from("email_defaults")
        .upsert(
          { org_id: orgId, track_opens: tracking.openTracking, track_clicks: tracking.clickTracking },
          { onConflict: "org_id" },
        );
      if (upErr) return jsonRes({ error: upErr.message, updatedDomains }, 500);

      return jsonRes({
        ok: true,
        updatedDomains,
        warning: updatedDomains.length === 0 ? "No Resend domain found for this organization; saved locally only." : undefined,
      });
    }

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[resend-domains] error:", e);
    return jsonRes({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

/** Stored provider id if Resend still knows it, else look the domain up by name. */
async function resolveResendId(apiKey: string, name: string, storedId: string | null): Promise<string | null> {
  if (storedId) {
    const d = await getResendDomain(apiKey, storedId);
    if (d.ok) return storedId;
  }
  const list = await listResendDomains(apiKey);
  if (!list.ok) return null;
  const match = list.domains.find((d) => d.name?.toLowerCase() === name.toLowerCase());
  return match ? String(match.id) : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore no-explicit-any
async function upsertDomainRow(supabase: any, orgId: string, d: ResendDomain): Promise<{
/* eslint-enable @typescript-eslint/no-explicit-any */
  row?: Record<string, unknown>;
  inserted?: boolean;
  error?: string;
}> {
  const name = d.name.toLowerCase();
  const fields: Record<string, unknown> = {
    provider_domain_id: String(d.id),
    status: mapResendDomainStatus(d.status),
    last_checked_at: new Date().toISOString(),
  };
  // GET /domains (list) omits records — keep what we have rather than wiping it.
  if (Array.isArray(d.records)) fields.dns_records = mapResendRecords(d.records);

  const { data: existing } = await supabase
    .from("email_domains")
    .select("id")
    .eq("org_id", orgId)
    .eq("domain", name)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase.from("email_domains").update(fields).eq("id", existing.id).select().single();
    return error ? { error: error.message } : { row: data, inserted: false };
  }
  const { data, error } = await supabase
    .from("email_domains")
    .insert({ org_id: orgId, domain: name, dns_records: [], ...fields })
    .select()
    .single();
  return error ? { error: error.message } : { row: data, inserted: true };
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
