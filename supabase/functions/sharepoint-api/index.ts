import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { getValidAccessToken, resolveMsConnection } from "../_shared/ms-graph.ts";
import { PersonalUnavailableError, personalDriveId, personalEnv, PERSONAL_UNAVAILABLE } from "../_shared/ms-personal-drive.ts";
import { ownedConnectionId } from "../_shared/ms-connection-select.ts";
import * as sp from "../_shared/ms-files.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

/**
 * Drive-API-compatible facade over the shared SharePoint "Office" library, acting through the
 * caller's own Microsoft connection. Same action names as drive-api.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = getSupabaseClient();
    const ctx = await extractUserContext(req, supabase);
    if (!ctx) return json({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const multipart = (req.headers.get("Content-Type") ?? "").includes("multipart/form-data");
    const form = req.method !== "GET" && multipart ? await req.formData() : null;
    const body = req.method !== "GET" && !multipart ? await req.json().catch(() => ({})) : {};
    const action = url.searchParams.get("action") ?? body.action;

    // Optional `connection_id` (query, JSON body or form field) picks one of the caller's Microsoft accounts;
    // default is the primary. A connection that is not the caller's is refused.
    const owned = await ownedConnectionId(supabase, ctx.id,
      url.searchParams.get("connection_id") ?? body.connection_id ?? form?.get("connection_id"));
    if (!owned) return json({ error: "That Microsoft account is not connected for your user" }, 403);
    const token = await getValidAccessToken(supabase, ctx.id, { connectionId: owned.connectionId });

    // Personal Microsoft accounts have OneDrive only: no SharePoint sites or shared libraries.
    const conn = await resolveMsConnection(supabase, ctx.id, { connectionId: owned.connectionId });
    const personal = conn?.account_type === "personal";

    if (action === "list-drives") return json({ drives: await sp.listDrives(token, personal ? personalEnv : undefined) });

    // A caller may target another drive it can reach (e.g. its OneDrive from the project folder
    // picker); Graph enforces access with the caller's own token.
    const driveId = personal
      ? await personalDriveId(token, body.driveId)
      : typeof body.driveId === "string" && body.driveId ? body.driveId : await sp.resolveDriveId(token);

    switch (action) {
      case "list":
        return json(await sp.listChildren(token, driveId, body.folderId || "root", body.pageToken));
      case "search":
        return json(await sp.searchFiles(token, driveId, body.query));
      case "get-metadata":
        return json(await sp.getMetadata(token, driveId, body.fileId));
      case "create-folder":
        return json(await sp.createFolder(token, driveId, body.name, body.parentId || "root"));
      case "delete":
        await sp.deleteItem(token, driveId, body.fileId);
        return json({ success: true });
      case "get-share-link":
        return json(await sp.getShareLink(token, driveId, body.fileId));
      case "get-download-url":
        return json(await sp.getDownloadUrl(token, driveId, body.fileId));
      case "upload": {
        const file = form?.get("file");
        if (!(file instanceof File)) return json({ error: "file is required" }, 400);
        const bytes = new Uint8Array(await file.arrayBuffer());
        return json(await sp.uploadFile(token, driveId, url.searchParams.get("parentId") || "root", file.name, bytes));
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof PersonalUnavailableError) return json({ error: PERSONAL_UNAVAILABLE }, 400);
    const msg = (e as Error).message;
    console.error("[sharepoint-api]", msg);
    return json({ error: msg }, msg.startsWith("Invalid SharePoint") ? 400 : 500);
  }
});
