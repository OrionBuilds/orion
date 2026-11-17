import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  handleCors,
  jsonResponse,
  errorResponse,
  successResponse,
} from "../_shared/cors.ts";
import {
  getSupabaseClient,
  extractUserContext,
  requireAuth,
} from "../_shared/auth.ts";
import { type SamDocResult, syncSamDocuments } from "../_shared/sam-documents.ts";
import { getSamApiKey, samKeyStore } from "../_shared/sam-key.ts";
import { buildSearchQuery, noticeLookupRange, SAM_OPPORTUNITIES_URL, SamRequestError } from "../_shared/sam-opportunities.ts";

// ---------------------------------------------------------------------------
// SAM.gov API endpoints
// ---------------------------------------------------------------------------
const SAM_PSC_URL =
  "https://api.sam.gov/prod/locationservices/v1/api/publicpscdetails";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = samKeyStore.getStore() ?? Deno.env.get("SAM_GOV_API_KEY");
  if (!key) {
    throw new Error("No SAM.gov API key. Add it in Settings → Integrations → SAM.gov.");
  }
  return key;
}

/** Hosts we are willing to send SAM_GOV_API_KEY to. Anything else is rejected
 *  so a caller-supplied description URL can't exfiltrate the key or be used to
 *  reach internal/metadata endpoints. */
const SAM_ALLOWED_HOSTS = new Set([
  "api.sam.gov",
  "sam.gov",
  "www.sam.gov",
]);

/**
 * Validates an externally-supplied description URL. Returns the URL with the
 * API key appended, or null when the URL is not a trusted https SAM.gov URL.
 * A caller-supplied `api_key` parameter is always stripped and replaced.
 */
function buildTrustedSamDescriptionUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!SAM_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  parsed.username = "";
  parsed.password = "";
  parsed.searchParams.delete("api_key");
  parsed.searchParams.set("api_key", getApiKey());
  return parsed;
}

/**
 * Perform a fetch against SAM.gov with basic error handling.
 * Throws on HTTP errors and surfaces rate-limit responses.
 */
async function fetchSamApi(url: string, opts: { emptyOn404?: unknown } = {}): Promise<unknown> {
  console.log(`[sam-gov-api] Fetching: ${url.replace(/api_key=[^&]+/, "api_key=***")}`);

  const response = await fetch(url);

  if (response.status === 429) {
    throw new SamRateLimitError(
      "SAM.gov API daily request limit reached (the limit depends on the account that owns the API key). " +
        "Try again tomorrow, or use a key from a SAM.gov account with a role."
    );
  }

  // SAM answers "no matching data" with 404, which is an empty result, not a failure.
  if (response.status === 404 && opts.emptyOn404 !== undefined) return opts.emptyOn404;

  if (!response.ok) {
    const body = await response.text();
    console.error(`[sam-gov-api] SAM.gov responded ${response.status}: ${body}`);
    // SAM.gov public API keys expire every 90 days and come back as an HTML API_KEY_INVALID page.
    if (response.status === 401 || /API_KEY_INVALID/.test(body)) {
      throw new Error(
        "The SAM.gov API key was rejected (keys expire every 90 days). Generate a new one at " +
          "sam.gov → Workspace → Profile → Public API Key, then update it in Settings → Integrations → SAM.gov."
      );
    }
    throw new Error(
      `SAM.gov API returned status ${response.status}: ${body.slice(0, 300)}`
    );
  }

  return response.json();
}

class SamRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamRateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

interface SearchOpportunitiesParams {
  keywords?: string;
  naicsCode?: string;
  pscCode?: string;
  setAsideType?: string;
  state?: string;
  agencyName?: string;
  procurementType?: string;
  postedFrom?: string;
  postedTo?: string;
  limit?: number;
  offset?: number;
}

async function searchOpportunities(
  params: SearchOpportunitiesParams
): Promise<unknown> {
  const qp = buildSearchQuery(getApiKey(), params);
  const url = `${SAM_OPPORTUNITIES_URL}?${qp.toString()}`;
  return fetchSamApi(url, { emptyOn404: { totalRecords: 0, opportunitiesData: [] } });
}

