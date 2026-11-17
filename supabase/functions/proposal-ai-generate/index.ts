import { reviewProposalSections } from "../_shared/proposal-review.ts";
import { meteredFetch } from "../_shared/ai-usage.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  buildAnthropicHeaders,
  type AnthropicResponse,
  type AnthropicSystemBlock,
  CLARA_MODEL,
} from "../_shared/claraConfig.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import {
  buildGovSystemPrompt,
  classifySolicitationType,
  GOV_SECTION_TYPES,
} from "../_shared/gov-proposal-templates.ts";
import { brandIdentity, DEFAULT_BRAND, isBrand, loadBrandSender, type Brand } from "../_shared/brands.ts";
import { gatherSources, type GatheredSources } from "../_shared/proposal-sources.ts";
import { makeContentFetcher } from "../_shared/source-content.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PROPOSAL_MODEL = CLARA_MODEL;
const PROPOSAL_MAX_TOKENS = 16384;
// Sonnet 5 has a 1M-token context; cap generously to protect against
// pathological inputs rather than to fit a small window.
const MEETING_TEXT_CAP = 200000;

// Structured-outputs schema (GA on Sonnet 5). Root is an object with a
// "sections" array so the response is guaranteed parseable — no more
// prose-JSON + defensive fallback parsing. section_type is left a free string
// (not an enum) because government proposals use a different section-key set.
const PROPOSAL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      description: "The generated proposal sections, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section_type", "title", "content"],
        properties: {
          section_type: {
            type: "string",
            description:
              'Section key, e.g. "intro", "scope", "deliverables", "timeline", "pricing", "terms" (or the government section key).',
          },
          title: { type: "string", description: "Section heading, plain text." },
          content: { type: "string", description: "Section body as ready-to-render HTML." },
        },
      },
    },
  },
} as const;

interface UploadedDocument {
  name: string;
  text: string;
}

interface RequestPayload {
  proposal_id: string;
  contact_id: string;
  opportunity_id?: string;
  meeting_ids?: string[];
  template_id?: string;
  custom_instructions?: string;
  sections_to_generate: ('intro' | 'scope' | 'deliverables' | 'timeline' | 'pricing' | 'terms')[];
  include_contact_history?: boolean;
  include_opportunity_data?: boolean;
  user_id: string;
  uploaded_documents?: UploadedDocument[];
  /** Extra File Manager files (drive_files ids) to read, beyond the auto-attached ones. */
  file_ids?: string[];
  /** Auto-attached files the author unticked. */
  exclude_file_ids?: string[];
  /** Include documents attached to the opportunity / contact / linked projects (default true). */
  include_attached_documents?: boolean;
  /** Extra project(s) to summarise (e.g. one linked only through the contact). */
  project_id?: string;
  project_ids?: string[];
  /** Include projects linked to the opportunity / proposal (default true). */
  include_project?: boolean;
}

interface ContactData {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
}

interface OpportunityData {
  id: string;
  value_amount: number;
  currency: string;
  source: string | null;
  pipeline_name: string;
  stage_name: string;
  name: string | null;
  description: string | null;
}

interface MeetingData {
  id: string;
  meeting_title: string;
  meeting_date: string;
  summary: string | null;
  key_points: string[];
  action_items: { description: string; assignee?: string }[];
  recording_url: string | null;
  transcript_text: string | null;
  /** Full Gemini "take notes for me" recap, when the meeting had one. */
  gemini_notes?: string | null;
}

interface GeneratedSection {
  section_type: string;
  title: string;
  content: string;
}

/** proposal_sections.section_type is constrained to this set by the schema. */
const DB_SECTION_TYPES = new Set([
  "intro",
  "scope",
  "deliverables",
  "timeline",
  "pricing",
  "terms",
  "custom",
]);

/**
 * Government solicitation section labels are richer than the persisted
 * section_type check constraint, so map them onto a permitted value. The
 * government label still shows up in the section title.
 */
const GOV_SECTION_TYPE_TO_DB: Record<string, string> = {
  cover_letter: "intro",
  executive_summary: "intro",
  understanding: "scope",
  technical_approach: "scope",
  technical_capability: "scope",
  proposed_approach: "scope",
  bid_response: "scope",
  cost_price: "pricing",
  pricing: "pricing",
  certifications: "terms",
  compliance_matrix: "terms",
};

/** Coerces an AI-provided section_type into a value the database accepts. */
function toDbSectionType(sectionType: string): string {
  const normalized = sectionType.trim().toLowerCase();
  if (DB_SECTION_TYPES.has(normalized)) return normalized;
  return GOV_SECTION_TYPE_TO_DB[normalized] ?? "custom";
}

