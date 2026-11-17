/**
 * Fetches the bytes of a File Manager / attachment file server-side so its text can be
 * extracted (see proposal-sources.ts):
 *   - provider 'sam_gov' (or any row with storage_path): private source-documents bucket;
 *   - provider 'google' (or legacy NULL): Google Drive API with a Google token;
 *   - provider 'microsoft': SharePoint / OneDrive via Microsoft Graph (pre-authenticated
 *     download URL, so our bearer token never leaves graph.microsoft.com).
 *
 * Tokens: the requesting user's own connection first, then the file owner's (drive_files.user_id)
 * — the file is attached to a shared CRM record of the same org, so a teammate generating a
 * proposal can use a document a colleague attached from their Drive.
 */
import { getGoogleAccessToken } from "./google-connections.ts";
import { getValidAccessToken as getMsAccessToken } from "./ms-graph.ts";
import { getDownloadUrl, resolveDriveId } from "./ms-files.ts";
import { readCapped } from "./sam-documents.ts";
import { type Db, SOURCE_DOCUMENTS_BUCKET } from "./document-store.ts";
import type { ContentFetcher, FetchedContent, SourceFile } from "./proposal-sources.ts";

export const MAX_PROVIDER_FILE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Google-native formats are exported, not downloaded. */
export const GOOGLE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const tooLarge = (n: number): FetchedContent => ({
  ok: false, status: "too_large", error: `file is ${n} bytes (limit ${MAX_PROVIDER_FILE_BYTES})`,
});

async function bodyToContent(resp: Response, mime: string): Promise<FetchedContent> {
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    return { ok: false, status: "failed", error: `download failed (${resp.status})` };
  }
  const bytes = await readCapped(resp, MAX_PROVIDER_FILE_BYTES);
  if (!bytes) return tooLarge(MAX_PROVIDER_FILE_BYTES + 1);
  return { ok: true, bytes, mime: resp.headers.get("content-type") ?? mime };
}

async function googleToken(db: Db, userId: string, _orgId: string): Promise<string | null> {
  // the user's primary Google account (several accounts may be connected); a revoked one yields null, not another account's token
  // deno-lint-ignore no-explicit-any
  return await getGoogleAccessToken(db as any, userId).catch(() => null);
}

async function fetchGoogle(token: string, f: SourceFile, fetchImpl: typeof fetch): Promise<FetchedContent> {
  const id = encodeURIComponent(f.drive_file_id);
  const exportAs = GOOGLE_EXPORTS[f.mime_type];
  if (f.mime_type.startsWith("application/vnd.google-apps.") && !exportAs) {
    return { ok: false, status: "unsupported", error: `Google ${f.mime_type.split(".").pop()} files have no text export` };
  }
  const url = exportAs
    ? `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`;
  const resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return bodyToContent(resp, exportAs ?? f.mime_type);
}

async function fetchMicrosoft(token: string, f: SourceFile, fetchImpl: typeof fetch): Promise<FetchedContent> {
  const driveId = await resolveDriveId(token);
  const { url } = await getDownloadUrl(token, driveId, f.drive_file_id);
  // Pre-authenticated, short-lived URL: fetched WITHOUT our bearer token.
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return bodyToContent(resp, f.mime_type);
}

export function makeContentFetcher(
  db: Db,
  ctx: { orgId: string; requestUserId: string; fetchImpl?: typeof fetch },
): ContentFetcher {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  return async (f: SourceFile): Promise<FetchedContent> => {
    if (f.size_bytes > MAX_PROVIDER_FILE_BYTES) return tooLarge(f.size_bytes);

    if (f.storage_path) {
      const { data, error } = await db.storage.from(SOURCE_DOCUMENTS_BUCKET).download(f.storage_path);
      if (error || !data) return { ok: false, status: "failed", error: `stored copy unavailable: ${error?.message ?? "missing"}` };
      return { ok: true, bytes: new Uint8Array(await (data as Blob).arrayBuffer()), mime: f.mime_type };
    }
    if (f.provider === "sam_gov") {
      return { ok: false, status: "failed", error: "SAM.gov document not downloaded yet — use Refresh documents" };
    }

    const users = [...new Set([ctx.requestUserId, f.user_id].filter(Boolean))];
    let lastError = "no connected account can read this file";
    for (const uid of users) {
      try {
        if (f.provider === "microsoft") {
          const token = await getMsAccessToken(db as never, uid).catch(() => null);
          if (!token) continue;
          const r = await fetchMicrosoft(token, f, fetchImpl);
          if (r.ok || r.status !== "failed") return r;
          lastError = r.error;
        } else {
          const token = await googleToken(db, uid, ctx.orgId);
          if (!token) continue;
          const r = await fetchGoogle(token, f, fetchImpl);
          if (r.ok || r.status !== "failed") return r;
          lastError = r.error;
        }
      } catch (e) {
        lastError = String((e as Error)?.message ?? e).slice(0, 300);
      }
    }
    return { ok: false, status: "failed", error: lastError };
  };
}