async function getOpportunity(noticeId: string, postedDate?: string | null): Promise<unknown> {
  if (!noticeId) {
    throw new Error("noticeId is required");
  }

  // A noticeid lookup still needs postedFrom/postedTo (SAM: "PostedFrom and PostedTo are mandatory").
  const range = noticeLookupRange(postedDate);
  const url =
    `${SAM_OPPORTUNITIES_URL}?api_key=${getApiKey()}&noticeid=${encodeURIComponent(noticeId)}` +
    `&postedFrom=${encodeURIComponent(range.postedFrom)}&postedTo=${encodeURIComponent(range.postedTo)}&limit=1&offset=0`;

  const data = (await fetchSamApi(url, { emptyOn404: { totalRecords: 0, opportunitiesData: [] } })) as Record<string, unknown>;

  // The API returns opportunities inside opportunitiesData or similar wrapper
  const opportunities =
    (data.opportunitiesData as unknown[]) ?? (data as unknown as unknown[]);

  if (Array.isArray(opportunities) && opportunities.length > 0) {
    return opportunities[0];
  }

  throw new Error(`Opportunity with noticeId "${noticeId}" not found`);
}

interface SearchPscParams {
  query: string;
  active?: string;
  limit?: number;
}

async function searchPsc(params: SearchPscParams): Promise<unknown> {
  if (!params.query) {
    throw new Error("query is required for PSC search");
  }

  const apiKey = getApiKey();
  const active = params.active ?? "Y";
  const limit = params.limit ?? 25;
  const url =
    `${SAM_PSC_URL}?api_key=${apiKey}&q=${encodeURIComponent(params.query)}&active=${active}&limit=${limit}`;

  return fetchSamApi(url);
}

// ---------------------------------------------------------------------------
// Import opportunity into the CRM pipeline
// ---------------------------------------------------------------------------

interface SamOpportunityData {
  title?: string;
  solicitationNumber?: string;
  noticeId?: string;
  fullParentPathName?: string;
  type?: string;
  responseDeadLine?: string;
  postedDate?: string;
  naicsCode?: string;
  typeOfSetAside?: string;
  award?: { amount?: number };
  // Allow extra fields from the raw SAM.gov response
  [key: string]: unknown;
}

interface ImportOpportunityParams {
  samData: SamOpportunityData;
  contactId?: string;
}

