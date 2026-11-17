/**
 * Shared Voyage AI embeddings helper.
 *
 * Replaces the previous OpenAI text-embedding-3-small calls (1536 dims) with
 * Voyage AI's voyage-3 model truncated to 1024 dims via the `output_dimension`
 * parameter. Voyage is the embeddings provider Anthropic recommends for RAG
 * with Claude.
 *
 * Credentials are platform-wide via the VOYAGE_API_KEY env var.
 *
 * Voyage API reference: https://docs.voyageai.com/reference/embeddings-api
 */

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_MODEL = "voyage-3";
export const VOYAGE_EMBEDDING_DIMENSIONS = 1024;
const MAX_INPUT_CHARS = 32_000;

export interface VoyageEmbeddingOptions {
  /** Hint to Voyage whether this text is a search query or a stored document. */
  inputType?: "document" | "query";
  /** Override the API key (defaults to VOYAGE_API_KEY env var). */
  apiKey?: string;
}

/**
 * Generate a single embedding vector for the given text. Returns null on any
 * failure (missing key, API error, malformed response) so callers can degrade
 * gracefully — matching the contract of the OpenAI helper this replaces.
 */
export async function getVoyageEmbedding(
  text: string,
  opts: VoyageEmbeddingOptions = {},
): Promise<number[] | null> {
  if (!text || !text.trim()) return null;

  const apiKey = opts.apiKey ?? Deno.env.get("VOYAGE_API_KEY");
  if (!apiKey) {
    console.error("[voyageEmbeddings] VOYAGE_API_KEY not configured");
    return null;
  }

  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

  const body: Record<string, unknown> = {
    model: VOYAGE_MODEL,
    input: [truncated],
    output_dimension: VOYAGE_EMBEDDING_DIMENSIONS,
  };
  if (opts.inputType) body.input_type = opts.inputType;

  try {
    const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        "[voyageEmbeddings] Voyage API error:",
        response.status,
        errText.slice(0, 200),
      );
      return null;
    }

    const data = await response.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      console.error("[voyageEmbeddings] Malformed Voyage response");
      return null;
    }
    return embedding as number[];
  } catch (e) {
    console.error("[voyageEmbeddings] Voyage request failed:", e);
    return null;
  }
}

/**
 * Batch variant — embed many texts in one request (cheaper, faster for
 * knowledge-base ingestion). Returns an array aligned with the input texts;
 * individual entries may be null if Voyage omitted them, but if the entire
 * call fails the function returns null instead of a partial array.
 */
export async function getVoyageEmbeddingsBatch(
  texts: string[],
  opts: VoyageEmbeddingOptions = {},
): Promise<Array<number[] | null> | null> {
  if (!texts.length) return [];

  const apiKey = opts.apiKey ?? Deno.env.get("VOYAGE_API_KEY");
  if (!apiKey) {
    console.error("[voyageEmbeddings] VOYAGE_API_KEY not configured");
    return null;
  }

  const sanitized = texts.map((t) =>
    !t ? "" : t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t,
  );

  const body: Record<string, unknown> = {
    model: VOYAGE_MODEL,
    input: sanitized,
    output_dimension: VOYAGE_EMBEDDING_DIMENSIONS,
  };
  if (opts.inputType) body.input_type = opts.inputType;

  try {
    const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        "[voyageEmbeddings] Voyage batch API error:",
        response.status,
        errText.slice(0, 200),
      );
      return null;
    }

    const data = await response.json();
    const items = data?.data;
    if (!Array.isArray(items)) {
      console.error("[voyageEmbeddings] Malformed Voyage batch response");
      return null;
    }

    const result: Array<number[] | null> = new Array(texts.length).fill(null);
    for (const item of items) {
      const idx = typeof item?.index === "number" ? item.index : null;
      const emb = item?.embedding;
      if (idx !== null && idx >= 0 && idx < result.length && Array.isArray(emb)) {
        result[idx] = emb as number[];
      }
    }
    return result;
  } catch (e) {
    console.error("[voyageEmbeddings] Voyage batch request failed:", e);
    return null;
  }
}
