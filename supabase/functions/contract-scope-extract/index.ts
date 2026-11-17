// Autonomy Spec v0.1, items #5/#7 — extracts a structured scope index (deliverables,
// exclusions, SLA terms, rate) from a just-signed contract's content, so CLARA (and the
// overdue-invoice/dispatch gate) can query real fields instead of re-reading prose.
//
// Triggered fire-and-forget from src/services/contractSigning.ts's submitContractSignature()
// (a public signing page — no logged-in user session), so this uses the service-role client
// directly rather than extractUserContext/getSupabaseClient's user-auth path. The DB trigger
// (contract_signed_automation) stays defense-in-depth only for edge-case signing paths that
// don't go through the TS service — see 20260411225743_contract_signed_automation_trigger.sql
// for that convention.
//
// Idempotent: a contract_scope_index row is UNIQUE on contract_id, and this checks for an
// existing row before extracting so a retried/duplicate invocation is a no-op.

import { meteredFetch } from "../_shared/ai-usage.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildAnthropicHeaders, type AnthropicResponse, CLARA_MODEL } from "../_shared/claraConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const EXTRACT_MAX_TOKENS = 4096;

const SCOPE_INDEX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["deliverables", "exclusions", "sla_terms", "rate", "rate_unit"],
  properties: {
    deliverables: {
      type: "array",
      description: "Concrete, tangible things the client receives under this contract.",
      items: { type: "string" },
    },
    exclusions: {
      type: "array",
      description: "Anything the contract explicitly says is NOT included.",
      items: { type: "string" },
    },
    sla_terms: {
      type: "array",
      description: "Response-time / uptime / turnaround commitments, if any are stated. Empty array if none. One entry per distinct term.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string", description: "e.g. 'response_time', 'uptime'." },
          value: { type: "string" },
        },
      },
    },
    rate: {
      type: "number",
      description: "The total or recurring rate/value, as a plain number. 0 if not clearly stated.",
    },
    rate_unit: {
      type: "string",
      description: "e.g. 'total', 'monthly', 'hourly', 'per project'. Empty string if not applicable.",
    },
  },
} as const;

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { contractId } = (await req.json()) as { contractId?: string };
    if (!contractId) {
      return new Response(JSON.stringify({ error: "contractId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getServiceClient();

    const { data: existing } = await supabase
      .from("contract_scope_index")
      .select("id")
      .eq("contract_id", contractId)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ success: true, skipped: "already extracted" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id, org_id, content, total_value, currency")
      .eq("id", contractId)
      .single();
    if (contractError || !contract) {
      return new Response(JSON.stringify({ error: "Contract not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: sections } = await supabase
      .from("contract_sections")
      .select("title, content")
      .eq("contract_id", contractId)
      .order("sort_order", { ascending: true });

    const bodyText = sections?.length
      ? sections.map((s: { title: string; content: string }) => `### ${s.title}\n${stripHtml(s.content)}`).join("\n\n")
      : stripHtml(contract.content || "");

    if (!bodyText.trim()) {
      return new Response(JSON.stringify({ error: "Contract has no content to extract from" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) {
      return new Response(JSON.stringify({ error: "Anthropic API key not configured" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const system = "You extract a structured scope index from a signed contract's text. Be literal — only include what the contract actually says. Do not infer or invent terms it doesn't state.";
    const user = `Extract the scope index from this contract.\n\nStated total value: ${contract.total_value ?? "unknown"} ${contract.currency ?? ""}\n\nCONTRACT TEXT:\n${bodyText.slice(0, 100_000)}`;

    const response = await meteredFetch({ source: "contract-scope-extract", agent: "os" })("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: buildAnthropicHeaders(anthropicApiKey),
      body: JSON.stringify({
        model: CLARA_MODEL,
        system,
        messages: [{ role: "user", content: user }],
        max_tokens: EXTRACT_MAX_TOKENS,
        output_config: { format: { type: "json_schema", schema: SCOPE_INDEX_SCHEMA } },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      return new Response(JSON.stringify({ error: `Anthropic API error ${response.status}: ${errBody}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = (await response.json()) as AnthropicResponse;
    const raw = data.content.find((b) => b.type === "text")?.text || "{}";
    const extracted = JSON.parse(raw) as {
      deliverables: string[]; exclusions: string[]; sla_terms: { key: string; value: string }[]; rate: number; rate_unit: string;
    };
    // Anthropic's structured-outputs schema only allows additionalProperties:false, so the model
    // emits SLA terms as a key/value array — converted back to the Record<string,string> shape
    // the DB column and Office's ScopeIndexTab already expect.
    const slaTermsRecord = Object.fromEntries((extracted.sla_terms ?? []).map((t) => [t.key, t.value]));

    const { data: inserted, error: insertError } = await supabase
      .from("contract_scope_index")
      .insert({
        org_id: contract.org_id,
        contract_id: contractId,
        deliverables: extracted.deliverables ?? [],
        exclusions: extracted.exclusions ?? [],
        sla_terms: slaTermsRecord,
        rate: extracted.rate || null,
        rate_unit: extracted.rate_unit || null,
        status: "extracted",
        raw_extraction: extracted,
      })
      .select("id")
      .single();

    if (insertError) {
      return new Response(JSON.stringify({ error: `Failed to save scope index: ${insertError.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, scopeIndexId: inserted.id }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[contract-scope-extract] error:", error);
    return new Response(JSON.stringify({ error: "Internal server error", details: String(error) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
