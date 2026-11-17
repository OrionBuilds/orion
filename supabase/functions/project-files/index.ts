import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { getValidAccessToken } from "../_shared/ms-graph.ts";
import { ownedConnectionId } from "../_shared/ms-connection-select.ts";
import * as sp from "../_shared/ms-files.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_BYTES = 25 * 1024 * 1024;
// The Microsoft account that files land under: Clara's own account (connected as her agent mailbox in
// Settings → Integrations → Microsoft 365). MS_FILES_ACCOUNT_EMAIL overrides it.
const DEFAULT_ACCOUNT = "clara@example.com";

/**
 * Upload a file into a project's SharePoint/OneDrive folder (projects.files_*), acting through the
 * agent Microsoft account above. FRIDAY uses it to file run reports when a project's folder is in
 * Microsoft (her own Drive library is Google-only).
 *
 *   { action: "upload", drive_id, folder_id, category?, file_name, content_base64 }
 *     → { id, name, url }
 *
 * Only a folder that IS some project's chosen Microsoft folder in the caller's org is accepted, so
 * this can't be used to write anywhere else the agent account can reach. `category` files into a
 * sub-folder of that name (created if missing).
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = getSupabaseClient();
    const ctx = await extractUserContext(req, supabase);
    if (!ctx) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action !== "upload") return json({ error: "Unknown action" }, 400);
    const driveId = typeof body.drive_id === "string" && body.drive_id ? body.drive_id : null;
    const folderId = typeof body.folder_id === "string" ? body.folder_id : "";
    const fileName = typeof body.file_name === "string" ? body.file_name : "";
    const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : null;
    if (!folderId || !fileName || typeof body.content_base64 !== "string") {
      return json({ error: "folder_id, file_name and content_base64 are required" }, 400);
    }

    let projectQuery = supabase.from("projects").select("id, name")
      .eq("org_id", ctx.orgId).eq("files_provider", "microsoft").eq("files_folder_id", folderId);
    projectQuery = driveId ? projectQuery.eq("files_drive_id", driveId) : projectQuery.is("files_drive_id", null);
    const { data: project } = await projectQuery.limit(1).maybeSingle();
    if (!project) return json({ error: "That folder isn't a project's Microsoft files folder in your organization" }, 404);

    // Optional `connection_id`: file through one of the CALLER's own Microsoft accounts instead of the agent
    // account below (refused if it is not the caller's). Without it, behaviour is unchanged.
    const owned = await ownedConnectionId(supabase, ctx.id, body.connection_id);
    if (!owned) return json({ error: "That Microsoft account is not connected for your user" }, 403);
    let accountEmail = (Deno.env.get("MS_FILES_ACCOUNT_EMAIL") ?? DEFAULT_ACCOUNT).trim().toLowerCase();
    let account: { id: string; user_id: string; connection_status: string } | null;
    if (owned.connectionId) {
      const { data } = await supabase.from("microsoft_oauth_master").select("id, user_id, email, connection_status")
        .eq("id", owned.connectionId).eq("user_id", ctx.id).maybeSingle();
      account = data as typeof account;
      if (data?.email) accountEmail = String(data.email).toLowerCase();
    } else {
      const { data } = await supabase.from("microsoft_oauth_master")
        .select("id, user_id, connection_status")
        .eq("organization_id", ctx.orgId).ilike("email", accountEmail).maybeSingle();
      account = data as typeof account;
    }
    if (!account || account.connection_status !== "active") {
      return json({ error: `The Microsoft account ${accountEmail} isn't connected (Settings → Integrations → Microsoft 365 → Connect Clara's mailbox)`, code: "account_not_connected" }, 409);
    }

    const bytes = Uint8Array.from(atob(body.content_base64), (c) => c.charCodeAt(0));
    if (bytes.byteLength > MAX_BYTES) return json({ error: "File is larger than 25 MB" }, 413);

    const token = await getValidAccessToken(supabase, account.user_id, { connectionId: account.id });
    const drive = driveId ?? await sp.resolveDriveId(token);
    try {
      const parent = category ? (await sp.createFolder(token, drive, category, folderId)).id : folderId;
      const item = await sp.uploadFile(token, drive, parent, sp.assertValidName(fileName), bytes);
      return json({ id: item.id, name: item.name, url: item.webViewLink ?? null, project_id: project.id });
    } catch (e) {
      const msg = (e as Error).message;
      if (/: (403|404)$/.test(msg)) {
        return json({
          error: `${accountEmail} can't reach this folder. Share the folder with that account, or pick one in the SharePoint library.`,
          code: "no_access",
        }, 403);
      }
      throw e;
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[project-files]", msg);
    return json({ error: msg }, msg.startsWith("Invalid SharePoint") ? 400 : 500);
  }
});
