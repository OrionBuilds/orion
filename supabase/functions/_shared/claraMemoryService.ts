import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getVoyageEmbedding } from "./voyageEmbeddings.ts";

export type ClaraMemoryType =
  | "preference"
  | "communication_style"
  | "decision"
  | "contact_context"
  | "recurring_pattern"
  | "strategic_context"
  | "behavior_pattern";

export interface ClaraMemoryRow {
  id: string;
  memory_type: ClaraMemoryType;
  title: string | null;
  content: string;
  importance_score: number;
  similarity?: number;
}

export interface StoreMemoryParams {
  userId: string;
  orgId: string;
  memoryType: ClaraMemoryType;
  title?: string;
  content: string;
  importanceScore?: number;
}

/**
 * Generate an embedding via Voyage AI (voyage-3, 1024 dims). Kept exported
 * so existing callers can still import it directly; the `apiKey` arg is
 * ignored (credentials come from the VOYAGE_API_KEY env var).
 */
export async function generateEmbedding(
  _apiKey: string,
  text: string
): Promise<number[] | null> {
  return await getVoyageEmbedding(text.slice(0, 8000));
}

export async function storeMemory(
  supabase: SupabaseClient,
  apiKey: string,
  params: StoreMemoryParams
): Promise<{ id: string } | null> {
  const embeddingText = params.title
    ? `${params.title}: ${params.content}`
    : params.content;
  const embedding = await generateEmbedding(apiKey, embeddingText);

  const { data, error } = await supabase
    .from("clara_memories")
    .insert({
      user_id: params.userId,
      organization_id: params.orgId,
      memory_type: params.memoryType,
      title: params.title || null,
      content: params.content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      importance_score: params.importanceScore ?? 5,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[claraMemory] Failed to store memory:", error.message);
    return null;
  }

  return { id: data.id };
}

export async function retrieveRelevantMemories(
  supabase: SupabaseClient,
  userId: string,
  queryText: string,
  apiKey: string,
  limit = 5
): Promise<ClaraMemoryRow[]> {
  const queryEmbedding = await generateEmbedding(apiKey, queryText);
  if (!queryEmbedding) return [];

  const { data, error } = await supabase.rpc("search_clara_memories", {
    p_user_id: userId,
    p_query_embedding: JSON.stringify(queryEmbedding),
    p_memory_types: null,
    p_limit: limit,
  });

  if (error) {
    console.error("[claraMemory] Retrieval error:", error.message);
    return [];
  }

  return (data || []) as ClaraMemoryRow[];
}

export function formatMemoriesForContext(memories: ClaraMemoryRow[]): string {
  if (!memories.length) return "";

  return memories
    .map((m) => {
      const label = m.title ? `${m.title}: ${m.content}` : m.content;
      return `- (${m.memory_type}) ${label}`;
    })
    .join("\n");
}
