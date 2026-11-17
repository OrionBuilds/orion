import { meteredFetch } from "../_shared/ai-usage.ts";
import { escapeHtml } from "../_shared/html.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildAnthropicHeaders,
  type AnthropicResponse,
  type AnthropicSystemBlock,
  CLARA_MODEL,
} from "../_shared/claraConfig.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { brandIdentity, DEFAULT_BRAND, isBrand, loadBrandSender, type Brand } from "../_shared/brands.ts";
import { gatherSources, type GatheredSources } from "../_shared/proposal-sources.ts";
import { makeContentFetcher } from "../_shared/source-content.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey, X-Supabase-Auth",
};

const CONTRACT_MODEL = CLARA_MODEL;
const CONTRACT_MAX_TOKENS = 16384;
// Sonnet 5 has a 1M-token context; cap generously against pathological inputs.
const MEETING_TEXT_CAP = 200000;

const SIGNATURES_SECTION_ANNOTATION =
  "The Service Provider has pre-signed. The contract becomes binding once the Client signs and dates it.";

const CONTRACT_SECTION_TYPES = [
  "scope",
  "deliverables",
  "payment_terms",
  "timeline",
  "intellectual_property",
  "confidentiality",
  "termination",
  "liability",
  "dispute_resolution",
  "governing_law",
  "general_provisions",
  "signatures",
] as const;

// Structured-outputs schema (GA on Sonnet 5). Root object with a "sections"
// array so the response parses deterministically. section_type is a free
// string (the model is told which keys to use in the prompt).
const CONTRACT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      description: "The generated contract sections, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section_type", "title", "content", "annotation"],
        properties: {
          section_type: { type: "string", description: "Section key from the required list." },
          title: { type: "string", description: "Section heading, plain text." },
          content: { type: "string", description: "Section body as ready-to-render HTML." },
          annotation: { type: "string", description: "Plain-English explanation of the section." },
        },
      },
    },
  },
} as const;

interface RequestPayload {
  contract_id: string;
  /** Optional: a contract can now be drafted without a source proposal. */
  proposal_id?: string;
  contact_id: string;
  opportunity_id?: string;
  contract_type: string;
  custom_instructions?: string;
  user_id: string;
  /** meeting_transcriptions ids to ground the contract in what was agreed. */
  meeting_ids?: string[];
  /** Reference material (existing MSA, SOW, spec) parsed client-side. */
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

interface UploadedDocument {
  name: string;
  text: string;
}

interface ContactData {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
}

interface GeneratedSection {
  section_type: string;
  title: string;
  content: string;
  annotation: string;
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
    const supabase = getSupabaseClient();
    const userContext = await extractUserContext(req, supabase);

    if (!userContext) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", message: "Check Supabase Dashboard logs for [Auth] diagnostic info." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload: RequestPayload = await req.json();
    const {
      contract_id,
      proposal_id,
      contact_id,
      contract_type,
      custom_instructions,
      user_id,
      meeting_ids,
      uploaded_documents,
      opportunity_id,
      file_ids,
      exclude_file_ids,
      include_attached_documents,
      project_id,
      project_ids,
      include_project,
    } = payload;

