/**
 * SAM.gov solicitation documents: download each notice `resourceLinks` entry server-side, store
 * the bytes in the private `source-documents` bucket, record a real drive_files row (provider
 * 'sam_gov') attached to the opportunity, and extract its text into document_texts.
 *
 * Security:
 *   - Only https links on SAM.gov hosts are fetched; the SAM_GOV_API_KEY is appended here and is
 *     never returned, logged, or stored (source_url is saved with api_key removed).
 *   - Redirects are followed manually (max 5). SAM answers a download with a redirect to a
 *     pre-signed S3 URL, so the only extra hosts allowed are https *.amazonaws.com; the api_key
 *     query parameter is stripped from any hop that is not a SAM host.
 *   - Downloads are capped by size (streamed, aborted past the cap), time, and content type.
 */
import { extractDocumentText, normalizeMime } from "./document-text.ts";
import { type Db, saveDocumentText, SOURCE_DOCUMENTS_BUCKET, storageSafeName } from "./document-store.ts";

type FetchLike = typeof fetch;

export const SAM_HOSTS = new Set(["api.sam.gov", "sam.gov", "www.sam.gov"]);
export const SAM_DOC_MAX_BYTES = 50 * 1024 * 1024; // = source-documents bucket limit
export const SAM_DOC_TIMEOUT_MS = 45_000;
export const SAM_MAX_DOCUMENTS = 40;
const MAX_REDIRECTS = 5;

export const ALLOWED_DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "application/zip",
]);

export function isSamHost(host: string): boolean {
  return SAM_HOSTS.has(host.toLowerCase());
}

/** Hosts a SAM download may redirect to: SAM itself or AWS S3 (pre-signed attachment URLs). */
export function isAllowedRedirectHost(host: string): boolean {
  const h = host.toLowerCase();
  return isSamHost(h) || h === "s3.amazonaws.com" || h.endsWith(".amazonaws.com");
}

/** The stable SAM resource id from `/resources/files/{id}/download`, else null. */
export function samResourceId(link: string): string | null {
  try {
    const m = /\/resources\/files\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(new URL(link).pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The link as we are willing to store it: https SAM host, no credentials, no api_key/token. */
export function sanitizeSamSourceUrl(link: string): string | null {
  try {
    const u = new URL(link);
    if (u.protocol !== "https:" || !isSamHost(u.hostname)) return null;
    u.username = "";
    u.password = "";
    u.searchParams.delete("api_key");
    u.searchParams.delete("token");
    return u.toString();
  } catch {
    return null;
  }
}

/** Builds the request URL for a SAM resource link with the API key appended; null if untrusted. */
export function buildSamResourceRequestUrl(link: string, apiKey: string): URL | null {
  const clean = sanitizeSamSourceUrl(link);
  if (!clean) return null;
  const u = new URL(clean);
  u.searchParams.set("api_key", apiKey);
  return u;
}

/** Filename from a Content-Disposition header (RFC 6266 / 5987), or null. */
export function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
    } catch { /* fall through */ }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  return bare ? bare[1].trim() : null;
}

/** A display filename: no path, no control characters, bounded length. */
export function sanitizeFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  // deno-lint-ignore no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return null;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** Filename hinted by a pre-signed S3 URL (response-content-disposition) or its last path segment. */
export function filenameFromUrl(u: URL): string | null {
  const rcd = u.searchParams.get("response-content-disposition");
  const fromRcd = parseContentDispositionFilename(rcd);
  if (fromRcd) return fromRcd;
  const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  return /\.[A-Za-z0-9]{2,5}$/.test(last) ? last : null;
}

/** Reads a body up to maxBytes. Returns null (and cancels the stream) when it is larger. */
export async function readCapped(resp: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export type SamDownload =
  | { ok: true; bytes: Uint8Array; filename: string | null; mime: string; size: number }
  | { ok: false; error: string; reason: "untrusted" | "http" | "too_large" | "content_type" | "network" };

/** Downloads one SAM resource link with the safety rules described at the top of the file. */
export async function downloadSamResource(
  link: string,
  apiKey: string,
  opts: { fetchImpl?: FetchLike; maxBytes?: number; timeoutMs?: number } = {},
): Promise<SamDownload> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? SAM_DOC_MAX_BYTES;
  const first = buildSamResourceRequestUrl(link, apiKey);
  if (!first) return { ok: false, reason: "untrusted", error: "not an https SAM.gov resource link" };

  const signal = AbortSignal.timeout(opts.timeoutMs ?? SAM_DOC_TIMEOUT_MS);
  let url = first;
  let hintedName: string | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const resp = await doFetch(url.toString(), { redirect: "manual", signal });
      if (resp.status >= 300 && resp.status < 400) {
        await resp.body?.cancel().catch(() => {});
        const loc = resp.headers.get("location");
        if (!loc) return { ok: false, reason: "http", error: `redirect ${resp.status} without location` };
        const next = new URL(loc, url);
        if (next.protocol !== "https:" || !isAllowedRedirectHost(next.hostname)) {
          return { ok: false, reason: "untrusted", error: `redirect to untrusted host ${next.hostname}` };
        }
        // Never forward the SAM key off SAM's own hosts.
        if (!isSamHost(next.hostname)) next.searchParams.delete("api_key");
        hintedName = parseContentDispositionFilename(resp.headers.get("content-disposition")) ?? filenameFromUrl(next) ?? hintedName;
        url = next;
        continue;
      }
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return { ok: false, reason: "http", error: `SAM.gov returned ${resp.status}` };
      }
      const declared = Number(resp.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await resp.body?.cancel().catch(() => {});
        return { ok: false, reason: "too_large", error: `file is ${declared} bytes (limit ${maxBytes})` };
      }
      const filename = sanitizeFilename(
        parseContentDispositionFilename(resp.headers.get("content-disposition")) ?? hintedName ?? filenameFromUrl(url),
      );
      const mime = normalizeMime(resp.headers.get("content-type"), filename);
      if (!ALLOWED_DOC_MIMES.has(mime)) {
        await resp.body?.cancel().catch(() => {});
        return { ok: false, reason: "content_type", error: `content type ${mime} is not an allowed document type` };
      }
      const bytes = await readCapped(resp, maxBytes);
      if (!bytes) return { ok: false, reason: "too_large", error: `file exceeds ${maxBytes} bytes` };
      return { ok: true, bytes, filename, mime, size: bytes.byteLength };
    }
    return { ok: false, reason: "http", error: "too many redirects" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/api_key=[^&\s]+/g, "api_key=***");
    return { ok: false, reason: "network", error: msg.slice(0, 300) };
  }
}