async function importOpportunity(
  // Untyped client (no generated DB types in edge functions); see _shared/auth.ts.
  // deno-lint-ignore no-explicit-any
  supabase: any,
  orgId: string,
  userId: string,
  params: ImportOpportunityParams
): Promise<{ opportunityId: string; contactId?: string; documents?: DocumentsSummary }> {
  const { samData, contactId } = params;

  if (!samData || !samData.title) {
    throw new Error("samData with at least a title is required for import");
  }

  // 0. Re-importing the same notice must not create a second opportunity.
  const samNoticeId = samData.noticeId ? String(samData.noticeId) : null;
  if (samNoticeId) {
    const { data: alreadyImported } = await supabase
      .from("opportunities")
      .select("id, contact_id")
      .eq("org_id", orgId)
      .eq("source", "sam_gov")
      .eq("external_source_id", samNoticeId)
      .maybeSingle();

    if (alreadyImported) {
      console.log(`[sam-gov-api] Notice ${samNoticeId} already imported — reusing opportunity`);
      // Pick up any documents a previous import did not finish (no-op for stored ones).
      const documents = await refreshOpportunityDocuments(supabase, orgId, userId, alreadyImported.id as string, {})
        .catch((e) => { console.warn("[sam-gov-api] document refresh on re-import failed:", (e as Error).message); return undefined; });
      return {
        opportunityId: alreadyImported.id as string,
        contactId: (alreadyImported.contact_id as string | undefined) ?? undefined,
        documents,
      };
    }
  }

  // 1. Find the "Government" pipeline for this org
  const { data: pipeline, error: pipelineErr } = await supabase
    .from("pipelines")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", "Government")
    .maybeSingle();

  if (pipelineErr) {
    console.error("[sam-gov-api] Pipeline lookup error:", pipelineErr.message);
    throw new Error("Failed to find Government pipeline");
  }
  if (!pipeline) {
    throw new Error(
      'No "Government" pipeline found for this organization. ' +
        "Please create one before importing SAM.gov opportunities."
    );
  }

  // 2. Find the "Identified" stage
  const { data: stage, error: stageErr } = await supabase
    .from("pipeline_stages")
    .select("id")
    .eq("pipeline_id", pipeline.id)
    .eq("name", "Identified")
    .maybeSingle();

  if (stageErr) {
    console.error("[sam-gov-api] Stage lookup error:", stageErr.message);
    throw new Error("Failed to find Identified stage");
  }
  if (!stage) {
    throw new Error(
      'No "Identified" stage found in the Government pipeline. ' +
        "Please add one before importing."
    );
  }

  // 3. Create or find contact from SAM.gov Point of Contact
  const pocArray = samData.pointOfContact as Array<{
    fullName?: string; email?: string; phone?: string; title?: string; type?: string;
  }> | undefined;
  const poc = pocArray?.find((p) => p.type === "primary") || pocArray?.[0];
  let resolvedContactId = contactId || null;

  if (!resolvedContactId && poc?.email) {
    // Check if a contact with this email already exists
    const { data: existingContact } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .ilike("email", poc.email.trim())
      .maybeSingle();

    if (existingContact) {
      resolvedContactId = existingContact.id;
      console.log(`[sam-gov-api] Found existing contact ${resolvedContactId} for POC ${poc.email}`);
    } else {
      // Create a new contact from the POC
      const nameParts = (poc.fullName || "Government POC").trim().split(/\s+/);
      const firstName = nameParts[0] || "Government";
      const lastName = nameParts.slice(1).join(" ") || "POC";

      const { data: newContact, error: contactErr } = await supabase
        .from("contacts")
        .insert({
          organization_id: orgId,
          first_name: firstName,
          last_name: lastName,
          email: poc.email.trim(),
          phone: poc.phone || null,
          job_title: poc.title || null,
          company: (samData.fullParentPathName as string) || (samData.department as string) || null,
          source: "sam_gov",
        })
        .select("id")
        .single();

      if (contactErr) {
        console.error("[sam-gov-api] Contact creation failed:", contactErr.message);
        // Don't fail the import — create opportunity without contact
      } else {
        resolvedContactId = newContact.id;
        console.log(`[sam-gov-api] Created new contact ${resolvedContactId} from POC ${poc.email}`);
      }
    }
  }

  // If still no contact, create a placeholder
  if (!resolvedContactId) {
    const placeholderName = (samData.fullParentPathName as string) || (samData.department as string) || "SAM.gov Opportunity";
    const { data: placeholderContact } = await supabase
      .from("contacts")
      .insert({
        organization_id: orgId,
        first_name: placeholderName.substring(0, 50),
        last_name: "POC",
        company: placeholderName,
        source: "sam_gov",
      })
      .select("id")
      .single();
    resolvedContactId = placeholderContact?.id || null;
  }

  if (!resolvedContactId) {
    throw new Error("Failed to create or find a contact for this opportunity");
  }

  // 4. Parse close date from SAM.gov responseDeadLine (date column, needs YYYY-MM-DD)
  let closeDate: string | null = null;
  if (samData.responseDeadLine) {
    try {
      const d = new Date(samData.responseDeadLine as string);
      closeDate = d.toISOString().split("T")[0]; // YYYY-MM-DD
    } catch {
      console.warn("[sam-gov-api] Could not parse responseDeadLine:", samData.responseDeadLine);
    }
  }

  // 5. Build rich description with all solicitation details
  // If the description field is a URL (SAM.gov returns a URL, not text), fetch real content
  let descriptionText = samData.description ? String(samData.description) : "";
  if (descriptionText.startsWith("http")) {
    try {
      const descFetchUrl = buildTrustedSamDescriptionUrl(descriptionText);
      if (!descFetchUrl) {
        throw new Error("description URL is not a trusted https SAM.gov URL");
      }
      const descFetchResp = await fetch(descFetchUrl.toString());
      if (descFetchResp.ok) {
        let rawContent = await descFetchResp.text();
        try {
          const parsed = JSON.parse(rawContent);
          if (parsed.description) rawContent = parsed.description;
          else if (parsed.data) rawContent = parsed.data;
        } catch {
          // Fall back to raw string if not JSON
        }
        
        descriptionText = rawContent
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<\/li>/gi, "\n")
          .replace(/<[^>]*>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        console.log(`[sam-gov-api] Fetched real description (${descriptionText.length} chars)`);
      }
    } catch (e) {
      console.warn("[sam-gov-api] Could not fetch description from URL:", e);
    }
  }

  const descParts: string[] = [];
  if (descriptionText) descParts.push(descriptionText);
  descParts.push("");
  descParts.push(`Solicitation: ${samData.solicitationNumber || "N/A"}`);
  descParts.push(`Agency: ${(samData.fullParentPathName as string) || (samData.department as string) || "N/A"}`);
  if (samData.naicsCode) descParts.push(`NAICS: ${samData.naicsCode}`);
  if (samData.classificationCode) descParts.push(`PSC: ${samData.classificationCode}`);
  if (samData.typeOfSetAsideDescription || samData.typeOfSetAside) {
    descParts.push(`Set-Aside: ${samData.typeOfSetAsideDescription || samData.typeOfSetAside}`);
  }
  if (samData.responseDeadLine) descParts.push(`Deadline: ${samData.responseDeadLine}`);
  if (samData.postedDate) descParts.push(`Posted: ${samData.postedDate}`);
  if (samData.type) descParts.push(`Type: ${samData.type}`);
  if (poc) {
    descParts.push("");
    descParts.push("Point of Contact:");
    if (poc.fullName) descParts.push(`  Name: ${poc.fullName}`);
    if (poc.email) descParts.push(`  Email: ${poc.email}`);
    if (poc.phone) descParts.push(`  Phone: ${poc.phone}`);
    if (poc.title) descParts.push(`  Title: ${poc.title}`);
  }
  if (samData.uiLink) {
    descParts.push("");
    descParts.push(`SAM.gov Link: ${samData.uiLink}`);
  }
  const description = descParts.join("\n");

  // 6. Create the opportunity record with all required fields
  const { data: opportunity, error: oppErr } = await supabase
    .from("opportunities")
    .insert({
      org_id: orgId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: resolvedContactId,
      created_by: userId,
      name: samData.title,
      description: description,
      value_amount: samData.award?.amount ?? 0,
      source: "sam_gov",
      external_source_id: samNoticeId,
      close_date: closeDate,
      status: "open",
    })
    .select("id")
    .single();

  if (oppErr) {
    // 23505: two concurrent imports of the same notice raced past the lookup above.
    // The partial unique index on (org_id, source, external_source_id) rejects the
    // loser, which then reuses the row the winner committed.
    if (oppErr.code === "23505" && samNoticeId) {
      const { data: raced } = await supabase
        .from("opportunities")
        .select("id, contact_id")
        .eq("org_id", orgId)
        .eq("source", "sam_gov")
        .eq("external_source_id", samNoticeId)
        .maybeSingle();

      if (raced) {
        return {
          opportunityId: raced.id as string,
          contactId: (raced.contact_id as string | undefined) ?? undefined,
        };
      }
    }
    console.error("[sam-gov-api] Opportunity insert error:", oppErr.message);
    throw new Error(`Failed to create opportunity: ${oppErr.message}`);
  }

  // 6a. Add description to opportunity_notes
  if (description) {
    const { error: noteErr } = await supabase
      .from("opportunity_notes")
      .insert({
        org_id: orgId,
        opportunity_id: opportunity.id,
        body: description,
        created_by: userId,
      });
    if (noteErr) console.error("[sam-gov-api] Failed to insert note:", noteErr.message);
  }

  // 6b. Download the notice's solicitation documents (resourceLinks) server-side, store them
  //     privately, attach them to the opportunity and extract their text for the AI generators.
  //     Bounded by a time budget; anything left over is picked up by `refresh-documents`.
  const resourceLinks = Array.isArray(samData.resourceLinks)
    ? (samData.resourceLinks as unknown[]).filter((l): l is string => typeof l === "string")
    : [];
  let documents: SamDocResult[] = [];
  if (resourceLinks.length > 0) {
    try {
      documents = await syncSamDocuments(supabase, {
        orgId,
        userId,
        opportunityId: opportunity.id,
        noticeId: samNoticeId,
        resourceLinks,
        apiKey: getApiKey(),
        noticeUiLink: trustedNoticeUiLink(samData),
        budgetMs: IMPORT_DOCUMENT_BUDGET_MS,
      });
    } catch (e) {
      console.error("[sam-gov-api] Document import failed:", (e as Error).message);
    }
  }

  // 7. Create the gov_opportunity_imports audit record with full SAM.gov snapshot
  // sam_notice_id is NOT NULL — use noticeId or solicitationNumber as fallback
  const noticeIdValue = samData.noticeId || samData.solicitationNumber || `import-${Date.now()}`;

  // sam_posted_date and sam_response_deadline are timestamptz — parse into ISO strings
  let samPostedDate: string | null = null;
  let samResponseDeadline: string | null = null;
  try { if (samData.postedDate) samPostedDate = new Date(samData.postedDate as string).toISOString(); } catch { /* skip */ }
  try { if (samData.responseDeadLine) samResponseDeadline = new Date(samData.responseDeadLine as string).toISOString(); } catch { /* skip */ }

  const { error: importErr } = await supabase
    .from("gov_opportunity_imports")
    .insert({
      org_id: orgId,
      opportunity_id: opportunity.id,
      sam_notice_id: noticeIdValue,
      sam_solicitation_number: samData.solicitationNumber ?? null,
      sam_title: samData.title ?? null,
      sam_agency: (samData.fullParentPathName as string) ?? null,
      sam_posted_date: samPostedDate,
      sam_response_deadline: samResponseDeadline,
      sam_set_aside: samData.typeOfSetAside ?? null,
      sam_naics_code: samData.naicsCode ?? null,
      sam_type: samData.type ?? null,
      sam_data: samData,
      imported_by: userId,
    });

  if (importErr) {
    console.error("[sam-gov-api] gov_opportunity_imports insert error:", importErr.message);
  }

  // 8. Create a timeline event on the opportunity
  try {
    await supabase.from("activity_log").insert({
      organization_id: orgId,
      user_id: userId,
      entity_type: "opportunity",
      entity_id: opportunity.id,
      event_type: "imported",
      summary: `Imported from SAM.gov: ${samData.solicitationNumber || samData.noticeId || "N/A"}`,
      payload: {
        source: "sam_gov",
        notice_id: samData.noticeId,
        solicitation_number: samData.solicitationNumber,
        agency: samData.fullParentPathName,
      },
    });
  } catch { /* activity log is non-critical */ }

  console.log(`[sam-gov-api] Imported SAM.gov opportunity ${samData.noticeId} as ${opportunity.id} (contact: ${resolvedContactId})`);

  return { opportunityId: opportunity.id, contactId: resolvedContactId, documents: summarizeDocuments(documents) };
}