    if (!contract_id || !contact_id || !user_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("*")
      .eq("id", contract_id)
      .single();

    if (contractError || !contract || contract.org_id !== userContext.orgId) {
      return new Response(
        JSON.stringify({ error: "Contract not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // A standalone contract has no source proposal — only fetch one when the
    // caller supplied an id.
    let proposal: Record<string, unknown> | null = null;
    if (proposal_id) {
      const { data: proposalRow, error: proposalError } = await supabase
        .from("proposals")
        .select(
          "*, contact:contacts(*), opportunity:opportunities(*), sections:proposal_sections(*)"
        )
        .eq("id", proposal_id)
        .single();

      if (proposalError || !proposalRow || proposalRow.org_id !== contract.org_id) {
        return new Response(
          JSON.stringify({ error: "Source proposal not found" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      proposal = proposalRow;
    }

    const { data: contactRow } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contact_id)
      .maybeSingle();
    // Never read another org's contact into the prompt.
    const contact = contactRow && (!contactRow.organization_id || contactRow.organization_id === contract.org_id)
      ? contactRow
      : null;

    const contactData: ContactData = contact
      ? {
          first_name: contact.first_name,
          last_name: contact.last_name,
          email: contact.email,
          phone: contact.phone,
          company: contact.company,
          job_title: contact.job_title,
        }
      : {
          first_name: "N/A",
          last_name: "",
          email: null,
          phone: null,
          company: null,
          job_title: null,
        };

    let proposalContext = "";
    const isSigned = !!proposal && ["signed"].includes((proposal.signature_status as string) || "");
    const hasFrozenSnapshot =
      !!proposal && !!proposal.frozen_html_snapshot && !!proposal.frozen_json_snapshot;

    if (!proposal) {
      proposalContext = "";
    } else if (isSigned && hasFrozenSnapshot) {
      const snapshot = proposal.frozen_json_snapshot as Record<string, unknown>;
      proposalContext = `SOURCE PROPOSAL (Signed — Frozen Snapshot):
Title: ${snapshot.title || proposal.title}
Total Value: ${snapshot.total_value || proposal.total_value} ${snapshot.currency || proposal.currency || "USD"}

Proposal Sections:`;
      const sections = (snapshot.sections as Array<Record<string, unknown>>) || [];
      for (const s of sections) {
        proposalContext += `\n\n### ${s.title || s.section_type}:\n${stripHtml(String(s.content || ""))}`;
      }
    } else {
      proposalContext = `SOURCE PROPOSAL (Live):
Title: ${proposal.title}
Total Value: ${proposal.total_value || 0} ${proposal.currency || "USD"}

Proposal Sections:`;
      const liveSections = ((proposal.sections as Array<Record<string, unknown>>) || []).sort(
        (a, b) => (a.sort_order as number) - (b.sort_order as number)
      );
      for (const s of liveSections) {
        proposalContext += `\n\n### ${s.title || s.section_type}:\n${stripHtml(String(s.content || ""))}`;
      }
    }

    // The deal behind the contract: explicit, the contract's own, or the source proposal's.
    const effectiveOpportunityId =
      (contract as { opportunity_id?: string | null }).opportunity_id ||
      opportunity_id ||
      ((proposal?.opportunity as Record<string, unknown> | null)?.id as string | undefined) ||
      null;
    let opp: Record<string, unknown> | null = null;
    if (effectiveOpportunityId) {
      const { data: oppRow } = await supabase
        .from("opportunities")
        .select("id, value_amount, currency, source, name, pipeline:pipelines(name)")
        .eq("id", effectiveOpportunityId)
        .eq("org_id", contract.org_id)
        .maybeSingle();
      opp = oppRow ?? null;
    }
    const isGovernment = opp?.source === "sam_gov" ||
      ((opp?.pipeline as { name?: string } | null)?.name === "Government");

    let opportunityContext = "";
    if (opp) {
      opportunityContext = `
DEAL INFORMATION:
- Value: ${opp.currency || "USD"} ${((opp.value_amount as number) || 0).toLocaleString()}
- Source: ${opp.source || "N/A"}${opp.name ? `\n- Opportunity: ${opp.name}` : ""}`;
    }

    // Meeting context — what was actually agreed on the calls.
    let meetingContext = "";
    if (meeting_ids && meeting_ids.length > 0) {
      const { data: meetings } = await supabase
        .from("meeting_transcriptions")
        .select("id, meeting_title, meeting_date, summary, key_points, action_items, transcript_text, ai_notes")
        .in("id", meeting_ids)
        .eq("org_id", contract.org_id)
        .order("meeting_date", { ascending: false });

      // Full Gemini notes for Google Meet meetings; Teams/manual meetings use summary + transcript_text.
      const notesByMeeting = await loadGeminiNotes(supabase, meeting_ids);

      if (meetings && meetings.length > 0) {
        meetingContext = `\nCLIENT MEETING CONTEXT (what was actually discussed and agreed — treat as authoritative for scope, deliverables and commercial terms):`;
        for (const m of meetings) {
          meetingContext += `\n\nMeeting: ${m.meeting_title} (${m.meeting_date})`;
          if (m.summary) meetingContext += `\nSummary: ${m.summary}`;
          const keyPoints = (m.key_points as string[]) || [];
          if (keyPoints.length > 0) {
            meetingContext += `\nKey Points:\n${keyPoints.map((p) => `- ${p}`).join("\n")}`;
          }
          const items = (m.action_items as { description: string }[]) || [];
          if (items.length > 0) {
            meetingContext += `\nAction Items:\n${items.map((a) => `- ${a.description}`).join("\n")}`;
          }
          // Provider AI recap: Gemini notes (google_meet_sessions) or ai_notes (Teams AI insights).
          const notes = notesByMeeting.get(m.id) || (m.ai_notes as string | null);
          if (notes) {
            meetingContext += `\nAI Meeting Notes:\n${notes.slice(0, MEETING_TEXT_CAP)}`;
          }
          if (m.transcript_text) {
            const excerpt = m.transcript_text.length > MEETING_TEXT_CAP
              ? m.transcript_text.substring(0, MEETING_TEXT_CAP) + "\n[transcript truncated]"
              : m.transcript_text;
            meetingContext += `\nTranscript:\n${excerpt}`;
          }
        }
      }
    }

    const { data: org } = await supabase
      .from("organizations")
      .select(
        "name, display_name, legal_name, signatory_name, signatory_title, email, phone, website, business_state, business_city"
      )
      .eq("id", contract.org_id)
      .single();

    const { data: activeBrandVoice } = await supabase
      .from("brand_voices")
      .select("*, latest_version:brand_voice_versions(*)")
      .eq("org_id", contract.org_id)
      .eq("active", true)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const brandVoiceVersion = activeBrandVoice?.latest_version?.[0] || null;

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      return new Response(
        JSON.stringify({ error: "Anthropic API key not configured" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Written as the business the client relates to (a secondary brand's clients get that brand's identity).
    const contractBrand = contract.brand ?? contact?.brand ?? null;
    const docBrand: Brand = isBrand(contractBrand) ? contractBrand : DEFAULT_BRAND;
    const identity = brandIdentity(docBrand, org, await loadBrandSender(supabase, contract.org_id, docBrand));
    const companyInfo = {
      name: identity.name,
      email: identity.email,
      phone: identity.phone,
      website: identity.website,
      state: org?.business_state || "",
      city: org?.business_city || "",
    };

    // Documents attached to the deal / client / projects (SAM.gov solicitation files first for
    // government work), explicit picks, uploads, and project context — shared with proposals.
    let sources: GatheredSources;
    try {
      sources = await gatherSources(supabase, {
        orgId: contract.org_id,
        opportunityId: effectiveOpportunityId,
        contactId: contact ? contact_id : null,
        proposalId: proposal_id ?? null,
        isGovernment,
        includeAttachedDocuments: include_attached_documents,
        fileIds: Array.isArray(file_ids) ? file_ids.filter((x) => typeof x === "string") : undefined,
        excludeFileIds: Array.isArray(exclude_file_ids) ? exclude_file_ids.filter((x) => typeof x === "string") : undefined,
        includeLinkedProjects: include_project,
        projectIds: [...(Array.isArray(project_ids) ? project_ids : []), ...(project_id ? [project_id] : [])]
          .filter((x) => typeof x === "string"),
        uploadedDocuments: Array.isArray(uploaded_documents) ? uploaded_documents : undefined,
        fetcher: makeContentFetcher(supabase, { orgId: contract.org_id, requestUserId: userContext.id }),
        documentsHeading: "REFERENCE DOCUMENTS (existing agreements, specs or attachments — mirror their terms where relevant)",
      });
    } catch (err) {
      console.error("[contract-ai-generate] Source gathering failed; continuing without documents/projects:", err);
      sources = { documentsText: "", projectsText: "", documents: [], omittedDocuments: [], projects: [] };
    }

    const systemPrompt = buildSystemPrompt(
      companyInfo,
      brandVoiceVersion,
      contract_type
    );

    const userPrompt = buildUserPrompt(
      contactData,
      proposalContext,
      opportunityContext,
      contract_type,
      contract,
      companyInfo,
      custom_instructions,
      meetingContext,
      sources
    );

    let generatedSections: GeneratedSection[];
    try {
      generatedSections = await callLLM(
        anthropicApiKey,
        CONTRACT_MODEL,
        systemPrompt,
        userPrompt
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `AI generation failed: ${String(err)}` }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Replace any AI-generated signatures section with a deterministic,
    // pre-signed-by-service-provider template. The AI prompt already asks the
    // model to skip this section, but the filter + push here is defensive so
    // we always have exactly one signatures row with our canonical HTML.
    generatedSections = generatedSections.filter(
      (s) => s.section_type !== "signatures"
    );
    const contractPartyBName =
      (contract as { party_b_name?: string | null }).party_b_name ?? null;
    const contractCreatedAt = String(
      (contract as { created_at?: string }).created_at ?? new Date().toISOString()
    );
    generatedSections.push({
      section_type: "signatures",
      title: "Signatures",
      content: buildServiceProviderSignaturesHtml(
        contractPartyBName,
        contractCreatedAt,
        {
          // Settings > Organization > Company profile; falls back to the org's display name.
          legalName: docBrand !== DEFAULT_BRAND ? identity.legal_name : org?.legal_name || identity.name,
          signatoryName: org?.signatory_name || "",
          signatoryTitle: org?.signatory_title || "",
        },
      ),
      annotation: SIGNATURES_SECTION_ANNOTATION,
    });

    for (let i = 0; i < generatedSections.length; i++) {
      const section = generatedSections[i];
      await supabase.from("contract_sections").insert({
        org_id: contract.org_id,
        contract_id,
        title: section.title,
        content: section.content,
        section_type: section.section_type,
        sort_order: i,
        annotation: section.annotation || null,
        ai_generated: true,
      });
    }

    const sourcesUsed = {
      meetings: meeting_ids || [],
      documents: sources.documents,
      omitted_documents: sources.omittedDocuments,
      projects: sources.projects,
    };

    const aiContext = {
      source_proposal_id: proposal_id ?? null,
      sources_used: sourcesUsed,
      proposal_was_signed: isSigned,
      meetings_used: meeting_ids || [],
      contract_type,
      custom_instructions: custom_instructions || null,
      sections_generated: generatedSections.map((s) => s.section_type),
      generated_at: new Date().toISOString(),
    };

    await supabase
      .from("contracts")
      .update({ ai_context: aiContext })
      .eq("id", contract_id);

    await supabase.from("contract_activities").insert({
      org_id: contract.org_id,
      contract_id,
      activity_type: "ai_generated",
      description: `AI generated ${generatedSections.length} contract section(s)${
        proposal_id ? " from proposal" : ""
      }${meeting_ids?.length ? ` using ${meeting_ids.length} meeting(s)` : ""}`,
      metadata: {
        sections_generated: generatedSections.map((s) => s.section_type),
        source_proposal_id: proposal_id ?? null,
        meetings_used: meeting_ids || [],
        contract_type,
      },
      actor_user_id: user_id,
    });

    try {
      const { data: orgUsers } = await supabase
        .from("users")
        .select("id")
        .eq("organization_id", contract.org_id);

      if (orgUsers?.length) {
        await supabase.from("notifications").insert(
          orgUsers.map((u: { id: string }) => ({
            user_id: u.id,
            type: "ai_draft_ready",
            title: "AI Contract Draft Ready",
            body: `An AI-generated contract draft is ready for "${contract.title || "Untitled"}"`,
            link: `/contracts/${contract_id}`,
            metadata: { contract_id },
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
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Contract AI generation error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

interface CompanyInfo {
  name: string;
  email: string;
  phone: string;
  website: string;
  state: string;
  city: string;
}

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  freelance_service: "Freelance Service Agreement",
  retainer: "Retainer Agreement",
  partnership: "Partnership Agreement",
  nda: "Non-Disclosure Agreement",
};

function buildSystemPrompt(
  company: CompanyInfo,
  brandVoiceVersion: Record<string, unknown> | null,
  contractType: string
): string {
  const typeLabel = CONTRACT_TYPE_LABELS[contractType] || contractType;

  let prompt = `You are an expert contract writer for ${company.name}. You draft professional, clear, and fair service agreements.

CONTRACT TYPE: ${typeLabel}

LEGAL DISCLAIMER (must be understood): Every contract you generate is a template for informational purposes only. It does not constitute legal advice. All contracts must be reviewed by a qualified attorney before signing or enforcement.

CORE PRINCIPLE: Every contract must protect both parties fairly, use plain language wherever possible, and be treated as a starting template for attorney review.

COMPANY INFORMATION:
- Company: ${company.name}
- Email: ${company.email}
- Phone: ${company.phone}
- Website: ${company.website}
- Location: ${company.city ? `${company.city}, ` : ""}${company.state || "[STATE]"}

REQUIRED SECTIONS (generate all 11 in order — do NOT include a signatures section):

1. Scope of Work (section_type: "scope")
   - Define exactly what work is included
   - Explicit exclusions (what is NOT included)
   - Annotation: "This defines exactly what work is being done. If it is not listed here, it is not included."

2. Deliverables (section_type: "deliverables")
   - Table format: Deliverable | Description | Due Date
   - Every deliverable must be a tangible thing the client receives
   - Annotation: "These are the specific items the service provider will hand over."

3. Payment Terms (section_type: "payment_terms")
   - Total compensation, payment schedule, late payment terms
   - For projects under $10K: 50% upfront, 50% on completion
   - For projects over $10K: 50% upfront, 25% at midpoint, 25% on completion
   - Annotation: "How much is owed, when payments are due, and what happens if late."

4. Timeline and Milestones (section_type: "timeline")
   - Table format: Milestone | Target Date | Notes
   - Milestones must be concrete checkpoints
   - Annotation: "The project calendar — start date, key checkpoints, end date."

5. Intellectual Property (section_type: "intellectual_property")
   - Default: Client owns all deliverables upon full payment
   - Provider retains portfolio rights
   - Annotation: "Who owns the work product after the project is complete."

6. Confidentiality (section_type: "confidentiality")
   - Mutual obligation, 2-year survival period
   - Exclusions for public/independent/legally-required info
   - Annotation: "Both parties agree not to share private business information with outsiders."

7. Termination (section_type: "termination")
   - 30 days written notice by either party
   - Payment for completed work, refund of prepaid fees for undelivered work
   - Annotation: "The exit clause — how to end the contract, notice required, what happens to payments."

8. Limitation of Liability (section_type: "liability")
   - Liability cap at total contract value
   - Exclusion of indirect/consequential damages
   - Annotation: "Caps the maximum amount either party could owe if something goes wrong."

9. Dispute Resolution (section_type: "dispute_resolution")
   - Mediation first, then binding arbitration
   - Annotation: "How to resolve disagreements without going to court."

10. Governing Law (section_type: "governing_law")
    - State laws, conflict of laws provision
    - Annotation: "Which state's laws apply to this contract."

11. General Provisions (section_type: "general_provisions")
    - Entire agreement, amendments in writing, severability, force majeure, notices
    - Annotation: "Standard housekeeping clauses for edge cases."

NOTE: The Signatures section is generated deterministically AFTER your output
(it pre-fills the service provider side with a cursive signature, printed name,
and date, and leaves the client side blank). Do NOT include a "signatures"
section in your JSON response — it will be filtered out and replaced.

DRAFTING RULES:
- Plain language always. Write "The client pays $5,000 within 10 days of signing" not legalese
- Never leave a critical term blank. Use defaults from the proposal data
- Adapt sections to the contract type: NDA skips Deliverables; Retainer adds Term and Renewal; Partnership adds Profit Distribution
- Use HTML markup in content: <p>, <h3>, <h4>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <thead>, <tbody>, <tr>, <th>, <td>
- Round monetary amounts to clean numbers

ANTI-PATTERNS — NEVER DO THESE:
- Overly complex legalese
- Vague payment terms ("payment upon completion" without specifics)
- Promising enforceability — always note attorney review is needed
- Inserting unflagged clauses the user did not request
- Boilerplate contradicting the actual proposal terms`;

  if (brandVoiceVersion) {
    const toneSettings =
      (brandVoiceVersion.tone_settings as Record<string, number>) || {};
    const dos = (brandVoiceVersion.dos as string[]) || [];
    const donts = (brandVoiceVersion.donts as string[]) || [];

    prompt += `\n\nBRAND VOICE GUIDELINES:`;
    if (Object.keys(toneSettings).length > 0) {
      prompt += `\n- Tone:`;
      if (toneSettings.formality !== undefined) {
        prompt += ` ${toneSettings.formality > 0.5 ? "Formal" : "Casual"},`;
      }
      if (toneSettings.confidence !== undefined) {
        prompt += ` ${toneSettings.confidence > 0.5 ? "Assertive" : "Consultative"},`;
      }
    }
    if (dos.length > 0) prompt += `\n- Do: ${dos.join(", ")}`;
    if (donts.length > 0) prompt += `\n- Avoid: ${donts.join(", ")}`;
  }

  prompt += `

OUTPUT FORMAT:

Return a JSON object with a single "sections" array (the response schema is enforced). Each element of "sections" must have exactly these four string fields:
- "section_type": one of ${CONTRACT_SECTION_TYPES.map((s) => `"${s}"`).join(", ")}
- "title": the section heading
- "content": the section body as well-formatted HTML
- "annotation": a plain-language explanation of what this section means (1-2 sentences)

The "content" field must be HTML. Use <p>, <h3>, <h4>, <ul>, <ol>, <li>, <strong>, <em>, <table> tags.

Example:
{"sections":[{"section_type":"scope","title":"Scope of Work","content":"<p>Service Provider will...</p>","annotation":"This defines exactly what work is being done."}]}`;

  return prompt;
}

function buildUserPrompt(
  contact: ContactData,
  proposalContext: string,
  opportunityContext: string,
  contractType: string,
  contract: Record<string, unknown>,
  company: CompanyInfo,
  customInstructions?: string,
  meetingContext?: string,
  sources?: GatheredSources
): string {
  const typeLabel = CONTRACT_TYPE_LABELS[contractType] || contractType;

  let prompt = `Generate a complete ${typeLabel} with all 11 required sections (the Signatures section is generated separately and must NOT be included in your response).

PARTIES:
Party A (Service Provider): ${contract.party_a_name || company.name}
  Email: ${contract.party_a_email || company.email || "N/A"}

Party B (Client): ${contact.first_name} ${contact.last_name}
  Company: ${contact.company || "N/A"}
  Email: ${contact.email || "N/A"}
  Title: ${contact.job_title || "N/A"}

COMMERCIAL TERMS:
- Contract Value: ${contract.total_value || 0} ${contract.currency || "USD"}
- Effective Date: ${contract.effective_date || "Upon signing"}
- Governing Law: ${contract.governing_law_state || company.state || "[STATE]"}

${proposalContext}
${opportunityContext}`;

  if (meetingContext) {
    prompt += `\n${meetingContext}`;
  }

  // Uploaded + attached documents (capped, ordered) and project context.
  if (sources?.documentsText) prompt += sources.documentsText;
  if (sources?.projectsText) prompt += sources.projectsText;

  if (customInstructions) {
    prompt += `\n\nADDITIONAL INSTRUCTIONS FROM THE USER:\n${customInstructions}`;
  }

  const basis = proposalContext.trim()
    ? "Derive all terms from the proposal data above"
    : "Derive all terms from the meeting context and commercial terms above";
  prompt += `\n\nGenerate all 11 sections with professional HTML content and plain-language annotations. Do NOT include a signatures section — it is generated deterministically after your output. ${basis}. Where a term was explicitly agreed in a meeting, reflect it faithfully and do not invent terms that were never discussed. Return ONLY the raw JSON array.`;

  return prompt;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function validateSection(s: unknown): s is GeneratedSection {
  if (!s || typeof s !== "object") return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj.section_type === "string" &&
    typeof obj.title === "string" &&
    typeof obj.content === "string" &&
    obj.content.length > 0
  );
}

// Structured outputs guarantees the { sections: [...] } shape; parse once and
// fail loudly rather than silently degrading to one "custom" section.
function parseAIResponse(responseText: string): GeneratedSection[] {
  const parsed = JSON.parse(responseText);
  const arr = parsed?.sections;
  if (!Array.isArray(arr)) {
    throw new Error("AI response did not contain a 'sections' array");
  }
  const validated = arr.filter(validateSection).map(ensureAnnotation);
  if (validated.length === 0) {
    throw new Error("AI response contained no valid sections");
  }
  return validated;
}

function ensureAnnotation(s: GeneratedSection): GeneratedSection {
  if (s.annotation) return s;
  const defaults: Record<string, string> = {
    scope:
      "This defines exactly what work is being done. If it is not listed here, it is not included.",
    deliverables:
      "These are the specific items the service provider will hand over.",
    payment_terms:
      "How much is owed, when payments are due, and what happens if late.",
    timeline:
      "The project calendar — start date, key checkpoints, end date.",
    intellectual_property:
      "Who owns the work product after the project is complete.",
    confidentiality:
      "Both parties agree not to share private business information with outsiders.",
    termination:
      "The exit clause — how to end the contract, notice required, what happens to payments.",
    liability:
      "Caps the maximum amount either party could owe if something goes wrong.",
    dispute_resolution:
      "How to resolve disagreements without going to court.",
    governing_law: "Which state's laws apply to this contract.",
    general_provisions: "Standard housekeeping clauses for edge cases.",
    signatures:
      "The contract is not binding until both parties sign and date it.",
  };
  return { ...s, annotation: defaults[s.section_type] || "" };
}

/**
 * Build a deterministic Signatures section HTML with the service provider
 * side pre-filled (legal name, signer name, cursive signature, date) and the
 * client side left blank for the client to complete when signing.
 *
 * The HTML uses inline styles only so it renders identically through the
 * sanitizer (src/utils/sanitizeHtml.ts) and across PublicContractPage,
 * PublicContractSignPage, and ContractDetail.
 */
function buildServiceProviderSignaturesHtml(
  partyBName: string | null,
  createdAt: string,
  provider: { legalName: string; signatoryName: string; signatoryTitle: string },
): string {
  const providerLegalName = escapeHtml(provider.legalName);
  const providerSignatory = escapeHtml(provider.signatoryName);
  const providerTitle = provider.signatoryTitle ? `, ${escapeHtml(provider.signatoryTitle)}` : "";
  const formattedDate = new Date(createdAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const clientName = partyBName ?? "";
  const headerCellStyle =
    "text-align:left;padding:12px;border-bottom:1px solid #334155;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:#94a3b8;";
  const bodyCellStyle = "vertical-align:top;padding:16px 12px;width:50%;";
  const labelStyle =
    "border-top:1px solid #475569;margin:0;padding-top:4px;font-size:11px;color:#64748b;";
  const cursiveStyle =
    "font-family:'Brush Script MT','Lucida Handwriting','Segoe Script',cursive;font-size:32px;margin:0 0 4px 0;color:#22d3ee;";

  return [
    `<p><strong>IN WITNESS WHEREOF,</strong> the parties have executed this Agreement as of the Effective Date written below.</p>`,
    `<table style="width:100%;border-collapse:collapse;margin-top:24px;">`,
    `<thead><tr>`,
    `<th style="${headerCellStyle}">Service Provider</th>`,
    `<th style="${headerCellStyle}">Client</th>`,
    `</tr></thead>`,
    `<tbody>`,
    // Row 1: party name
    `<tr>`,
    `<td style="${bodyCellStyle}"><strong>${providerLegalName}</strong></td>`,
    `<td style="${bodyCellStyle}"><strong>${clientName}</strong></td>`,
    `</tr>`,
    // Row 2: signature
    `<tr>`,
    `<td style="${bodyCellStyle}">`,
    // No configured signatory = leave the line blank rather than pre-sign for someone.
    providerSignatory
      ? `<p style="${cursiveStyle}">${providerSignatory}</p>`
      : `<p style="margin:0 0 4px 0;height:40px;">&nbsp;</p>`,
    `<p style="${labelStyle}">Signature</p>`,
    `</td>`,
    `<td style="${bodyCellStyle}">`,
    `<p style="margin:0 0 4px 0;height:40px;">&nbsp;</p>`,
    `<p style="${labelStyle}">Signature</p>`,
    `</td>`,
    `</tr>`,
    // Row 3: print name
    `<tr>`,
    `<td style="${bodyCellStyle}">`,
    `<p style="margin:0 0 4px 0;">${providerSignatory}${providerTitle}</p>`,
    `<p style="${labelStyle}">Print Name</p>`,
    `</td>`,
    `<td style="${bodyCellStyle}">`,
    `<p style="margin:0 0 4px 0;height:20px;">&nbsp;</p>`,
    `<p style="${labelStyle}">Print Name</p>`,
    `</td>`,
    `</tr>`,
    // Row 4: date
    `<tr>`,
    `<td style="${bodyCellStyle}">`,
    `<p style="margin:0 0 4px 0;">${formattedDate}</p>`,
    `<p style="${labelStyle}">Date</p>`,
    `</td>`,
    `<td style="${bodyCellStyle}">`,
    `<p style="margin:0 0 4px 0;height:20px;">&nbsp;</p>`,
    `<p style="${labelStyle}">Date</p>`,
    `</td>`,
    `</tr>`,
    `</tbody>`,
    `</table>`,
    `<p style="margin-top:24px;font-style:italic;color:#64748b;font-size:13px;">This agreement becomes effective on the date last signed by both parties.</p>`,
  ].join("");
}

async function callLLM(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<GeneratedSection[]> {
  const maxRetries = 3;
  const retryableStatuses = [429, 529, 500, 502, 503];

  // Cache the stable system prompt (contract spec + drafting rules); the
  // client/commercial data lives in the uncached user turn.
  const systemBlocks: AnthropicSystemBlock[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await meteredFetch({ source: "contract-ai-generate", agent: "os" })("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: buildAnthropicHeaders(apiKey),
      body: JSON.stringify({
        model,
        system: systemBlocks,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: CONTRACT_MAX_TOKENS,
        output_config: {
          format: { type: "json_schema", schema: CONTRACT_OUTPUT_SCHEMA },
        },
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as AnthropicResponse;
      const responseText =
        data.content.find((b) => b.type === "text")?.text || "";
      return parseAIResponse(responseText);
    }

    const errBody = await response.text();

    if (retryableStatuses.includes(response.status) && attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
      console.warn(`[contract-ai-generate] Anthropic ${response.status}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
  }

  throw new Error("Exhausted retries calling Anthropic API");
}
