import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getVoyageEmbedding } from "../_shared/voyageEmbeddings.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

function jsonResponse(
  body: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Deployed verify_jwt=false, so the gateway lets anyone through - this endpoint had no check
  // of its own. Caller verified before adding this: the dashboard via callEdgeFunction.
  const authClient = getSupabaseClient();
  const userContext = await extractUserContext(req, authClient);
  if (!userContext) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const payload = await req.json();

    if (!payload.action) {
      return jsonResponse({ success: false, error: "Missing action" }, 400);
    }

    // Handlers below query and write with the service-role client, so RLS does not scope
    // them: an org_id from the body let any authenticated user search another org's
    // knowledge base and spend that org's OpenAI key (F-25 pattern). SuperAdmins keep the
    // cross-org pivot they already have elsewhere.
    if (!userContext.orgId) {
      return jsonResponse({ success: false, error: "No organization for caller" }, 403);
    }
    if (
      payload.org_id && payload.org_id !== userContext.orgId && !userContext.isSuperAdmin
    ) {
      console.warn(
        `[ai-knowledge-embeddings] org mismatch: body=${payload.org_id} caller=${userContext.orgId}`,
      );
      return jsonResponse({ success: false, error: "Not a member of this organization" }, 403);
    }
    payload.org_id = userContext.isSuperAdmin
      ? (payload.org_id || userContext.orgId)
      : userContext.orgId;

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    switch (payload.action) {
      case "generate":
        return handleGenerate(supabaseAdmin, payload);
      case "search":
        return handleSearch(supabaseAdmin, payload);
      case "process-knowledge-source":
        return handleProcessKnowledgeSource(supabaseAdmin, payload);
      case "crawl-website":
        return handleCrawlWebsite(payload);
      case "test-retrieval":
        return handleTestRetrieval(supabaseAdmin, payload);
      default:
        return jsonResponse(
          { success: false, error: "Unknown action" },
          400
        );
    }
  } catch (error) {
    console.error("Error in ai-knowledge-embeddings:", error);
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

async function handleGenerate(
  supabase: ReturnType<typeof createClient>,
  payload: Record<string, unknown>
): Promise<Response> {
  const { collection_id, version_id, org_id } = payload as {
    collection_id: string;
    version_id: string;
    org_id: string;
  };

  if (!collection_id || !version_id) {
    return jsonResponse(
      { success: false, error: "Missing collection_id or version_id" },
      400
    );
  }

  const { data: collection } = await supabase
    .from("knowledge_collections")
    .select("org_id")
    .eq("id", collection_id)
    .eq("org_id", org_id)
    .maybeSingle();

  if (!collection) {
    return jsonResponse({ success: false, error: "Collection not found" });
  }

  const { data: version } = await supabase
    .from("knowledge_versions")
    .select("body_text, source_config")
    .eq("id", version_id)
    .eq("collection_id", collection_id)
    .maybeSingle();

  const bodyText =
    version?.body_text || extractTextFromConfig(version?.source_config);

  if (!bodyText) {
    return jsonResponse({
      success: false,
      error: "Version not found or has no content",
    });
  }

  const apiKey = await getOrgOpenAIKey(supabase, collection.org_id);
  if (!apiKey) {
    return jsonResponse({
      success: true,
      chunks: 0,
      note: "OpenAI provider not configured — embeddings skipped",
    });
  }

  await supabase
    .from("knowledge_embeddings")
    .delete()
    .eq("version_id", version_id);

  const chunks = chunkText(bodyText);
  let stored = 0;

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await getEmbedding(apiKey, chunks[i]);
    if (embedding) {
      await supabase.from("knowledge_embeddings").insert({
        collection_id,
        version_id,
        chunk_index: i,
        chunk_text: chunks[i],
        embedding,
      });
      stored++;
    }
  }

  return jsonResponse({ success: true, chunks: stored });
}

async function handleSearch(
  supabase: ReturnType<typeof createClient>,
  payload: Record<string, unknown>
): Promise<Response> {
  const { org_id, query, collection_ids, limit } = payload as {
    org_id: string;
    query: string;
    collection_ids?: string[];
    limit?: number;
  };

  if (!org_id || !query) {
    return jsonResponse(
      { success: false, error: "Missing org_id or query" },
      400
    );
  }

  const apiKey = await getOrgOpenAIKey(supabase, org_id);
  if (!apiKey) {
    return jsonResponse({ success: true, results: [] });
  }

  const queryEmbedding = await getEmbedding(apiKey, query);
  if (!queryEmbedding) {
    return jsonResponse({ success: true, results: [] });
  }

  const { data, error } = await supabase.rpc("search_knowledge_embeddings", {
    p_org_id: org_id,
    p_query_embedding: queryEmbedding,
    p_collection_ids: collection_ids || null,
    p_limit: limit || 5,
  });

  if (error) {
    console.error("Search error:", error);
    return jsonResponse({ success: true, results: [] });
  }

  return jsonResponse({ success: true, results: data || [] });
}