// ---------------------------------------------------------------------------
// Solicitation documents
// ---------------------------------------------------------------------------

/** Wall-clock budget for downloading documents inside the import request itself. */
const IMPORT_DOCUMENT_BUDGET_MS = 75_000;
/** Budget for an explicit "Refresh documents" request. */
const REFRESH_DOCUMENT_BUDGET_MS = 110_000;

interface DocumentsSummary {
  total: number;
  stored: number;
  unchanged: number;
  failed: number;
  pending: number;
  no_text: number;
  items: SamDocResult[];
}

function summarizeDocuments(items: SamDocResult[]): DocumentsSummary {
  const count = (s: SamDocResult["status"]) => items.filter((d) => d.status === s).length;
  return {
    total: items.length,
    stored: count("stored"),
    unchanged: count("unchanged"),
    failed: count("failed"),
    pending: count("pending"),
    no_text: items.filter((d) => d.text_status === "no_text").length,
    items,
  };
}

/** The notice's public SAM.gov page, only when it really is a SAM.gov https URL. */
function trustedNoticeUiLink(samData: Record<string, unknown>): string | null {
  const ui = typeof samData.uiLink === "string" ? samData.uiLink : null;
  try {
    if (ui) {
      const u = new URL(ui);
      if (u.protocol === "https:" && SAM_ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return u.toString();
    }
  } catch { /* ignore */ }
  return samData.noticeId ? `https://sam.gov/opp/${encodeURIComponent(String(samData.noticeId))}/view` : null;
}

/**
 * (Re)downloads the solicitation documents of an imported SAM.gov opportunity.
 * `refetch` pulls the notice from the SAM.gov API again (picks up amendments; costs one API call);
 * otherwise the resourceLinks saved at import time are used, falling back to the API when the
 * import snapshot has none. `force` re-downloads documents that are already stored.
 */
async function refreshOpportunityDocuments(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  orgId: string,
  userId: string,
  opportunityId: string,
  opts: { refetch?: boolean; force?: boolean },
): Promise<DocumentsSummary> {
  const { data: opp } = await supabase
    .from("opportunities")
    .select("id, org_id, source, external_source_id")
    .eq("id", opportunityId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!opp) throw new Error("Opportunity not found");
  if (opp.source !== "sam_gov") throw new Error("Only SAM.gov opportunities have solicitation documents");

  const { data: imp } = await supabase
    .from("gov_opportunity_imports")
    .select("id, sam_notice_id, sam_data")
    .eq("org_id", orgId)
    .eq("opportunity_id", opportunityId)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let samData = (imp?.sam_data ?? {}) as Record<string, unknown>;
  const noticeId = (opp.external_source_id as string | null) ?? (samData.noticeId as string | undefined) ?? null;
  let links = Array.isArray(samData.resourceLinks)
    ? (samData.resourceLinks as unknown[]).filter((l): l is string => typeof l === "string")
    : [];

  if ((opts.refetch || links.length === 0) && noticeId) {
    const fresh = (await getOpportunity(noticeId, typeof samData.postedDate === "string" ? samData.postedDate : null)) as Record<string, unknown>;
    samData = { ...samData, ...fresh };
    links = Array.isArray(fresh.resourceLinks)
      ? (fresh.resourceLinks as unknown[]).filter((l): l is string => typeof l === "string")
      : [];
    if (imp?.id) {
      await supabase.from("gov_opportunity_imports").update({ sam_data: samData }).eq("id", imp.id);
    }
  }

  const items = links.length === 0 ? [] : await syncSamDocuments(supabase, {
    orgId,
    userId,
    opportunityId,
    noticeId,
    resourceLinks: links,
    apiKey: getApiKey(),
    noticeUiLink: trustedNoticeUiLink(samData),
    force: !!opts.force,
    budgetMs: REFRESH_DOCUMENT_BUDGET_MS,
  });
  return summarizeDocuments(items);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate the caller
    const supabase = getSupabaseClient();
    const userContext = await extractUserContext(req, supabase);
    const user = requireAuth(userContext);
    // This org's key (Settings → Integrations → SAM.gov, else the SAM_GOV_API_KEY secret) for the rest of the request.
    samKeyStore.enterWith(await getSamApiKey(supabase, user.orgId));

    // Parse request body
    const body = await req.json().catch(() => ({}));
    const action = body.action as string | undefined;

    if (!action) {
      return errorResponse(
        "MISSING_ACTION",
        'Request body must include an "action" field',
        400
      );
    }

    console.log(
      `[sam-gov-api] Action: ${action} | User: ${user.id} | Org: ${user.orgId}`
    );

    switch (action) {
      // ---------------------------------------------------------------
      case "search-opportunities": {
        const result = await searchOpportunities({
          keywords: body.keywords,
          naicsCode: body.naicsCode,
          pscCode: body.pscCode,
          setAsideType: body.setAsideType,
          state: body.state,
          agencyName: body.agencyName,
          procurementType: body.procurementType,
          postedFrom: body.postedFrom,
          postedTo: body.postedTo,
          limit: body.limit,
          offset: body.offset,
        });
        return successResponse(result);
      }

      // ---------------------------------------------------------------
      case "get-opportunity": {
        const noticeId = body.noticeId as string | undefined;
        if (!noticeId) {
          return errorResponse(
            "MISSING_NOTICE_ID",
            "noticeId is required for get-opportunity",
            400
          );
        }
        const result = await getOpportunity(noticeId, typeof body.postedDate === "string" ? body.postedDate : null);
        return successResponse(result);
      }

      // ---------------------------------------------------------------
      case "search-psc": {
        const result = await searchPsc({
          query: body.query,
          active: body.active,
          limit: body.limit,
        });
        return successResponse(result);
      }

      // ---------------------------------------------------------------
      case "get-description": {
        const descNoticeId = body.noticeId as string | undefined;
        if (!descNoticeId) {
          return errorResponse(
            "MISSING_NOTICE_ID",
            "noticeId is required for get-description",
            400
          );
        }
        const apiKey = getApiKey();
        const descUrl = `https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=${encodeURIComponent(descNoticeId)}&api_key=${apiKey}`;
        console.log(`[sam-gov-api] Fetching description for ${descNoticeId}`);
        const descResp = await fetch(descUrl);
        if (!descResp.ok) {
          const descBody = await descResp.text();
          console.error(`[sam-gov-api] Description fetch failed ${descResp.status}: ${descBody.slice(0, 200)}`);
          return errorResponse("DESC_FETCH_FAILED", `Failed to fetch description: ${descResp.status}`, 502);
        }
        const descHtml = await descResp.text();
        // Strip HTML tags for plain text version
        const descPlainText = descHtml
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<\/li>/gi, "\n")
          .replace(/<[^>]*>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return successResponse({ html: descHtml, plainText: descPlainText });
      }

      // ---------------------------------------------------------------
      case "import-opportunity": {
        if (!body.samData) {
          return errorResponse(
            "MISSING_SAM_DATA",
            "samData object is required for import-opportunity",
            400
          );
        }
        const result = await importOpportunity(supabase, user.orgId, user.id, {
          samData: body.samData,
          contactId: body.contactId,
        });
        return successResponse(result);
      }

      // ---------------------------------------------------------------
      case "refresh-documents": {
        const opportunityId = body.opportunityId as string | undefined;
        if (!opportunityId) {
          return errorResponse("MISSING_OPPORTUNITY_ID", "opportunityId is required for refresh-documents", 400);
        }
        try {
          const result = await refreshOpportunityDocuments(supabase, user.orgId, user.id, opportunityId, {
            refetch: !!body.refetch,
            force: !!body.force,
          });
          return successResponse(result);
        } catch (e) {
          const err = e as Error;
          if (err.name === "SamRateLimitError") throw err;
          return errorResponse("REFRESH_FAILED", err.message, 400);
        }
      }

      // ---------------------------------------------------------------
      default:
        return errorResponse(
          "UNKNOWN_ACTION",
          `Unknown action: "${action}". ` +
            "Supported actions: search-opportunities, get-opportunity, get-description, search-psc, import-opportunity, refresh-documents",
          400
        );
    }
  } catch (error) {
    const err = error as Error;
    console.error(`[sam-gov-api] Error: ${err.message}`, err.stack);

    if (err.name === "AuthError") {
      return errorResponse("AUTH_ERROR", err.message, 401);
    }

    if (err.name === "SamRateLimitError") {
      return errorResponse("RATE_LIMIT", err.message, 429);
    }

    if (err instanceof SamRequestError) {
      return errorResponse("INVALID_SEARCH", err.message, 400);
    }

    return errorResponse(
      "INTERNAL_ERROR",
      err.message || "An unexpected error occurred",
      500
    );
  }
});
