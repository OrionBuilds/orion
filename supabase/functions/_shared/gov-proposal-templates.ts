/**
 * Government Proposal Templates
 *
 * Constants and utilities for the proposal-ai-generate edge function
 * when generating government solicitation responses (RFI, RFP, RFQ, etc.).
 */

// ---------------------------------------------------------------------------
// 1. Company Profile + Past Performance (per-org settings)
// ---------------------------------------------------------------------------

/** Org-level gov-bid settings (organizations.gov_company_profile / gov_past_performance). */
export interface GovOrgProfile {
  companyProfile?: string | null;
  pastPerformance?: string | null;
}

/**
 * The company profile and past-performance library come from the org's settings
 * (Settings > Organization > Company profile). Without them, describe the company from its
 * name/contact details only and forbid invented past performance.
 */
export function buildGovCompanySection(
  companyInfo: Record<string, unknown>,
  profile: GovOrgProfile = {},
): string {
  const companyProfile = profile.companyProfile?.trim() || [
    "COMPANY PROFILE",
    "===============",
    "",
    ...(["name", "website", "email", "phone"] as const)
      .filter((k) => typeof companyInfo[k] === "string" && (companyInfo[k] as string).trim())
      .map((k) => `${k[0].toUpperCase()}${k.slice(1)}:${" ".repeat(10 - k.length)}${companyInfo[k]}`),
    "",
    "No detailed company profile (NAICS codes, capabilities, differentiators) is configured.",
    "Do not invent certifications, NAICS codes or capabilities; leave [COMPANY DETAIL: ...] placeholders.",
  ].join("\n");
  const pastPerformance = profile.pastPerformance?.trim() ||
    "PAST PERFORMANCE REFERENCES\n============================\n\nNo past-performance library is configured. " +
      "Never invent contracts, clients, dollar values or outcomes; write [PAST PERFORMANCE: ...] placeholders for the user to fill.";
  return `${companyProfile}\n\n${pastPerformance}`;
}

// ---------------------------------------------------------------------------
// 2. Government Proposal Writing Rules
// ---------------------------------------------------------------------------

export const GOV_WRITING_RULES = `
GOVERNMENT PROPOSAL WRITING RULES
===================================

1.  Mirror the solicitation language exactly - use the same terminology,
    acronyms, and phrasing found in the solicitation document.

2.  Address every evaluation factor with a dedicated section - do not
    combine or skip any stated evaluation criteria.

3.  Lead with the outcome, then explain the method - state the benefit
    or result first, followed by the approach to achieve it.

4.  Quantify everything - include specific metrics, percentages,
    timelines, dollar amounts, and measurable outcomes wherever possible.

5.  Never restate requirements - explain HOW you will fulfill them
    with concrete plans, tools, and evidence.

6.  No marketing fluff - use evidence, metrics, case studies, and
    verifiable past performance instead of subjective claims.

7.  Cross-reference SOW/PWS sections - explicitly cite the Statement
    of Work or Performance Work Statement paragraph numbers.

8.  Include a compliance matrix for complex solicitations - map every
    requirement to the corresponding proposal section and page number.

9.  Open each major section with a bold theme statement - a one-sentence
    thesis that captures the key discriminator for that section.

10. Use action captions for all graphics and tables - every visual
    element must have a caption that reinforces a key message.
`.trim();

// ---------------------------------------------------------------------------
// 3. Solicitation Type -> Required Sections
// ---------------------------------------------------------------------------

export const GOV_SECTION_TYPES: Record<string, string[]> = {
  RFI: [
    'cover_letter',
    'company_overview',
    'relevant_experience',
    'technical_capability',
    'small_business_info',
  ],
  RFP: [
    'executive_summary',
    'understanding',
    'technical_approach',
    'management_approach',
    'past_performance',
    'cost_price',
    'compliance_matrix',
  ],
  RFQ: [
    'cover_letter',
    'pricing',
    'compliance_matrix',
    'past_performance_brief',
  ],
  ITB: [
    'bid_response',
    'pricing',
    'certifications',
  ],
  ITN: [
    'qualifications',
    'proposed_approach',
    'pricing',
  ],
  CSS: [
    'executive_summary',
    'understanding',
    'technical_approach',
    'management_approach',
    'past_performance',
    'cost_price',
    'compliance_matrix',
  ],
};

// ---------------------------------------------------------------------------
// 4. Build Government System Prompt
// ---------------------------------------------------------------------------