async function handleProcessKnowledgeSource(
  supabase: ReturnType<typeof createClient>,
  payload: Record<string, unknown>
): Promise<Response> {
  const { knowledge_source_id } = payload as { knowledge_source_id: string };

  if (!knowledge_source_id) {
    return jsonResponse(
      { success: false, error: "Missing knowledge_source_id" },
      400
    );
  }

  const { data: source, error: srcErr } = await supabase
    .from("agent_knowledge_sources")
    .select("*")
    .eq("id", knowledge_source_id)
    .eq("org_id", payload.org_id as string)
    .maybeSingle();

  if (srcErr || !source) {
    return jsonResponse({
      success: false,
      error: "Knowledge source not found",
    });
  }

  try {
    let bodyText = "";

    if (source.source_type === "website") {
      const cfg = source.source_config as {
        url?: string;
        crawlType?: string;
      };
      if (cfg.url) {
        bodyText = await fetchPageText(cfg.url);
      }
    } else {
      bodyText = extractTextFromConfig(source.source_config);
    }

    if (!bodyText.trim()) {
      await supabase
        .from("agent_knowledge_sources")
        .update({
          status: "error",
          error_message: "No text content could be extracted from this source",
        })
        .eq("id", knowledge_source_id);
      return jsonResponse({
        success: false,
        error: "No text content could be extracted",
      });
    }

    const apiKey = await getOrgOpenAIKey(supabase, source.org_id);

    await supabase
      .from("knowledge_embeddings")
      .delete()
      .eq("knowledge_source_id", knowledge_source_id);

    if (!apiKey) {
      await supabase
        .from("agent_knowledge_sources")
        .update({
          status: "active",
          error_message: null,
          embedding_count: 0,
          last_embedded_at: new Date().toISOString(),
        })
        .eq("id", knowledge_source_id);

      return jsonResponse({
        success: true,
        chunks: 0,
        note: "OpenAI provider not configured — source saved without embeddings",
      });
    }

    const chunks = chunkText(bodyText);
    let stored = 0;

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await getEmbedding(apiKey, chunks[i]);
      if (embedding) {
        await supabase.from("knowledge_embeddings").insert({
          knowledge_source_id,
          chunk_index: i,
          chunk_text: chunks[i],
          embedding,
        });
        stored++;
      }
    }

    await supabase
      .from("agent_knowledge_sources")
      .update({
        status: "active",
        error_message: null,
        embedding_count: stored,
        last_embedded_at: new Date().toISOString(),
      })
      .eq("id", knowledge_source_id);

    return jsonResponse({ success: true, chunks: stored });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Processing failed";
    await supabase
      .from("agent_knowledge_sources")
      .update({ status: "error", error_message: msg })
      .eq("id", knowledge_source_id);
    return jsonResponse({ success: false, error: msg }, 500);
  }
}

async function handleCrawlWebsite(
  payload: Record<string, unknown>
): Promise<Response> {
  const { url, depth } = payload as { url: string; depth?: number };

  if (!url) {
    return jsonResponse({ success: false, error: "Missing url" }, 400);
  }

  try {
    const pages: Array<{ url: string; title: string; content: string }> = [];

    const mainContent = await fetchPageText(url);
    const mainTitle = extractTitle(mainContent, url);
    pages.push({ url, title: mainTitle, content: mainContent });

    if ((depth ?? 1) > 1) {
      const links = extractInternalLinks(mainContent, url);
      const uniqueLinks = [...new Set(links)].slice(0, 10);

      for (const link of uniqueLinks) {
        try {
          const content = await fetchPageText(link);
          if (content.trim()) {
            pages.push({
              url: link,
              title: extractTitle(content, link),
              content,
            });
          }
        } catch {
          // skip unreachable sub-pages
        }
      }
    }

    return jsonResponse({ success: true, pages });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Failed to crawl website";
    return jsonResponse({ success: false, error: msg, pages: [] });
  }
}