/** Storage abstraction (tests inject a fake; production passes supabase.storage). */
export interface StorageLike {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: string | null }>;
}

export function supabaseStorage(db: Db, bucket = SOURCE_DOCUMENTS_BUCKET): StorageLike {
  return {
    async upload(path, bytes, contentType) {
      const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
      return { error: error?.message ?? null };
    },
  };
}

export interface SamDocResult {
  index: number;
  resource_id: string | null;
  drive_file_id?: string;
  name?: string;
  status: "stored" | "unchanged" | "failed" | "pending";
  text_status?: string;
  error?: string;
}

export interface SyncSamDocumentsOpts {
  orgId: string;
  userId: string;
  opportunityId: string;
  noticeId: string | null;
  resourceLinks: string[];
  apiKey: string;
  /** SAM notice page for "view on SAM.gov" links. */
  noticeUiLink?: string | null;
  /** Re-download even when a stored copy + text already exist. */
  force?: boolean;
  /** Stop starting new downloads after this many ms (remaining links come back as `pending`). */
  budgetMs?: number;
  fetchImpl?: FetchLike;
  storage?: StorageLike;
  now?: () => number;
}

/** The deterministic drive_files.drive_file_id for a SAM document. */
export function samDriveFileKey(noticeOrOppId: string, link: string, index: number): string {
  return `sam-gov:${noticeOrOppId}:${samResourceId(link) ?? `res-${index}`}`;
}

/**
 * Downloads, stores, records, attaches and extracts every resource link of a notice.
 * Idempotent: documents already stored with text are left alone unless `force`.
 * Legacy placeholder rows (`sam-gov-{opportunityId}-res-{i}`) are upgraded in place.
 */
