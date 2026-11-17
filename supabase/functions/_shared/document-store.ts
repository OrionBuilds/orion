/**
 * Persistence helpers for extracted document text (public.document_texts) and the
 * private `source-documents` bucket. Service-role callers only.
 */
import type { ExtractionResult } from "./document-text.ts";

export const SOURCE_DOCUMENTS_BUCKET = "source-documents";

// deno-lint-ignore no-explicit-any
export type Db = { from: (t: string) => any; storage?: any };

export interface DocumentTextRow {
  drive_file_id: string;
  status: ExtractionResult["status"];
  text_content: string;
  char_count: number;
  page_count: number | null;
  error: string | null;
  source_version: string | null;
}

/** Upserts the extracted text for one drive_files row (unique on drive_file_id). */
export async function saveDocumentText(
  db: Db,
  args: {
    orgId: string;
    driveFileId: string;
    result: ExtractionResult;
    mime: string | null;
    sourceVersion?: string | null;
  },
): Promise<{ error: string | null }> {
  const now = new Date().toISOString();
  const { error } = await db.from("document_texts").upsert({
    org_id: args.orgId,
    drive_file_id: args.driveFileId,
    status: args.result.status,
    text_content: args.result.text,
    char_count: args.result.text.length,
    page_count: args.result.pageCount,
    mime_type: args.mime,
    extractor: args.result.extractor,
    error: args.result.error ?? null,
    source_version: args.sourceVersion ?? null,
    extracted_at: now,
    updated_at: now,
  }, { onConflict: "drive_file_id" });
  return { error: error?.message ?? null };
}

/** Loads stored text rows for a set of drive_files ids, keyed by drive_file_id. */
export async function loadDocumentTexts(db: Db, orgId: string, driveFileIds: string[]): Promise<Map<string, DocumentTextRow>> {
  if (driveFileIds.length === 0) return new Map();
  const { data } = await db.from("document_texts")
    .select("drive_file_id, status, text_content, char_count, page_count, error, source_version")
    .eq("org_id", orgId)
    .in("drive_file_id", driveFileIds);
  return new Map(((data ?? []) as DocumentTextRow[]).map((r) => [r.drive_file_id, r]));
}

/** Storage path segment safe for Supabase object keys. */
export function storageSafeName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_");
  return (cleaned.replace(/^[._]+/, "") || "document").slice(0, 150);
}