async function handleTestRetrieval(
  supabase: ReturnType<typeof createClient>,
  payload: Record<string, unknown>
): Promise<Response> {
  const { org_id, query, knowledge_source_ids } = payload as {
    org_id: string;
    query: string;
    knowledge_source_ids: string[];
  };

  if (!org_id || !query) {
    return jsonResponse(
      { success: false, error: "Missing org_id or query" },
      400
    );
  }

  const apiKey = await getOrgOpenAIKey(supabase, org_id);
  if (!apiKey) {
    return jsonResponse({
      success: true,
      results: [],
      note: "OpenAI not configured",
    });
  }

  const queryEmbedding = await getEmbedding(apiKey, query);
  if (!queryEmbedding) {
    return jsonResponse({ success: true, results: [] });
  }

  // knowledge_embeddings has no org column, so scope by the org's own sources: an
  // unscoped select returned every tenant's chunk text when no ids were supplied.
  let sourcesQuery = supabase
    .from("agent_knowledge_sources")
    .select("id")
    .eq("org_id", org_id);

  if (knowledge_source_ids?.length) {
    sourcesQuery = sourcesQuery.in("id", knowledge_source_ids);
  }

  const { data: orgSources } = await sourcesQuery;
  const allowedSourceIds = (orgSources || []).map(
    (s: Record<string, unknown>) => s.id as string
  );

  if (!allowedSourceIds.length) {
    return jsonResponse({ success: true, results: [] });
  }

  const { data: embeddings } = await supabase
    .from("knowledge_embeddings")
    .select("chunk_text, knowledge_source_id, embedding")
    .in("knowledge_source_id", allowedSourceIds);
  if (!embeddings?.length) {
    return jsonResponse({ success: true, results: [] });
  }

  const results = embeddings
    .map((e: Record<string, unknown>) => ({
      content: e.chunk_text as string,
      source: (e.knowledge_source_id as string) || "unknown",
      score: cosineSimilarity(
        queryEmbedding,
        e.embedding as number[]
      ),
    }))
    .sort(
      (a: { score: number }, b: { score: number }) => b.score - a.score
    )
    .slice(0, 5);

  return jsonResponse({ success: true, results });
}

function extractTextFromConfig(
  config: Record<string, unknown> | null | undefined
): string {
  if (!config) return "";

  if (
    config.plainText &&
    typeof config.plainText === "string"
  ) {
    return config.plainText;
  }

  if (
    config.content &&
    typeof config.content === "string"
  ) {
    return stripHtml(config.content as string);
  }

  if (Array.isArray(config.faqs)) {
    return (config.faqs as Array<{ question: string; answer: string }>)
      .map(
        (faq) =>
          `Question: ${faq.question}\nAnswer: ${faq.answer}`
      )
      .join("\n\n");
  }

  if (
    Array.isArray(config.selectedColumns) &&
    Array.isArray(config.previewData)
  ) {
    const cols = config.selectedColumns as string[];
    const rows = config.previewData as string[][];
    const header = cols.join(" | ");
    const rowTexts = rows.map((row) => {
      return cols
        .map((_, idx) => row[idx] || "")
        .join(" | ");
    });
    return [header, ...rowTexts].join("\n");
  }

  if (Array.isArray(config.files)) {
    return (
      config.files as Array<{ name: string; contentPreview?: string }>
    )
      .map(
        (f) =>
          f.contentPreview || `[File: ${f.name}]`
      )
      .join("\n\n");
  }

  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; OrionBot/1.0)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    const html = await res.text();
    return stripHtml(html);
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(text: string, fallbackUrl: string): string {
  const first100 = text.slice(0, 100).trim();
  if (first100.length > 5) {
    const endIdx = first100.indexOf(". ");
    return endIdx > 0 ? first100.slice(0, endIdx) : first100;
  }
  return fallbackUrl;
}

function extractInternalLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  try {
    const base = new URL(baseUrl);
    const hrefRe = /href=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRe.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1], baseUrl);
        if (
          resolved.hostname === base.hostname &&
          resolved.pathname !== base.pathname &&
          !resolved.hash &&
          !resolved.pathname.match(/\.(png|jpg|jpeg|gif|svg|css|js|ico|pdf|zip)$/i)
        ) {
          links.push(resolved.href);
        }
      } catch {
        // skip invalid
      }
    }
  } catch {
    // skip
  }
  return links;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = "";

  for (const sentence of sentences) {
    if (
      (currentChunk + " " + sentence).length > CHUNK_SIZE &&
      currentChunk
    ) {
      chunks.push(currentChunk.trim());
      const words = currentChunk.split(" ");
      const overlapWords = words.slice(
        -Math.floor(CHUNK_OVERLAP / 5)
      );
      currentChunk = overlapWords.join(" ") + " " + sentence;
    } else {
      currentChunk = currentChunk
        ? currentChunk + " " + sentence
        : sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// Embeddings are now generated by Voyage AI (Anthropic-recommended), keyed by
// the platform-wide VOYAGE_API_KEY env var. Per-org keys are no longer required;
// this helper just reports availability so existing call sites that gate on
// `apiKey` continue to short-circuit when embeddings aren't configured.
async function getOrgOpenAIKey(
  _supabase: ReturnType<typeof createClient>,
  _orgId: string
): Promise<string | null> {
  return Deno.env.get("VOYAGE_API_KEY") ?? null;
}

async function getEmbedding(
  _apiKey: string,
  text: string
): Promise<number[] | null> {
  return await getVoyageEmbedding(text);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