export function buildGovSystemPrompt(
  solicitationType: string,
  companyInfo: Record<string, unknown>,
  profile: GovOrgProfile = {},
): string {
  const solType = solicitationType.toUpperCase() as keyof typeof GOV_SECTION_TYPES;
  const sections = GOV_SECTION_TYPES[solType] ?? GOV_SECTION_TYPES.RFP;

  const sectionInstructions = buildSectionInstructions(solType, sections);

  return `You are an expert government proposal writer specializing in federal, state, and local procurement responses. You produce compliant, persuasive, and evidence-backed proposal content.

${buildGovCompanySection(companyInfo, profile)}

${GOV_WRITING_RULES}

---

SOLICITATION TYPE: ${solType}

REQUIRED SECTIONS (generate each in order):
${sections.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}

${sectionInstructions}

PLATFORM-SPECIFIC GUIDANCE:
- For SAM.gov opportunities: reference applicable FAR/DFARS clauses; cite FAR Part 12
  for commercial items, FAR Part 15 for negotiated procurements, and FAR Part 8 for
  schedule contracts. Include DUNS/UEI and CAGE code placeholders.
- For Florida MFMP (MyFloridaMarketPlace) / VBS (Vendor Bid System): reference
  Florida Statute 287, include certified small business and minority business
  enterprise information where applicable, and follow State Term Contract formatting.
- For state/local procurements: tailor language to the issuing jurisdiction and
  reference applicable state procurement codes.

ADDITIONAL COMPANY CONTEXT (if provided):
${JSON.stringify(companyInfo, null, 2)}

OUTPUT FORMAT:
Return a JSON object with a single "sections" array (the response schema is enforced). Each section object must have:
  - "section_type": string matching one of the required sections above
  - "title": human-readable section title
  - "content": the full section text as HTML (use <p>, <ul>, <li>, <strong>, <table>, <tr>, <td>, <th> tags)

Example:
{
  "sections": [
    {
      "section_type": "executive_summary",
      "title": "Executive Summary",
      "content": "<p><strong>Theme:</strong> ...</p><p>...</p>"
    }
  ]
}

COMPLIANCE CHECKLIST (verify before returning):
- Every required section is present
- Each section opens with a bold theme statement
- All quantifiable claims cite specific metrics or past performance
- Solicitation language is mirrored throughout
- SOW/PWS cross-references are included where applicable
- No marketing fluff; every claim is evidence-backed
- Pricing sections use placeholder tables if actual pricing data is not provided
- Small business certifications and NAICS codes are referenced where relevant
`.trim();
}

// ---------------------------------------------------------------------------
// Section-specific instruction builder (internal)
// ---------------------------------------------------------------------------