async function loadGeminiNotes(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  meetingIds: string[],
): Promise<Map<string, string>> {
  // Google Meet meetings carry full Gemini notes in google_meet_sessions (meeting_transcriptions.summary
  // is truncated). Teams/manual meetings have no notes analogue and use summary + transcript_text.
  // Best effort: a query error (e.g. table missing) must never break generation.
  try {
    const { data, error } = await supabase
      .from("google_meet_sessions")
      .select("meeting_transcription_id, gemini_notes_content")
      .in("meeting_transcription_id", meetingIds)
      .not("gemini_notes_content", "is", null);
    if (error) return new Map();
    return new Map<string, string>(
      ((data ?? []) as { meeting_transcription_id: string | null; gemini_notes_content: string }[])
        .filter((s) => s.meeting_transcription_id)
        .map((s) => [s.meeting_transcription_id as string, s.gemini_notes_content]),
    );
  } catch {
    return new Map();
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    console.log("[AI] Request received. Method:", req.method);
    const authHeader = req.headers.get("Authorization");
    console.log("[AI] Auth header present:", !!authHeader);
    
    const supabase = getSupabaseClient();
    console.log("[AI] Supabase client initialized. URL:", Deno.env.get("SUPABASE_URL"));
    
    const userContext = await extractUserContext(req, supabase);
    console.log("[AI] extractUserContext result:", userContext ? "SUCCESS" : "NULL");


    if (!userContext) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", message: "Check Supabase Dashboard logs for [Auth] diagnostic info." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authenticatedUserId = userContext.id;

    const payload: RequestPayload = await req.json();
    const {
      proposal_id,
      contact_id,
      opportunity_id,
      meeting_ids,
      template_id,
      custom_instructions,
      sections_to_generate,
      include_contact_history,
      include_opportunity_data,
      uploaded_documents,
      file_ids,
      exclude_file_ids,
      include_attached_documents,
      project_id,
      project_ids,
      include_project,
    } = payload;

    if (!proposal_id || !contact_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }


    const { data: proposal, error: proposalError } = await supabase
      .from("proposals")
      .select("*, contact:contacts(*), opportunity:opportunities(*)")
      .eq("id", proposal_id)
      .single();

    if (proposalError || !proposal || proposal.org_id !== userContext.orgId) {
      return new Response(
        JSON.stringify({ error: "Proposal not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contact_id)
      .single();

    if (contactError || !contact || (contact.organization_id && contact.organization_id !== proposal.org_id)) {
      return new Response(
        JSON.stringify({ error: "Contact not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contactData: ContactData = {
      id: contact.id,
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      job_title: contact.job_title,
    };

    // The opportunity is always resolved (org-scoped) so government detection and its attached
    // solicitation documents work even when the author leaves deal data out of the prompt.
    const effectiveOpportunityId = opportunity_id || proposal.opportunity_id || null;
    let opportunityData: OpportunityData | null = null;
    let opportunityForDetection: OpportunityData | null = null;
    if (effectiveOpportunityId) {
      const { data: opp } = await supabase
        .from("opportunities")
        .select("*, pipeline:pipelines(name), stage:pipeline_stages(name)")
        .eq("id", effectiveOpportunityId)
        .eq("org_id", proposal.org_id)
        .maybeSingle();

      if (opp) {
        opportunityForDetection = {
          id: opp.id,
          value_amount: opp.value_amount,
          currency: opp.currency,
          source: opp.source,
          pipeline_name: opp.pipeline?.name || "",
          stage_name: opp.stage?.name || "",
          name: opp.name || null,
          description: opp.description || null,
        };
        if (include_opportunity_data) opportunityData = opportunityForDetection;
      }
    }

    let meetingsData: MeetingData[] = [];
    if (meeting_ids && meeting_ids.length > 0) {
      const { data: meetings } = await supabase
        .from("meeting_transcriptions")
        .select("id, meeting_title, meeting_date, summary, key_points, action_items, recording_url, transcript_text, ai_notes")
        .in("id", meeting_ids)
        .eq("org_id", proposal.org_id)
        .order("meeting_date", { ascending: false });

      if (meetings) {
        // Full Gemini notes for Google Meet meetings; Teams/manual meetings use summary + transcript_text.
        const notesByMeeting = await loadGeminiNotes(supabase, meeting_ids);

        meetingsData = meetings.map((m) => ({
          id: m.id,
          meeting_title: m.meeting_title,
          meeting_date: m.meeting_date,
          summary: m.summary,
          key_points: m.key_points || [],
          action_items: m.action_items || [],
          recording_url: m.recording_url,
          transcript_text: m.transcript_text || null,
          // Provider AI recap: Gemini notes (google_meet_sessions) or ai_notes (Teams AI insights).
          gemini_notes: notesByMeeting.get(m.id) || m.ai_notes || null,
        }));
      }
    }

    let contactHistory = "";
    if (include_contact_history) {
      const { data: notes } = await supabase
        .from("contact_notes")
        .select("content, created_at")
        .eq("contact_id", contact_id)
        .order("created_at", { ascending: false })
        .limit(5);

      const { data: timeline } = await supabase
        .from("contact_timeline")
        .select("event_type, event_data, created_at")
        .eq("contact_id", contact_id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (notes && notes.length > 0) {
        contactHistory += "\n\nRecent Notes:\n" + notes.map((n) => `- ${n.content}`).join("\n");
      }
      if (timeline && timeline.length > 0) {
        contactHistory +=
          "\n\nRecent Activity:\n" +
          timeline.map((t) => `- ${t.event_type}: ${JSON.stringify(t.event_data)}`).join("\n");
      }
    }

    let templateContent = "";
    if (template_id) {
      const { data: template } = await supabase
        .from("proposal_templates")
        .select("content, variables")
        .eq("id", template_id)
        .single();

      if (template) {
        templateContent = template.content;
      }
    }

    const { data: org } = await supabase
      .from("organizations")
      .select("name, display_name, legal_name, email, phone, website, gov_company_profile, gov_past_performance")
      .eq("id", proposal.org_id)
      .single();

    // The deal's brand picks the kit and voice: a kit tagged with that
    // brand, else an untagged one, else the newest active. Versions newest first (embedded rows are unordered).
    const proposalBrand: string | null = proposal.brand ?? proposal.opportunity?.brand ?? contact.brand ?? null;
    const pickBrand = <T extends { brand?: string | null }>(list: T[] | null): T | null =>
      (list ?? []).find((k) => k.brand === proposalBrand) ?? (list ?? []).find((k) => !k.brand) ?? (list ?? [])[0] ?? null;
    const newest = <V extends { version_number?: number }>(vs: V[] | null | undefined): V | null =>
      [...(vs ?? [])].sort((x, y) => (y.version_number ?? 0) - (x.version_number ?? 0))[0] ?? null;

    const { data: brandKits } = await supabase
      .from("brand_kits")
      .select("*, latest_version:brand_kit_versions(*)")
      .eq("org_id", proposal.org_id)
      .eq("active", true)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(10);
    const activeBrandKit = pickBrand(brandKits);
    const brandKitVersion = newest(activeBrandKit?.latest_version);

    const { data: brandVoices } = await supabase
      .from("brand_voices")
      .select("*, latest_version:brand_voice_versions(*)")
      .eq("org_id", proposal.org_id)
      .eq("active", true)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(10);
    const activeBrandVoice = pickBrand(brandVoices);
    const brandVoiceVersion = newest(activeBrandVoice?.latest_version);

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      return new Response(
        JSON.stringify({ error: "Anthropic API key not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Written as the business the client relates to (a secondary brand's clients get that brand's identity).
    const docBrand: Brand = isBrand(proposalBrand) ? proposalBrand : DEFAULT_BRAND;
    const companyInfo = brandIdentity(docBrand, org, await loadBrandSender(supabase, proposal.org_id, docBrand));

    // Detect government proposals
    const isGovernment = opportunityForDetection?.source === 'sam_gov' ||
      opportunityForDetection?.pipeline_name === 'Government';

    // Documents (SAM.gov solicitation files, files attached to the opportunity / contact /
    // projects, explicit picks, uploads) and project context — capped, solicitation first for gov.
    let sources: GatheredSources;
    try {
      sources = await gatherSources(supabase, {
        orgId: proposal.org_id,
        opportunityId: effectiveOpportunityId,
        contactId: contact_id,
        proposalId: proposal_id,
        isGovernment,
        includeAttachedDocuments: include_attached_documents,
        fileIds: Array.isArray(file_ids) ? file_ids.filter((x) => typeof x === "string") : undefined,
        excludeFileIds: Array.isArray(exclude_file_ids) ? exclude_file_ids.filter((x) => typeof x === "string") : undefined,
        includeLinkedProjects: include_project,
        projectIds: [...(Array.isArray(project_ids) ? project_ids : []), ...(project_id ? [project_id] : [])]
          .filter((x) => typeof x === "string"),
        uploadedDocuments: Array.isArray(uploaded_documents) ? uploaded_documents : undefined,
        fetcher: makeContentFetcher(supabase, { orgId: proposal.org_id, requestUserId: authenticatedUserId }),
      });
    } catch (err) {
      console.error("[AI] Source gathering failed; continuing without documents/projects:", err);
      sources = { documentsText: "", projectsText: "", documents: [], omittedDocuments: [], projects: [] };
    }

    let systemPrompt: string;
    let effectiveSections = sections_to_generate;

    if (isGovernment) {
      // Classify solicitation type from opportunity description/metadata
      const solType = classifySolicitationType(
        opportunityForDetection?.description || opportunityForDetection?.name || '',
        opportunityForDetection?.stage_name
      );
      console.log(`[AI] Government proposal detected. Solicitation type: ${solType}`);

      // Government defaults apply only when the caller didn't pick sections.
      if (!sections_to_generate || sections_to_generate.length === 0) {
        const govSections = GOV_SECTION_TYPES[solType] || GOV_SECTION_TYPES['RFP'];
        effectiveSections = govSections as RequestPayload['sections_to_generate'];
      }

      systemPrompt = buildGovSystemPrompt(solType, companyInfo, {
        companyProfile: org?.gov_company_profile,
        pastPerformance: org?.gov_past_performance,
      });
    } else {
      systemPrompt = buildSystemPrompt(
        companyInfo,
        brandVoiceVersion,
        brandKitVersion,
        templateContent
      );
    }

    const userPrompt = buildUserPrompt(
      contactData,
      opportunityData,
      meetingsData,
      contactHistory,
      effectiveSections,
      custom_instructions,
      sources
    );

    let generatedSections: GeneratedSection[];
    try {
      generatedSections = await callLLM(
        anthropicApiKey,
        PROPOSAL_MODEL,
        systemPrompt,
        userPrompt
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `AI generation failed: ${String(err)}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    for (const section of generatedSections) {
      const maxSortOrder = await getMaxSectionSortOrder(supabase, proposal_id);

      const { error: sectionError } = await supabase.from("proposal_sections").insert({
        org_id: proposal.org_id,
        proposal_id: proposal_id,
        title: section.title,
        content: section.content,
        section_type: toDbSectionType(section.section_type),
        sort_order: maxSortOrder + 1,
        ai_generated: true,
      });
      if (sectionError) {
        console.error(
          `[AI] Failed to persist section "${section.title}" (${section.section_type}):`,
          sectionError
        );
      }
    }

    const reviewFlags = reviewProposalSections(generatedSections);
    // A total that does not add up, or a price still marked NEEDS PRICING, is not trusted as the proposal value:
    // leave it for a person.
    const untrustedTotal = reviewFlags.some((f) => f.kind === "arithmetic" || f.kind === "needs_pricing");
    const extractedValue = untrustedTotal
      ? null
      : extractValueFromSections(generatedSections, proposal.currency || "USD");
    if (untrustedTotal) {
      // Regeneration must not leave a previous (now untrusted) total behind. If the reset cannot be saved,
      // fail the operation rather than returning success with a stale price still displayed.
      const { error: resetError } = await supabase.from("proposals").update({ total_value: 0 }).eq("id", proposal_id);
      if (resetError) {
        return new Response(
          JSON.stringify({ error: `Failed to reset proposal total after review flag: ${resetError.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    if (extractedValue && extractedValue.value > 0) {
      await supabase
        .from("proposals")
        .update({
          total_value: extractedValue.value,
          currency: extractedValue.currency,
        })
        .eq("id", proposal_id);
    }

    const sourcesUsed = {
      meetings: meetingsData.map((m) => ({
        id: m.id,
        title: m.meeting_title,
        date: m.meeting_date,
        summary: !!m.summary,
        ai_notes: !!m.gemini_notes,
        transcript: !!m.transcript_text,
      })),
      documents: sources.documents,
      omitted_documents: sources.omittedDocuments,
      projects: sources.projects,
    };

    const aiContext = {
      meetings_used: meeting_ids || [],
      uploaded_documents: uploaded_documents?.map((d) => d.name) || [],
      sources_used: sourcesUsed,
      contact_history_included: include_contact_history || false,
      opportunity_data_included: include_opportunity_data || false,
      custom_instructions: custom_instructions || null,
      is_government: isGovernment || false,
      generated_at: new Date().toISOString(),
      review_flags: reviewFlags,
    };

    await supabase
      .from("proposals")
      .update({ ai_context: aiContext })
      .eq("id", proposal_id);

    await supabase.from("proposal_activities").insert({
      org_id: proposal.org_id,
      proposal_id: proposal_id,
      activity_type: "ai_generated",
      description: `AI generated ${generatedSections.length} section(s)${reviewFlags.length ? `; ${reviewFlags.length} review flag(s) to resolve before sending` : ""}`,
      metadata: {
        review_flags: reviewFlags.length,
        sections_generated: generatedSections.map((s) => s.section_type),
        meetings_used: meeting_ids?.length || 0,
      },
      actor_user_id: authenticatedUserId,
    });

    try {
      const { data: orgUsers } = await supabase
        .from("users")
        .select("id")
        .eq("organization_id", proposal.org_id);

      if (orgUsers?.length) {
        await supabase.from("notifications").insert(
          orgUsers.map((u: { id: string }) => ({
            user_id: u.id,
            type: "ai_draft_ready",
            title: "AI Proposal Draft Ready",
            body: `An AI-generated proposal draft is ready for "${proposal.title || "Untitled"}"`,
            link: `/proposals/${proposal_id}`,
            metadata: { proposal_id },
          }))
        );
      }
    } catch {}

    return new Response(
      JSON.stringify({
        success: true,
        sections_generated: generatedSections.length,
        sections: generatedSections,
        sources_used: sourcesUsed,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Proposal AI generation error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

interface CompanyInfo {
  name: string;
  email: string;
  phone: string;
  website: string;
}

function buildSystemPrompt(
  company: CompanyInfo,
  brandVoiceVersion: Record<string, unknown> | null,
  brandKitVersion: Record<string, unknown> | null,
  templateContent: string
): string {
  let prompt = `You are an expert proposal writer for ${company.name}. You write proposals that close deals.

CORE PRINCIPLE: A proposal is a decision document, not a brochure. Every section must help the client say YES by answering: what is the problem, how will you solve it, what will it cost, and when will it be done.

COMPANY INFORMATION:
- Company: ${company.name}
- Email: ${company.email}
- Phone: ${company.phone}
- Website: ${company.website}

SECTION-BY-SECTION WRITING RULES:

Executive Summary (section_type: "intro"):
- 2-4 sentences maximum
- State the problem, proposed solution, primary outcome, and investment amount or range
- Must stand alone -- a decision-maker reading only this section should understand the entire proposal
- Write this with the knowledge of all other sections so it accurately summarizes the whole proposal

Scope of Work (section_type: "scope"):
- Describe your approach at a high level
- Explain WHY this approach works, not just WHAT you will do
- Connect the solution directly back to the stated problem
- Use the client's own language from meeting context if available
- Never blame the client for the problem
- One clear approach -- do not present multiple solution options here
- Break into logical phases with clear descriptions of what each phase includes

Deliverables (section_type: "deliverables"):
- Every deliverable must be a tangible thing the client receives (a file, a system, a report, a design, a tool)
- "Strategy sessions" or "consulting hours" are NOT deliverables on their own -- tie them to a specific output
- Include a timeline per deliverable, not just for the whole project
- Use an HTML table or structured list so each item is clear
- Be specific: "4 SEO blog posts per month, 1,200-1,500 words each" NOT "marketing support"

Project Timeline (section_type: "timeline"):
- Milestones must be concrete checkpoints, not vague phases
- "Design mockups delivered" is a milestone; "Design phase" is not
- Include a start date assumption
- Use an HTML table with columns: Phase, Milestone, Duration, Target Date
- Include a total project duration note

Pricing / Investment (section_type: "pricing"):
- Always present pricing AFTER deliverables so the reader understands value before seeing the number
- Round to clean numbers ($5,000 not $4,850; $3,000/mo not $2,975/mo)
- NEVER list hourly rates in a fixed-price proposal -- the client is buying an outcome, not your time
- If there are ongoing operational costs, list them separately from the development investment
- If presenting tiers, name them with descriptive labels (Foundation / Growth / Scale), not metals (Bronze / Silver / Gold)
- For tiered pricing, the middle tier should be 1.5x-2x the base tier and marked as "Recommended"

Terms & Conditions (section_type: "terms"):
- Include: Payment Terms, Support & Maintenance, Technical Requirements, Security & Compliance, Project Success Criteria
- For projects under $10K: 50% upfront, 50% on completion
- For projects over $10K: 50% upfront, 25% at midpoint, 25% on completion
- Terms must be specific to this project -- never generic boilerplate
- Include what happens if scope changes (change order process)

ANTI-PATTERNS -- NEVER DO THESE:
- DO NOT pad the scope with unnecessary deliverables to inflate the price
- DO NOT use jargon the client would not understand. "Responsive UI/UX with progressive enhancement" means nothing -- say "a website that works great on phones and desktops"
- DO NOT use tentative language. "We might be able to..." or "We could possibly..." undermines confidence. State what you WILL do
- DO NOT skip the executive summary or make it weak
- DO NOT include multiple solution options in the Scope section (save options for pricing tiers only)
- DO NOT write vague deliverables like "marketing support" or "ongoing assistance"

QUALITY CHECKLIST (verify before outputting):
- Executive summary stands alone and includes the investment amount
- Problem statement uses the client's own language
- Every deliverable is a tangible output the client receives
- Pricing uses clean, round numbers
- Timeline has concrete milestones with dates, not vague phase names
- Payment terms match the pricing model
- No jargon the client would need to Google
- No placeholder text like [TBD] remains
- NEVER invent a price. If the sources do not state a price or the pricing needs a human judgment, write the exact marker NEEDS PRICING in that line instead of a number. If the scope of an item is unclear or was not confirmed in the conversation, write CONFIRM SCOPE next to it. A person resolves every marker before the proposal is sent
- Every pricing table must add up: the total row equals the sum of its lines, and quantity x unit price equals each line total
- Client name and company name are correct throughout
`;

  if (brandVoiceVersion) {
    const toneSettings = brandVoiceVersion.tone_settings as Record<string, number> || {};
    const dos = (brandVoiceVersion.dos as string[]) || [];
    const donts = (brandVoiceVersion.donts as string[]) || [];
    const vocabPreferred = (brandVoiceVersion.vocabulary_preferred as string[]) || [];
    const vocabProhibited = (brandVoiceVersion.vocabulary_prohibited as string[]) || [];

    prompt += `\nBRAND VOICE GUIDELINES:`;

    if (Object.keys(toneSettings).length > 0) {
      prompt += `\n- Tone Settings:`;
      if (toneSettings.formality !== undefined) {
        const level = toneSettings.formality > 0.5 ? "Formal" : "Casual";
        prompt += `\n  - Formality: ${level}`;
      }
      if (toneSettings.friendliness !== undefined) {
        const level = toneSettings.friendliness > 0.5 ? "Warm and friendly" : "Direct and professional";
        prompt += `\n  - Approach: ${level}`;
      }
      if (toneSettings.energy !== undefined) {
        const level = toneSettings.energy > 0.5 ? "Energetic and dynamic" : "Calm and measured";
        prompt += `\n  - Energy: ${level}`;
      }
      if (toneSettings.confidence !== undefined) {
        const level = toneSettings.confidence > 0.5 ? "Assertive and confident" : "Humble and consultative";
        prompt += `\n  - Confidence: ${level}`;
      }
    }

    if (dos.length > 0) {
      prompt += `\n- Do use: ${dos.join(", ")}`;
    }
    if (donts.length > 0) {
      prompt += `\n- Avoid: ${donts.join(", ")}`;
    }
    if (vocabPreferred.length > 0) {
      prompt += `\n- Preferred vocabulary: ${vocabPreferred.join(", ")}`;
    }
    if (vocabProhibited.length > 0) {
      prompt += `\n- Never use: ${vocabProhibited.join(", ")}`;
    }
  }

  if (brandKitVersion) {
    const colors = brandKitVersion.colors as Record<string, { hex: string }> || {};
    prompt += `\nBRAND COLORS (for reference in describing visual elements):`;
    if (colors.primary) prompt += `\n- Primary: ${colors.primary.hex}`;
    if (colors.secondary) prompt += `\n- Secondary: ${colors.secondary.hex}`;
  }

  if (templateContent) {
    prompt += `\nTEMPLATE STRUCTURE TO FOLLOW:
Use this template as structural guidance. Replace all {{variable}} placeholders with actual content derived from the client data and meeting context. Do not leave any template variables in the output.
${templateContent}
`;
  }

  prompt += `

OUTPUT FORMAT:

Return a JSON object with a single "sections" array (the response schema is enforced). Each element of "sections" must have exactly these three string fields:
- "section_type": one of "intro", "scope", "deliverables", "timeline", "pricing", "terms"
- "title": the section heading as a plain text string
- "content": the section body as a well-formatted HTML string

The "content" field MUST contain HTML markup. Use these tags:
<p> for paragraphs
<h3> and <h4> for sub-headings within a section
<ul> and <ol> with <li> for lists
<strong> for bold text, <em> for emphasis
<table>, <thead>, <tbody>, <tr>, <th>, <td> for tables

The "content" field must NEVER contain JSON, markdown, or code fences. It must be ready-to-render HTML.

Example of correct output format:
{"sections":[{"section_type":"intro","title":"Executive Summary","content":"<p>Dear John, ...</p><p>Our proposed solution will...</p>"},{"section_type":"scope","title":"Scope of Work","content":"<h3>Phase 1: Discovery</h3><ul><li>Requirement gathering</li></ul>"}]}`;

  return prompt;
}

function buildUserPrompt(
  contact: ContactData,
  opportunity: OpportunityData | null,
  meetings: MeetingData[],
  contactHistory: string,
  sectionsToGenerate: string[],
  customInstructions?: string,
  sources?: GatheredSources
): string {
  let prompt = `Generate the following proposal sections: ${sectionsToGenerate.join(", ")}

All content must be personalized for this client. Replace all template variables with real data.

Client Information:
- Name: ${contact.first_name} ${contact.last_name}
- Company: ${contact.company || "N/A"}
- Title: ${contact.job_title || "N/A"}
- Email: ${contact.email || "N/A"}
`;

  if (opportunity) {
    prompt += `\nDeal Information:
- Value: ${opportunity.currency} ${opportunity.value_amount.toLocaleString()}
- Pipeline: ${opportunity.pipeline_name}
- Stage: ${opportunity.stage_name}
- Source: ${opportunity.source || "N/A"}
`;

    // Add government solicitation details if available
    if (opportunity.source === 'sam_gov' && opportunity.description) {
      prompt += `\nSolicitation Details (from SAM.gov):
${opportunity.description}
`;
    }
    if (opportunity.name) {
      prompt += `- Opportunity/Solicitation Title: ${opportunity.name}\n`;
    }
  }

  if (meetings.length > 0) {
    prompt += `\nMeeting Context (use this as the primary source for understanding the client's problem, needs, and goals):`;
    for (const meeting of meetings) {
      prompt += `\n\nMeeting: ${meeting.meeting_title} (${meeting.meeting_date})`;
      if (meeting.summary) {
        prompt += `\nSummary: ${meeting.summary}`;
      }
      if (meeting.key_points.length > 0) {
        prompt += `\nKey Points:\n${meeting.key_points.map((p) => `- ${p}`).join("\n")}`;
      }
      if (meeting.action_items.length > 0) {
        prompt += `\nAction Items:\n${meeting.action_items.map((a) => `- ${a.description}`).join("\n")}`;
      }
      // Gemini's own recap is denser and better structured than a raw
      // transcript, so give it to the model before the transcript excerpt.
      if (meeting.gemini_notes) {
        const notes = meeting.gemini_notes.length > MEETING_TEXT_CAP
          ? meeting.gemini_notes.substring(0, MEETING_TEXT_CAP) + "\n[notes truncated]"
          : meeting.gemini_notes;
        prompt += `\nAI Meeting Notes:\n${notes}`;
      }
      if (meeting.transcript_text && meeting.transcript_text.length > 0) {
        const excerpt = meeting.transcript_text.length > MEETING_TEXT_CAP
          ? meeting.transcript_text.substring(0, MEETING_TEXT_CAP) + "\n[transcript truncated]"
          : meeting.transcript_text;
        prompt += `\nMeeting Transcript:\n${excerpt}`;
      }
      if (meeting.recording_url) {
        prompt += `\n[Meeting recording available]`;
      }
    }
  }

  // Solicitation + attached + uploaded documents (already capped and ordered), then projects.
  if (sources?.documentsText) {
    prompt += sources.documentsText;
  }
  if (sources?.projectsText) {
    prompt += sources.projectsText;
  }

  if (contactHistory) {
    prompt += `\n${contactHistory}`;
  }

  if (customInstructions) {
    prompt += `\n\nAdditional Instructions from the proposal author:\n${customInstructions}`;
  }

  prompt += `\n\nReturn a JSON object with a "sections" array. Each section's "content" must be HTML.`;

  return prompt;
}

function validateSection(s: unknown): s is GeneratedSection {
  if (!s || typeof s !== 'object') return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj.section_type === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.content === 'string' &&
    obj.content.length > 0
  );
}

// Structured outputs guarantees the { sections: [...] } shape, so parse once
// and fail loudly if it is somehow malformed rather than silently degrading.
function parseAIResponse(responseText: string): GeneratedSection[] {
  const parsed = JSON.parse(responseText);
  const arr = parsed?.sections;
  if (!Array.isArray(arr)) {
    throw new Error("AI response did not contain a 'sections' array");
  }
  const validated = arr.filter(validateSection);
  if (validated.length === 0) {
    throw new Error("AI response contained no valid sections");
  }
  return validated;
}

async function callLLM(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<GeneratedSection[]> {
  const maxRetries = 3;
  const retryableStatuses = [429, 529, 500, 502, 503];

  // The system prompt is stable per org+template, so cache it — repeated
  // generations reuse the cached prefix. Client-specific data lives in the
  // (uncached) user turn.
  const systemBlocks: AnthropicSystemBlock[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await meteredFetch({ source: "proposal-ai-generate", agent: "os" })("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: buildAnthropicHeaders(apiKey),
      body: JSON.stringify({
        model,
        system: systemBlocks,
        messages: [
          { role: "user", content: userPrompt },
        ],
        max_tokens: PROPOSAL_MAX_TOKENS,
        output_config: {
          format: { type: "json_schema", schema: PROPOSAL_OUTPUT_SCHEMA },
        },
      }),
    });

    if (response.ok) {
      const data = await response.json() as AnthropicResponse;
      const responseText = data.content.find((b) => b.type === "text")?.text || "";
      return parseAIResponse(responseText);
    }

    const errBody = await response.text();

    // Retry on overload/rate-limit/transient errors
    if (retryableStatuses.includes(response.status) && attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
      console.warn(`[proposal-ai-generate] Anthropic ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }

  throw new Error("Exhausted retries calling Anthropic API");
}

const TOTAL_LABEL_PATTERNS_EDGE = [
  /total\s+platform\s+investment/i,
  /total\s+project\s+investment/i,
  /total\s+project\s+cost/i,
  /total\s+engagement/i,
  /total\s+investment/i,
  /total\s+annual/i,
  /grand\s+total/i,
  /total\s+cost/i,
  /total\s+value/i,
  /total\s+fee/i,
  /\btotal\b/i,
];

const ANNUAL_LABEL_PATTERNS_EDGE = [
  /annual\s*\(recommended\)/i,
  /annual\s*[-–]\s*recommended/i,
  /\bannual\b/i,
  /\byearly\b/i,
  /per\s+year/i,
  /\/\s*year/i,
];

const ANNUAL_COL_HEADER_PATTERNS_EDGE = [
  /annual\s+total/i,
  /total\s+annual/i,
  /annual\s+cost/i,
  /annual\s+value/i,
  /annual\s+amount/i,
  /\bannual\b/i,
];

const INLINE_TOTAL_PATTERNS_EDGE = [
  /total\s*:\s*(?:AUD|USD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR)?\s*(?:AU\$|NZ\$|CA\$|HK\$|S\$|[$€£¥₹])?\s*([\d,]+(?:\.\d+)?)/i,
  /(?:AUD|USD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\(excl\. gst\)/i,
  /(?:AU\$|NZ\$|CA\$|HK\$|S\$|[$€£¥₹])([\d,]+(?:\.\d+)?)\s*\(excl\. gst\)/i,
];

function detectCurrencyEdge(text: string): string {
  const isoMatch = text.match(/\b(USD|AUD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR)\b/);
  if (isoMatch) return isoMatch[1];
  const pairs: [string, string][] = [
    ['AU$','AUD'],['NZ$','NZD'],['CA$','CAD'],['HK$','HKD'],['S$','SGD'],
    ['€','EUR'],['£','GBP'],['¥','JPY'],['₹','INR'],['$','USD'],
  ];
  for (const [sym, code] of pairs) {
    if (text.includes(sym)) return code;
  }
  return 'USD';
}

function parseMonetaryValueEdge(text: string): number | null {
  const cleaned = text
    .replace(/\b(AU|NZ|CA|HK|S)\$/g, '')
    .replace(/\b(USD|AUD|NZD|CAD|GBP|EUR|JPY|SGD|HKD|INR)\b/g, '')
    .replace(/[$€£¥₹]/g, '')
    .replace(/,/g, '')
    .trim();
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  return isNaN(value) || value <= 0 ? null : value;
}

function hasMonetaryValueEdge(text: string): boolean {
  return /(?:AU\$|NZ\$|CA\$|\$|€|£|¥|₹|AUD|USD|GBP|EUR)[\s]?\d/.test(text) ||
    /\d[\d,]*(?:\.\d+)?(?:\s*\/\s*(?:year|yr|month|mo))?/.test(text);
}

function extractTableEdge(html: string, defaultCurrency: string): { value: number; currency: string } | null {
  const tablePattern = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tablePattern.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    const tableRows: string[][] = [];

    while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim());
      }
      if (cells.length > 0) tableRows.push(cells);
    }

    if (tableRows.length === 0) continue;

    const headerRow = tableRows[0];
    const annualColIndex = headerRow.findIndex((h) =>
      ANNUAL_COL_HEADER_PATTERNS_EDGE.some((p) => p.test(h))
    );

    if (annualColIndex >= 0 && tableRows.length > 1) {
      let bestValue: number | null = null;
      let bestCurrency = defaultCurrency;
      for (let r = 1; r < tableRows.length; r++) {
        if (annualColIndex < tableRows[r].length) {
          const v = parseMonetaryValueEdge(tableRows[r][annualColIndex]);
          if (v !== null && (bestValue === null || v > bestValue)) {
            bestValue = v;
            bestCurrency = detectCurrencyEdge(tableRows[r][annualColIndex]) || defaultCurrency;
          }
        }
      }
      if (bestValue !== null && bestValue > 0) return { value: bestValue, currency: bestCurrency };
    }

    for (const cells of tableRows) {
      if (cells.length < 2) continue;
      const allCells = cells.join(' ');
      if (TOTAL_LABEL_PATTERNS_EDGE.some((p) => p.test(cells[0])) ||
          TOTAL_LABEL_PATTERNS_EDGE.some((p) => p.test(allCells))) {
        for (let i = cells.length - 1; i >= 1; i--) {
          const v = parseMonetaryValueEdge(cells[i]);
          if (v !== null) return { value: v, currency: detectCurrencyEdge(cells[i]) || defaultCurrency };
        }
      }
    }

    for (const cells of tableRows) {
      if (cells.length < 2) continue;
      if (ANNUAL_LABEL_PATTERNS_EDGE.some((p) => p.test(cells[0]))) {
        let bestValue: number | null = null;
        let bestCurrency = defaultCurrency;
        for (let i = 1; i < cells.length; i++) {
          if (hasMonetaryValueEdge(cells[i])) {
            const v = parseMonetaryValueEdge(cells[i]);
            if (v !== null && (bestValue === null || v > bestValue)) {
              bestValue = v;
              bestCurrency = detectCurrencyEdge(cells[i]) || defaultCurrency;
            }
          }
        }
        if (bestValue !== null) return { value: bestValue, currency: bestCurrency };
      }
    }
  }
  return null;
}

function extractValueFromSections(
  sections: GeneratedSection[],
  defaultCurrency: string
): { value: number; currency: string } | null {
  const priority = ['pricing', 'terms', 'custom', 'scope', 'deliverables', 'timeline', 'intro'];
  for (const type of priority) {
    const section = sections.find((s) => s.section_type === type);
    if (!section?.content) continue;

    const html = section.content;
    const detectedCurrency = detectCurrencyEdge(html) || defaultCurrency;

    const tableResult = extractTableEdge(html, detectedCurrency);
    if (tableResult) return tableResult;

    const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const pattern of INLINE_TOTAL_PATTERNS_EDGE) {
      const m = stripped.match(pattern);
      if (m) {
        const value = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(value) && value > 0) {
          return { value, currency: detectCurrencyEdge(m[0]) || detectedCurrency };
        }
      }
    }
  }
  return null;
}

async function getMaxSectionSortOrder(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  proposalId: string
): Promise<number> {
  const { data } = await supabase
    .from("proposal_sections")
    .select("sort_order")
    .eq("proposal_id", proposalId)
    .order("sort_order", { ascending: false })
    .limit(1);

  return data?.[0]?.sort_order ?? -1;
}
