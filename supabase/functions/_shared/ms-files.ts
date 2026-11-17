/**
 * SharePoint document library (Microsoft Graph drive) helpers.
 *
 * Returns Google-Drive-shaped file objects (id, name, mimeType, size, parents, webViewLink,
 * createdTime, modifiedTime) so the existing Drive UI can render SharePoint unchanged.
 * Ids are Graph driveItem ids. Deleting goes to the SharePoint recycle bin (recoverable).
 */
import { graphFetch } from "./ms-graph.ts";

type F = typeof fetch;

export const FOLDER_MIME = "application/vnd.google-apps.folder"; // what the Drive UI keys on

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  parentReference?: { id?: string; driveId?: string };
}

export function toDriveFile(i: DriveItem) {
  return {
    id: i.id,
    name: i.name,
    mimeType: i.folder ? FOLDER_MIME : i.file?.mimeType ?? "application/octet-stream",
    size: i.size !== undefined ? String(i.size) : undefined,
    parents: i.parentReference?.id ? [i.parentReference.id] : [],
    webViewLink: i.webUrl,
    createdTime: i.createdDateTime,
    modifiedTime: i.lastModifiedDateTime,
    trashed: false,
  };
}

/** Graph path/OData string literals double their single quotes. */
export const odataQuote = (s: string) => s.replace(/'/g, "''");

/** Reject names SharePoint refuses, before we spend a request on them. */
export function assertValidName(name: string): string {
  const n = (name ?? "").trim();
  if (!n || n.length > 255 || /["*:<>?/\\|]/.test(n) || /^\.+$/.test(n) || /[. ]$/.test(n)) {
    throw new Error(`Invalid SharePoint file or folder name: "${name}"`);
  }
  return n;
}

let cachedDriveId: string | null = null;

/**
 * Which drive the Files UI reads/writes, in priority order:
 *   1. MS_SHAREPOINT_DRIVE_ID — an explicit shared library id.
 *   2. MS_SHAREPOINT_SITE (e.g. "contoso.sharepoint.com:/sites/Office") — resolved once and
 *      cached, since the shared library is the same for everyone.
 *   3. Fallback: the signed-in user's own OneDrive (/me/drive) — resolved per call (NOT cached,
 *      because the id is per-user). This makes Files work with just the Microsoft connection, no
 *      extra configuration; set a SharePoint site/drive later to point everyone at a shared library.
 */
export async function resolveDriveId(
  accessToken: string,
  env: { get(k: string): string | undefined } = Deno.env,
  fetchImpl?: F,
): Promise<string> {
  const fixed = env.get("MS_SHAREPOINT_DRIVE_ID")?.trim();
  if (fixed) return fixed;
  const site = env.get("MS_SHAREPOINT_SITE")?.trim();
  if (site) {
    if (cachedDriveId) return cachedDriveId;
    const r = await graphFetch(accessToken, `/sites/${site}/drive?$select=id`, {}, fetchImpl);
    if (!r.ok) throw new Error(`Could not resolve SharePoint drive: ${r.status}`);
    cachedDriveId = (await r.json() as { id: string }).id;
    return cachedDriveId;
  }
  const r = await graphFetch(accessToken, `/me/drive?$select=id`, {}, fetchImpl);
  if (!r.ok) throw new Error(`Could not resolve OneDrive: ${r.status}`);
  return (await r.json() as { id: string }).id;
}

export interface MsDriveChoice {
  id: string;
  name: string;
  kind: "sharepoint" | "onedrive";
  webUrl?: string;
}

/**
 * Drives a folder can be picked from: the shared SharePoint library (when one is configured) and
 * the signed-in user's own OneDrive. Deduplicated, since without a configured library
 * resolveDriveId already falls back to the OneDrive.
 */
export async function listDrives(
  accessToken: string,
  env: { get(k: string): string | undefined } = Deno.env,
  fetchImpl?: F,
): Promise<MsDriveChoice[]> {
  const out: MsDriveChoice[] = [];
  if (env.get("MS_SHAREPOINT_DRIVE_ID")?.trim() || env.get("MS_SHAREPOINT_SITE")?.trim()) {
    const id = await resolveDriveId(accessToken, env, fetchImpl);
    const r = await graphFetch(accessToken, `/drives/${id}?$select=id,name,webUrl`, {}, fetchImpl);
    const d = r.ok ? await r.json() as { name?: string; webUrl?: string } : {};
    out.push({ id, name: d.name ? `SharePoint · ${d.name}` : "SharePoint library", kind: "sharepoint", webUrl: d.webUrl });
  }
  const me = await graphFetch(accessToken, `/me/drive?$select=id,webUrl`, {}, fetchImpl);
  if (me.ok) {
    const d = await me.json() as { id: string; webUrl?: string };
    if (!out.some((x) => x.id === d.id)) out.push({ id: d.id, name: "OneDrive", kind: "onedrive", webUrl: d.webUrl });
  }
  if (out.length === 0) throw new Error(`Could not list Microsoft drives: ${me.status}`);
  return out;
}

const itemPath = (driveId: string, id: string) =>
  id === "root" ? `/drives/${driveId}/root` : `/drives/${driveId}/items/${encodeURIComponent(id)}`;

export async function listChildren(
  token: string, driveId: string, folderId: string, pageUrl?: string, fetchImpl?: F,
) {
  const url = pageUrl ?? `${itemPath(driveId, folderId)}/children?$top=100&$orderby=name`;
  const r = await graphFetch(token, url, {}, fetchImpl);
  if (!r.ok) throw new Error(`Failed to list files: ${r.status}`);
  const j = await r.json() as { value: DriveItem[]; "@odata.nextLink"?: string };
  // Folders first, like the Google listing the UI expects.
  const files = j.value.map(toDriveFile).sort((a, b) =>
    Number(b.mimeType === FOLDER_MIME) - Number(a.mimeType === FOLDER_MIME));
  return { files, nextPageToken: j["@odata.nextLink"] };
}

export async function searchFiles(token: string, driveId: string, query: string, fetchImpl?: F) {
  const q = (query ?? "").trim();
  if (!q) return { files: [] };
  const r = await graphFetch(token, `/drives/${driveId}/root/search(q='${encodeURIComponent(odataQuote(q))}')?$top=50`, {}, fetchImpl);
  if (!r.ok) throw new Error(`Search failed: ${r.status}`);
  return { files: (await r.json() as { value: DriveItem[] }).value.map(toDriveFile) };
}

export async function getMetadata(token: string, driveId: string, id: string, fetchImpl?: F) {
  const r = await graphFetch(token, itemPath(driveId, id), {}, fetchImpl);
  if (!r.ok) throw new Error(`Failed to get file: ${r.status}`);
  return toDriveFile(await r.json() as DriveItem);
}

/** Creates a folder; if one with that name already exists, returns it (idempotent). */
export async function createFolder(
  token: string, driveId: string, name: string, parentId: string, fetchImpl?: F,
) {
  const r = await graphFetch(token, `${itemPath(driveId, parentId || "root")}/children`, {
    method: "POST",
    body: JSON.stringify({ name: assertValidName(name), folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
  }, fetchImpl);
  if (r.status === 409) {
    const ex = await graphFetch(token, `${itemPath(driveId, parentId || "root")}/children?$filter=name eq '${encodeURIComponent(odataQuote(name.trim()))}'`, {}, fetchImpl);
    const found = ex.ok ? (await ex.json() as { value: DriveItem[] }).value.find((i) => i.folder) : undefined;
    if (found) return toDriveFile(found);
    throw new Error(`A non-folder item named "${name}" already exists`);
  }
  if (!r.ok) throw new Error(`Failed to create folder: ${r.status}`);
  return toDriveFile(await r.json() as DriveItem);
}

export async function deleteItem(token: string, driveId: string, id: string, fetchImpl?: F) {
  if (id === "root") throw new Error("Refusing to delete the library root");
  const r = await graphFetch(token, itemPath(driveId, id), { method: "DELETE" }, fetchImpl);
  if (r.status !== 204 && r.status !== 404) throw new Error(`Failed to delete: ${r.status}`);
}

const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 10; // must be a multiple of 320 KiB

export async function uploadFile(
  token: string, driveId: string, parentId: string, name: string, data: Uint8Array, fetchImpl?: F,
) {
  const safe = assertValidName(name);
  const base = `${itemPath(driveId, parentId || "root")}:/${encodeURIComponent(safe)}:`;
  if (data.byteLength <= SIMPLE_UPLOAD_MAX) {
    // Rename on a name clash, like the upload-session path below; a bare PUT overwrote the existing file.
    const r = await graphFetch(token, `${base}/content?@microsoft.graph.conflictBehavior=rename`, {
      method: "PUT", body: data as unknown as BodyInit, headers: { "Content-Type": "application/octet-stream" },
    }, fetchImpl);
    if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
    return toDriveFile(await r.json() as DriveItem);
  }
  const s = await graphFetch(token, `${base}/createUploadSession`, {
    method: "POST", body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
  }, fetchImpl);
  if (!s.ok) throw new Error(`Upload session failed: ${s.status}`);
  const { uploadUrl } = await s.json() as { uploadUrl: string };
  const doFetch = fetchImpl ?? fetch;
  for (let off = 0; off < data.byteLength; off += CHUNK) {
    const end = Math.min(off + CHUNK, data.byteLength);
    // The session URL is pre-authorized: it must NOT receive our bearer token.
    const r = await doFetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(end - off), "Content-Range": `bytes ${off}-${end - 1}/${data.byteLength}` },
      body: data.subarray(off, end) as unknown as BodyInit,
    });
    if (r.status === 200 || r.status === 201) return toDriveFile(await r.json() as DriveItem);
    if (r.status !== 202) throw new Error(`Upload chunk failed: ${r.status}`);
  }
  throw new Error("Upload session ended without a completed item");
}

/** Org-scoped (not anonymous) view link: only people with tenant access can open it. */
export async function getShareLink(token: string, driveId: string, id: string, fetchImpl?: F) {
  const r = await graphFetch(token, `${itemPath(driveId, id)}/createLink`, {
    method: "POST", body: JSON.stringify({ type: "view", scope: "organization" }),
  }, fetchImpl);
  if (!r.ok) throw new Error(`Failed to create share link: ${r.status}`);
  return { link: (await r.json() as { link: { webUrl: string } }).link.webUrl };
}

export async function getDownloadUrl(token: string, driveId: string, id: string, fetchImpl?: F) {
  const r = await graphFetch(token, `${itemPath(driveId, id)}?$select=id,@microsoft.graph.downloadUrl`, {}, fetchImpl);
  if (!r.ok) throw new Error(`Failed to get download url: ${r.status}`);
  const url = (await r.json() as Record<string, string>)["@microsoft.graph.downloadUrl"];
  if (!url) throw new Error("Item has no download url (is it a folder?)");
  return { url };
}