function buildSectionInstructions(
  solType: string,
  sections: string[],
): string {
  const instructions: string[] = [];

  if (solType === 'RFI') {
    instructions.push(`
SECTION-BY-SECTION INSTRUCTIONS (RFI / Sources Sought / Market Research):

cover_letter:
  - Address the Contracting Officer by name if available
  - State interest in the requirement and capability to perform
  - Reference solicitation/notice number, NAICS code, and set-aside status
  - Keep to one page

company_overview:
  - Present the company profile with legal name, DBA, business type, and locations
  - List all relevant NAICS codes
  - Highlight small business status and any applicable certifications
  - Summarize core capabilities in 2-3 concise paragraphs

relevant_experience:
  - Select 3-5 most relevant past performance examples from the library
  - For each: project name, client sector, scope, scale, measurable outcome
  - Draw explicit parallels to the stated requirement
  - Quantify results with specific metrics

technical_capability:
  - Describe technical approach and tools that align with the requirement
  - Reference specific technologies, methodologies, and certifications
  - Explain how the company's AI-native architecture provides an advantage
  - Keep forward-looking but grounded in demonstrated capability

small_business_info:
  - Confirm small business status
  - List any applicable socioeconomic certifications
  - Reference NAICS codes and size standards
  - Mention teaming or subcontracting approach if relevant
`);
  }

  if (solType === 'RFP' || solType === 'CSS') {
    instructions.push(`
SECTION-BY-SECTION INSTRUCTIONS (RFP / Combined Synopsis Solicitation):

executive_summary:
  - Open with a bold theme statement capturing the primary discriminator
  - Summarize the company's understanding of the requirement
  - State key benefits and outcomes the government will receive
  - Reference 2-3 top past performance results with metrics
  - Keep under 2 pages equivalent

understanding:
  - Demonstrate deep understanding of the requirement and agency mission
  - Paraphrase the SOW/PWS objectives (do not copy verbatim)
  - Identify key challenges and risks
  - Show awareness of the operational environment

technical_approach:
  - Present a detailed, phased approach to meeting the requirements
  - Cross-reference specific SOW/PWS sections
  - Include methodology, tools, technologies, and frameworks
  - Address each evaluation factor with dedicated subsections
  - Incorporate timelines, milestones, and deliverables
  - Reference relevant past performance as proof points

management_approach:
  - Describe project management methodology and governance
  - Present the organizational structure and key personnel roles
  - Explain communication, reporting, and quality assurance processes
  - Address risk management and mitigation strategies
  - Detail the staffing plan and retention approach

past_performance:
  - Present 3-5 most relevant past performance references
  - For each: contract name, client, period, value, scope, and outcomes
  - Include quantified results and relevance to current requirement
  - Provide point-of-contact information placeholders

cost_price:
  - Present pricing in a structured table format
  - Use CLIN (Contract Line Item Number) structure if applicable
  - Include labor categories, rates, and hours if relevant
  - Add assumptions and exclusions
  - Use placeholder values where actual pricing is not provided

compliance_matrix:
  - Map every solicitation requirement to the proposal section and page
  - Include SOW/PWS paragraph references
  - Mark compliance status (Compliant / Exception / Alternative)
  - Format as a table with columns: Requirement, Reference, Section, Status
`);
  }

  if (solType === 'RFQ') {
    instructions.push(`
SECTION-BY-SECTION INSTRUCTIONS (RFQ):

cover_letter:
  - Brief letter of transmittal
  - Reference solicitation number and NAICS code
  - State total quoted price
  - Confirm delivery/performance timeline

pricing:
  - Provide detailed pricing breakdown in table format
  - Use CLIN structure if applicable
  - Include unit prices, quantities, and extended amounts
  - State assumptions, inclusions, and exclusions
  - Add validity period for the quote

compliance_matrix:
  - Map each specification or requirement to compliance status
  - Format as a concise table
  - Note any exceptions or alternatives

past_performance_brief:
  - 2-3 most relevant past performance summaries
  - Focus on similar scope and demonstrated capability
  - Keep each reference to 3-4 sentences with metrics
`);
  }

  if (solType === 'ITB') {
    instructions.push(`
SECTION-BY-SECTION INSTRUCTIONS (ITB):

bid_response:
  - Formal bid response with all required information
  - Reference bid number and line items
  - State firm-fixed pricing

pricing:
  - Line-item pricing table matching bid schedule
  - Include unit prices and extended amounts

certifications:
  - List all applicable business certifications
  - Include representations and certifications as required
`);
  }

  if (solType === 'ITN') {
    instructions.push(`
SECTION-BY-SECTION INSTRUCTIONS (ITN):

qualifications:
  - Company qualifications and relevant experience
  - Key personnel and their credentials
  - Demonstrate ability to perform

proposed_approach:
  - Detailed approach to meeting the requirement
  - Methodology, timeline, and deliverables
  - Innovation and value-added elements

pricing:
  - Pricing proposal in the format specified
  - Include all cost elements and assumptions
`);
  }

  return instructions.join('\n');
}

// ---------------------------------------------------------------------------
// 5. Classify Solicitation Type
// ---------------------------------------------------------------------------

export function classifySolicitationType(
  description: string,
  type?: string,
): string {
  const combined = `${description ?? ''} ${type ?? ''}`.toUpperCase();

  // Order matters: check more specific patterns first
  if (
    combined.includes('REQUEST FOR INFORMATION') ||
    combined.includes('SOURCES SOUGHT') ||
    combined.includes('MARKET RESEARCH')
  ) {
    return 'RFI';
  }

  if (combined.includes('COMBINED SYNOPSIS')) {
    return 'CSS';
  }

  if (combined.includes('REQUEST FOR PROPOSAL')) {
    return 'RFP';
  }

  if (combined.includes('REQUEST FOR QUOTE') || combined.includes('REQUEST FOR QUOTATION')) {
    return 'RFQ';
  }

  if (combined.includes('INVITATION TO BID')) {
    return 'ITB';
  }

  if (combined.includes('INVITATION TO NEGOTIATE')) {
    return 'ITN';
  }

  // Abbreviated forms (check after full phrases to avoid false positives)
  if (/\bRFI\b/.test(combined)) {
    return 'RFI';
  }

  if (/\bCSS\b/.test(combined)) {
    return 'CSS';
  }

  if (/\bRFP\b/.test(combined)) {
    return 'RFP';
  }

  if (/\bRFQ\b/.test(combined)) {
    return 'RFQ';
  }

  if (/\bITB\b/.test(combined)) {
    return 'ITB';
  }

  if (/\bITN\b/.test(combined)) {
    return 'ITN';
  }

  // Fallback heuristics
  if (combined.includes('SPECIAL NOTICE')) {
    return 'RFI';
  }

  if (combined.includes('SOLICITATION')) {
    return 'RFP';
  }

  // Default
  return 'RFP';
}