export async function syncSamDocuments(db: Db, o: SyncSamDocumentsOpts): Promise<SamDocResult[]> {
  const now = o.now ?? Date.now;
  const started = now();
  const budget = o.budgetMs ?? 90_000;
  const storage = o.storage ?? supabaseStorage(db);
  const links = [...new Set((o.resourceLinks ?? []).filter((l) => typeof l === "string" && l.trim()))]
    .slice(0, SAM_MAX_DOCUMENTS);
  const results: SamDocResult[] = [];

  for (const [index, link] of links.entries()) {
    const resourceId = samResourceId(link);
    if (now() - started > budget) {
      results.push({ index, resource_id: resourceId, status: "pending", error: "time budget reached; run Refresh documents" });
      continue;
    }
    const key = samDriveFileKey(o.noticeId ?? o.opportunityId, link, index);
    const sourceUrl = sanitizeSamSourceUrl(link);
    if (!sourceUrl) {
      results.push({ index, resource_id: resourceId, status: "failed", error: "not an https SAM.gov resource link" });
      continue;
    }

    const { data: existing } = await db.from("drive_files")
      .select("id, name, storage_path, is_deleted")
      .eq("organization_id", o.orgId).eq("drive_file_id", key).maybeSingle();
    let row = existing as { id: string; name: string; storage_path: string | null } | null;
    if (!row) {
      const { data: legacy } = await db.from("drive_files")
        .select("id, name, storage_path, is_deleted")
        .eq("organization_id", o.orgId).eq("drive_file_id", `sam-gov-${o.opportunityId}-res-${index}`).maybeSingle();
      row = legacy as typeof row;
    }

    if (row?.storage_path && !o.force) {
      const { data: txt } = await db.from("document_texts").select("status").eq("drive_file_id", row.id).maybeSingle();
      if (txt && (txt as { status: string }).status !== "failed") {
        await attach(db, o, row.id);
        results.push({ index, resource_id: resourceId, drive_file_id: row.id, name: row.name, status: "unchanged", text_status: (txt as { status: string }).status });
        continue;
      }
    }

    const dl = await downloadSamResource(link, o.apiKey, { fetchImpl: o.fetchImpl });
    if (!dl.ok) {
      results.push({ index, resource_id: resourceId, drive_file_id: row?.id, status: "failed", error: dl.error });
      continue;
    }
    const name = dl.filename ?? `SAM.gov document ${index + 1}`;
    const path = `${o.orgId}/sam-gov/${o.opportunityId}/${storageSafeName(resourceId ?? `res-${index}`)}/${storageSafeName(name)}`;
    const up = await storage.upload(path, dl.bytes, dl.mime);
    if (up.error) {
      results.push({ index, resource_id: resourceId, drive_file_id: row?.id, name, status: "failed", error: `storage upload failed: ${up.error}` });
      continue;
    }

    const fileFields = {
      organization_id: o.orgId,
      user_id: o.userId,
      drive_file_id: key,
      name,
      mime_type: dl.mime,
      size_bytes: dl.size,
      provider: "sam_gov",
      storage_path: path,
      source_url: sourceUrl,
      web_view_link: o.noticeUiLink ?? null,
      is_deleted: false,
      access_revoked: false,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    let fileId: string | null = row?.id ?? null;
    if (fileId) {
      const { error } = await db.from("drive_files").update(fileFields).eq("id", fileId);
      if (error) { results.push({ index, resource_id: resourceId, drive_file_id: fileId, name, status: "failed", error: error.message }); continue; }
    } else {
      const { data: ins, error } = await db.from("drive_files").insert(fileFields).select("id").single();
      if (error || !ins) { results.push({ index, resource_id: resourceId, name, status: "failed", error: error?.message ?? "insert failed" }); continue; }
      fileId = (ins as { id: string }).id;
    }

    const extracted = await extractDocumentText(dl.bytes, dl.mime, name);
    await saveDocumentText(db, { orgId: o.orgId, driveFileId: fileId, result: extracted, mime: dl.mime, sourceVersion: `sam:${dl.size}` });
    await attach(db, o, fileId);
    results.push({
      index, resource_id: resourceId, drive_file_id: fileId, name, status: "stored", text_status: extracted.status,
      ...(extracted.error ? { error: extracted.error } : {}),
    });
  }
  return results;
}

async function attach(db: Db, o: SyncSamDocumentsOpts, driveFileId: string): Promise<void> {
  await db.from("file_attachments").upsert({
    organization_id: o.orgId,
    drive_file_id: driveFileId,
    entity_type: "opportunities",
    entity_id: o.opportunityId,
    attached_by: o.userId,
    note: "SAM.gov solicitation document",
  }, { onConflict: "drive_file_id,entity_type,entity_id", ignoreDuplicates: true });
}
