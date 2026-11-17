/**
 * twilio-numbers — manage the per-org Twilio number roster and (for super
 * admins) import + assign numbers from the platform's Twilio account.
 *
 * Actions:
 *   { orgId, action: "sync" }
 *     Org admin. Refreshes friendly_name / capabilities / status on rows
 *     this org already owns (matched by twilio_sid). Does NOT pull in
 *     numbers the org doesn't already own — that's the super admin's job.
 *
 *   { orgId, action: "update", id, patch }
 *     Org admin. Updates one twilio_numbers row's routing fields.
 *
 *   { orgId, action: "delete", id }
 *     Org admin. Removes a twilio_numbers row (does NOT release the number).
 *
 *   { action: "account_list" }                 — super admin only
 *     Returns every number in the Twilio account with its current
 *     organization assignment (or null if unimported).
 *
 *   { action: "assign", sid, orgId }           — super admin only
 *     Sets twilio_numbers.org_id for the given Twilio SID to orgId,
 *     inserting the row (mirroring Twilio metadata) if not yet imported.
 *     Re-assigning resets per-org routing fields so they don't dangle.
 *
 *   { action: "unassign", sid }                — super admin only
 *     Deletes the twilio_numbers row for the given SID.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getTwilioEnvCreds, listTwilioNumbers } from "../_shared/twilio.ts";
import { extractUserContext, isCronRequest } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function isCallerSuperAdmin(
  authHeader: string | null,
): Promise<{ ok: boolean; userId?: string }> {
  if (!authHeader) return { ok: false };
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: { user } } = await anon.auth.getUser(authHeader.replace("Bearer ", ""));
  if (!user) return { ok: false };

  const service = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data } = await service
    .from("users")
    .select("id, role:roles(name)")
    .eq("id", user.id)
    .maybeSingle();
  const roleName = (data as { role?: { name?: string } } | null)?.role?.name;
  return { ok: roleName === "SuperAdmin", userId: user.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const body = await req.json();
    const action = body.action as string;

    // ────────── Machine action: import every account number into one org ──────────
    // Gated on the cron secret (the proven machine-auth path — isServiceRoleRequest's env value
    // matches none of the project's real API keys, see _shared/auth.ts). Upserts every
    // IncomingPhoneNumber in the Twilio account into twilio_numbers under `orgId`, matched by
    // twilio_sid; rows that already exist (e.g. the three agent numbers) are left ENTIRELY
    // untouched — no metadata refresh — so agent_label/sms_route can never be clobbered.
    if (action === "admin_sync_all") {
      if (!isCronRequest(req)) return jsonRes({ error: "Unauthorized" }, 401);
      const targetOrgId = body.orgId as string;
      if (!targetOrgId) return jsonRes({ error: "orgId required" }, 400);

      const creds = getTwilioEnvCreds();
      if (!creds) return jsonRes({ error: "Twilio not configured" }, 400);
      const account = await listTwilioNumbers(creds.accountSid, creds.authToken);
      if (!account.ok) return jsonRes({ error: account.error ?? "Twilio listing failed" }, 502);

      const { data: existing } = await supabase
        .from("twilio_numbers")
        .select("twilio_sid");
      const existingSids = new Set((existing ?? []).map((r: { twilio_sid: string }) => r.twilio_sid));

      const toInsert = account.numbers
        .filter((n) => !existingSids.has(n.sid))
        .map((n) => ({
          org_id: targetOrgId,
          phone_number: n.phone_number,
          twilio_sid: n.sid,
          friendly_name: n.friendly_name,
          capabilities: n.capabilities,
          status: "active",
          sms_route: "clara",
          webhook_configured: false,
        }));

      let inserted = 0;
      if (toInsert.length > 0) {
        const { error } = await supabase.from("twilio_numbers").insert(toInsert);
        if (error) return jsonRes({ error: error.message }, 400);
        inserted = toInsert.length;
      }
      return jsonRes({
        ok: true,
        accountTotal: account.numbers.length,
        inserted,
        alreadyImported: account.numbers.length - inserted,
      });
    }

    // ────────── Super-admin actions ──────────
    if (action === "account_list" || action === "assign" || action === "unassign") {
      const su = await isCallerSuperAdmin(req.headers.get("Authorization"));
      if (!su.ok) return jsonRes({ error: "Super admin only" }, 403);

      const creds = getTwilioEnvCreds();
      if (!creds) return jsonRes({ error: "Twilio not configured" }, 400);

      if (action === "account_list") {
        const result = await listTwilioNumbers(creds.accountSid, creds.authToken);
        if (!result.ok) {
          return jsonRes({ error: result.error ?? "Twilio listing failed" }, 502);
        }

        // Pull every twilio_numbers row across all orgs so we can surface
        // the current per-number org assignment alongside the Twilio list.
        const { data: rows } = await supabase
          .from("twilio_numbers")
          .select(
            "id, org_id, twilio_sid, phone_number, organizations(id, name, display_name)",
          );

        type Row = {
          id: string;
          org_id: string;
          twilio_sid: string;
          phone_number: string;
          organizations?: { id: string; name: string; display_name: string | null };
        };
        const bySid = new Map<string, Row>();
        for (const r of (rows ?? []) as Row[]) {
          bySid.set(r.twilio_sid, r);
        }

        const numbers = result.numbers.map((n) => {
          const matched = bySid.get(n.sid);
          return {
            sid: n.sid,
            phone_number: n.phone_number,
            friendly_name: n.friendly_name,
            capabilities: n.capabilities,
            country_code: null,
            assigned_org_id: matched?.org_id ?? null,
            assigned_org_name:
              matched?.organizations?.display_name ?? matched?.organizations?.name ?? null,
            db_row_id: matched?.id ?? null,
          };
        });

        return jsonRes({ ok: true, numbers });
      }

      if (action === "assign") {
        const sid = body.sid as string;
        const targetOrgId = body.orgId as string;
        if (!sid || !targetOrgId) return jsonRes({ error: "sid and orgId required" }, 400);

        // Verify the org actually exists
        const { data: orgRow } = await supabase
          .from("organizations")
          .select("id")
          .eq("id", targetOrgId)
          .maybeSingle();
        if (!orgRow) return jsonRes({ error: "Organization not found" }, 404);

        // Fetch the Twilio number metadata so we have phone_number etc. for an insert
        const account = await listTwilioNumbers(creds.accountSid, creds.authToken);
        if (!account.ok) {
          return jsonRes({ error: account.error ?? "Twilio listing failed" }, 502);
        }
        const tnum = account.numbers.find((n) => n.sid === sid);
        if (!tnum) return jsonRes({ error: "SID not found in Twilio account" }, 404);

        // First: try to find existing row by sid
        const { data: existingBySid } = await supabase
          .from("twilio_numbers")
          .select("id, org_id")
          .eq("twilio_sid", sid)
          .maybeSingle();

        if (existingBySid) {
          // If reassigning to a different org, reset routing fields so they
          // don't reference stale users in the prior org.
          const reset = existingBySid.org_id !== targetOrgId
            ? {
                sms_route: "clara",
                assigned_user_id: null,
                is_default_sms: false,
                is_default_voice: false,
                department_id: null,
              }
            : {};

          const { data, error } = await supabase
            .from("twilio_numbers")
            .update({
              org_id: targetOrgId,
              twilio_sid: sid,
              friendly_name: tnum.friendly_name,
              capabilities: tnum.capabilities,
              status: "active",
              webhook_configured: false,
              ...reset,
            })
            .eq("id", existingBySid.id)
            .select()
            .single();
          if (error) return jsonRes({ error: error.message }, 400);
          return jsonRes({ ok: true, row: data, action: "updated" });
        }

        // New insert
        const { data, error } = await supabase
          .from("twilio_numbers")
          .insert({
            org_id: targetOrgId,
            phone_number: tnum.phone_number,
            twilio_sid: sid,
            friendly_name: tnum.friendly_name,
            capabilities: tnum.capabilities,
            status: "active",
            sms_route: "clara",
            webhook_configured: false,
          })
          .select()
          .single();
        if (error) return jsonRes({ error: error.message }, 400);
        return jsonRes({ ok: true, row: data, action: "inserted" });
      }

      if (action === "unassign") {
        const sid = body.sid as string;
        if (!sid) return jsonRes({ error: "sid required" }, 400);
        const { error } = await supabase.from("twilio_numbers").delete().eq("twilio_sid", sid);
        if (error) return jsonRes({ error: error.message }, 400);
        return jsonRes({ ok: true });
      }
    }

    // ────────── Per-org actions ──────────
    // F-25: derive orgId from JWT for the per-org path. Previously took orgId
    // from the request body with no check, so any authenticated user (super
    // admin OR not) could sync/update/delete twilio_numbers rows for any org.
    // The super-admin path above is intentionally distinct and stays as-is.
    const userContext = await extractUserContext(req, supabase);
    if (!userContext) return jsonRes({ error: "Unauthorized" }, 401);
    if (!userContext.orgId) return jsonRes({ error: "No organization for caller" }, 403);
    const bodyOrgId = body.orgId as string | undefined;
    if (bodyOrgId && bodyOrgId !== userContext.orgId && !userContext.isSuperAdmin) {
      console.warn(`[twilio-numbers] org mismatch: body=${bodyOrgId} caller=${userContext.orgId}`);
      return jsonRes({ error: "Forbidden" }, 403);
    }
    const orgId = userContext.isSuperAdmin && bodyOrgId ? bodyOrgId : userContext.orgId;

    if (action === "sync") {
      // Org admin metadata refresh: update friendly_name / capabilities /
      // status on numbers this org already owns. Does NOT pull in new
      // numbers from Twilio — super admins do that via account_list/assign.
      const creds = getTwilioEnvCreds();
      if (!creds) return jsonRes({ error: "Twilio not configured" }, 400);

      const result = await listTwilioNumbers(creds.accountSid, creds.authToken);
      if (!result.ok) return jsonRes({ error: result.error ?? "Twilio sync failed" }, 502);

      const bySid = new Map(result.numbers.map((n) => [n.sid, n]));

      const { data: ownNumbers } = await supabase
        .from("twilio_numbers")
        .select("id, twilio_sid, phone_number")
        .eq("org_id", orgId);

      let updated = 0;
      let unchanged = 0;
      let stale = 0;

      for (const row of ownNumbers ?? []) {
        const tnum = bySid.get(row.twilio_sid as string);
        if (!tnum) {
          stale++;
          continue;
        }
        // webhook_configured is DERIVED from Twilio, not carried over from whatever a human last
        // clicked. It was a hand-maintained flag with nothing behind it, and it drifted badly:
        // +1 813-555-0100 read false in the OS while both of its URLs were live and answering.
        // A stale "unconfigured" on a working number is worse than a plain misconfiguration,
        // because it makes a healthy number look broken and a broken one look the same.
        //
        // "Configured" means Twilio has somewhere to send inbound traffic. Deliberately NOT a check
        // that the URL points at us — an agent-fronted number (sms_route='external') is correctly
        // configured while pointing at a third party, and Clara's own numbers point at her tunnel
        // rather than at this project.
        const webhookConfigured = Boolean(tnum.voice_url?.trim() || tnum.sms_url?.trim());

        await supabase
          .from("twilio_numbers")
          .update({
            twilio_sid: tnum.sid,
            friendly_name: tnum.friendly_name,
            capabilities: tnum.capabilities,
            webhook_configured: webhookConfigured,
          })
          .eq("id", row.id as string);
        updated++;
      }
      unchanged = (ownNumbers?.length ?? 0) - updated - stale;

      return jsonRes({
        ok: true,
        updated,
        unchanged,
        stale,
        total: ownNumbers?.length ?? 0,
        message: "Metadata refreshed. New Twilio numbers must be assigned by a super admin.",
      });
    }

    if (action === "update") {
      const id = body.id as string;
      const patch = (body.patch ?? {}) as Record<string, unknown>;
      if (!id) return jsonRes({ error: "id required" }, 400);

      const allowed = [
        "sms_route",
        "assigned_user_id",
        "is_default_sms",
        "is_default_voice",
        "department_id",
        "webhook_configured",
        "friendly_name",
        "status",
        "agent_label",
      ];
      const clean: Record<string, unknown> = {};
      for (const k of allowed) {
        if (k in patch) clean[k] = patch[k];
      }

      if (clean.is_default_sms === true) {
        await supabase
          .from("twilio_numbers")
          .update({ is_default_sms: false })
          .eq("org_id", orgId)
          .neq("id", id);
      }
      if (clean.is_default_voice === true) {
        await supabase
          .from("twilio_numbers")
          .update({ is_default_voice: false })
          .eq("org_id", orgId)
          .neq("id", id);
      }

      const { data, error } = await supabase
        .from("twilio_numbers")
        .update(clean)
        .eq("id", id)
        .eq("org_id", orgId)
        .select()
        .single();

      if (error) return jsonRes({ error: error.message }, 400);
      return jsonRes({ ok: true, row: data });
    }

    if (action === "delete") {
      const id = body.id as string;
      if (!id) return jsonRes({ error: "id required" }, 400);
      const { error } = await supabase
        .from("twilio_numbers")
        .delete()
        .eq("id", id)
        .eq("org_id", orgId);
      if (error) return jsonRes({ error: error.message }, 400);
      return jsonRes({ ok: true });
    }

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("[twilio-numbers] error:", e);
    return jsonRes({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
