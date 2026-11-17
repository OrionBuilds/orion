import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isCronRequest } from "../_shared/auth.ts";
import { getSamApiKey } from "../_shared/sam-key.ts";
import { buildSearchQuery, formatSamDate, SAM_OPPORTUNITIES_URL } from "../_shared/sam-opportunities.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** alert_frequency is 'daily' | 'weekly'; the job runs daily, so weekly searches are skipped until a week has passed. */
function isDue(lastCheckedAt: string | null, frequency: string | null, now: number): boolean {
  if (!lastCheckedAt) return true;
  const age = now - Date.parse(lastCheckedAt);
  return age >= (frequency === "weekly" ? 6.5 : 0.8) * DAY_MS;
}

/** Pause execution to stay within SAM.gov rate limits. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // sends SAM.gov opportunity alerts with the service-role key and had no caller check while deployed
  // verify_jwt=false, so anyone with the URL could invoke it. Verified caller-less before
  // gating: no frontend reference, no edge-function invocation, absent from cron.job.
  if (!isCronRequest(req)) {
    console.warn("[sam-gov-alert-cron] rejected request without a valid cron secret");
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const startTime = Date.now();
  console.log("[sam-gov-alert-cron] Starting SAM.gov alert check");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Fetch all saved searches that have alerts enabled
    const { data: savedSearches, error: ssError } = await supabase
      .from("gov_saved_searches")
      .select("id, user_id, org_id, search_criteria, last_checked_at, alert_frequency")
      .eq("alert_enabled", true);

    if (ssError) {
      console.error(
        "[sam-gov-alert-cron] Failed to load saved searches:",
        ssError.message
      );
      throw new Error(`Failed to load saved searches: ${ssError.message}`);
    }

    if (!savedSearches || savedSearches.length === 0) {
      console.log("[sam-gov-alert-cron] No saved searches with alerts enabled");
      return new Response(
        JSON.stringify({ success: true, message: "No alerts to process", alertsSent: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[sam-gov-alert-cron] Processing ${savedSearches.length} saved searches`
    );

    let totalAlertsSent = 0;
    const keys = new Map<string, string | null>();

    // 2. Process each saved search
    for (let i = 0; i < savedSearches.length; i++) {
      const search = savedSearches[i];

      // Space out requests to respect SAM.gov rate limits (10 req/day for
      // non-federal users). Wait 2 seconds between calls.
      if (!isDue(search.last_checked_at, search.alert_frequency, Date.now())) continue;
      if (i > 0) {
        await sleep(2000);
      }

      try {
        const apiKey = keys.has(search.org_id) ? keys.get(search.org_id)! : (await getSamApiKey(supabase, search.org_id));
        keys.set(search.org_id, apiKey);
        if (!apiKey) {
          console.warn(`[sam-gov-alert-cron] org ${search.org_id} has no SAM.gov API key; skipping search ${search.id}`);
          continue;
        }
        const criteria = (search.search_criteria ?? {}) as Record<
          string,
          unknown
        >;

        // Build date range: from last_checked_at (or 1 day ago) until now
        const now = new Date();
        const postedFrom = search.last_checked_at
          ? new Date(search.last_checked_at)
          : new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // Dates are Eastern calendar days (SAM posts on Eastern days). postedFrom is the day of the last check, so a
        // notice posted that same day is seen again: the notifications check below keeps it from alerting twice.
        const qp = buildSearchQuery(apiKey, {
          keywords: criteria.keywords ? String(criteria.keywords) : undefined,
          naicsCode: criteria.naicsCode ? String(criteria.naicsCode) : undefined,
          pscCode: criteria.pscCode ? String(criteria.pscCode) : undefined,
          setAsideType: criteria.setAsideType ? String(criteria.setAsideType) : undefined,
          state: criteria.state ? String(criteria.state) : undefined,
          agencyName: criteria.agencyName ? String(criteria.agencyName) : undefined,
          procurementType: criteria.procurementType ? String(criteria.procurementType) : undefined,
          postedFrom: formatSamDate(postedFrom),
          postedTo: formatSamDate(now),
          limit: 100,
        });

        const url = `${SAM_OPPORTUNITIES_URL}?${qp.toString()}`;
        console.log(
          `[sam-gov-alert-cron] Search ${search.id}: ${url.replace(/api_key=[^&]+/, "api_key=***")}`
        );

        const response = await fetch(url);

        if (response.status === 429) {
          console.warn(
            "[sam-gov-alert-cron] SAM.gov rate limit hit. Stopping further requests."
          );
          break;
        }

        if (response.status === 401 || response.status === 403) {
          console.error(
            `[sam-gov-alert-cron] SAM.gov rejected the API key (${response.status}); keys expire every 90 days. Skipping search ${search.id}.`
          );
          continue;
        }

        // 404 is SAM's "no data found": an empty result, so the search is still marked as checked.
        if (!response.ok && response.status !== 404) {
          console.error(
            `[sam-gov-alert-cron] SAM.gov returned ${response.status} for search ${search.id}`
          );
          continue;
        }

        const data = (response.status === 404 ? {} : await response.json()) as Record<string, unknown>;
        const opportunities = (data.opportunitiesData ?? []) as Array<
          Record<string, unknown>
        >;

        if (opportunities.length === 0) {
          // No new results — just update the timestamp
          await supabase
            .from("gov_saved_searches")
            .update({ last_checked_at: now.toISOString(), results_count: 0 })
            .eq("id", search.id);
          continue;
        }

        // 3. Filter out opportunities already imported for this org
        const noticeIds = opportunities
          .map((o) => o.noticeId as string)
          .filter(Boolean);

        const { data: existingImports } = await supabase
          .from("gov_opportunity_imports")
          .select("sam_notice_id")
          .eq("org_id", search.org_id)
          .in("sam_notice_id", noticeIds);

        const existingSet = new Set(
          (existingImports ?? []).map(
            (r: { sam_notice_id: string }) => r.sam_notice_id
          )
        );

        // Skip notices this user was already alerted about (the date window overlaps between runs).
        const { data: alreadyAlerted } = await supabase
          .from("notifications")
          .select("metadata")
          .eq("user_id", search.user_id)
          .eq("type", "gov_opportunity")
          .in("metadata->>notice_id", noticeIds);
        const alertedSet = new Set(
          (alreadyAlerted ?? []).map((r: { metadata: { notice_id?: string } | null }) => r.metadata?.notice_id)
        );

        const newOpportunities = opportunities.filter(
          (o) => o.noticeId && !existingSet.has(o.noticeId as string) && !alertedSet.has(o.noticeId as string)
        );

        // 4. Create notifications for each new opportunity
        if (newOpportunities.length > 0) {
          const notifications = newOpportunities.map((opp) => ({
            user_id: search.user_id,
            type: "gov_opportunity",
            title: "New Government Opportunity",
            body: `${opp.title ?? "Untitled"} — ${opp.fullParentPathName ?? "Unknown Agency"}`,
            link: "/opportunities/government",
            metadata: {
              notice_id: opp.noticeId,
              solicitation_number: opp.solicitationNumber,
              saved_search_id: search.id,
            },
          }));

          const { error: notifErr } = await supabase
            .from("notifications")
            .insert(notifications);

          if (notifErr) {
            console.error(
              `[sam-gov-alert-cron] Failed to insert notifications for search ${search.id}:`,
              notifErr.message
            );
          } else {
            totalAlertsSent += newOpportunities.length;
            console.log(
              `[sam-gov-alert-cron] Sent ${newOpportunities.length} notifications for search ${search.id}`
            );
          }
        }

        // 5. Update the saved search record
        await supabase
          .from("gov_saved_searches")
          .update({
            last_checked_at: now.toISOString(),
            results_count: newOpportunities.length,
          })
          .eq("id", search.id);
      } catch (searchErr) {
        console.error(
          `[sam-gov-alert-cron] Error processing search ${search.id}:`,
          (searchErr as Error).message
        );
        // Continue to next search instead of aborting the whole run
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[sam-gov-alert-cron] Complete. ${totalAlertsSent} alerts sent in ${elapsed}ms`
    );

    return new Response(
      JSON.stringify({
        success: true,
        searchesProcessed: savedSearches.length,
        alertsSent: totalAlertsSent,
        elapsedMs: elapsed,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error(
      "[sam-gov-alert-cron] Fatal error:",
      (error as Error).message
    );
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
