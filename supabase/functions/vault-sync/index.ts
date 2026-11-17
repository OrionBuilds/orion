/**
 * vault-sync — FRIDAY's scheduler mirrors the FRIDAY and CLARA Obsidian vaults (which live on the
 * owner's Linux box) into vault_notes / vault_links for the /memory module. See
 * _shared/vault-sync.ts for the manifest → upsert → finish protocol.
 *
 * Auth: the box's sync job sends X-Vault-Sync-Key (the VAULT_SYNC_KEY secret) and writes to
 * VAULT_SYNC_ORG_ID; alternatively a user JWT carrying memory.sync writes to its own org. Writes use
 * the service role; the tables are read-only through the API.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { diffManifest, isVault, parseManifest, parseUpsert, syncKeyMatches } from "../_shared/vault-sync.ts";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const PAGE = 1000;

/** The org a sync-key call writes to: VAULT_SYNC_ORG_ID, else the org of OWNER_USER_ID. */
async function syncKeyOrg(db: ReturnType<typeof getSupabaseClient>): Promise<string | null> {
  const fixed = Deno.env.get("VAULT_SYNC_ORG_ID")?.trim();
  if (fixed) return fixed;
  const owner = Deno.env.get("OWNER_USER_ID")?.trim();
  if (!owner) return null;
  const { data } = await db.from("users").select("organization_id").eq("id", owner).maybeSingle();
  return (data as { organization_id: string } | null)?.organization_id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = getSupabaseClient();

  // Two ways in (the gateway JWT check is off; both are verified here):
  //  - X-Vault-Sync-Key: the Linux box's sync job (FRIDAY's scheduler), no agent sign-in needed;
  //  - a user JWT holding memory.sync.
  let orgId: string;
  const key = req.headers.get("X-Vault-Sync-Key");
  if (key !== null) {
    if (!syncKeyMatches(key, Deno.env.get("VAULT_SYNC_KEY"))) return json({ error: "Unauthorized" }, 401);
    const org = await syncKeyOrg(db);
    if (!org) return json({ error: "VAULT_SYNC_ORG_ID (or OWNER_USER_ID) is not configured" }, 500);
    orgId = org;
  } else {
    const user = await extractUserContext(req, db);
    if (!user) return json({ error: "Unauthorized" }, 401);
    if (!user.permissions.includes("memory.sync")) return json({ error: "Forbidden" }, 403);
    orgId = user.orgId;
  }

  let body: { action?: string } & Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  try {
    switch (body.action) {
      case "manifest": {
        const parsed = parseManifest(body);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const { vault, entries } = parsed.value;
        const stored: { path: string; content_hash: string }[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await db.from("vault_notes").select("path, content_hash")
            .eq("org_id", orgId).eq("vault", vault).order("path").range(from, from + PAGE - 1);
          if (error) throw new Error(`read stored notes: ${error.message}`);
          stored.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        const { need, remove } = diffManifest(entries, stored);
        for (let i = 0; i < remove.length; i += 200) {
          const chunk = remove.slice(i, i + 200);
          await db.from("vault_links").delete().eq("org_id", orgId).eq("vault", vault).in("source_path", chunk);
          const { error } = await db.from("vault_notes").delete().eq("org_id", orgId).eq("vault", vault).in("path", chunk);
          if (error) throw new Error(`delete notes: ${error.message}`);
        }
        return json({ need, removed: remove.length, total: entries.length });
      }

      case "upsert": {
        const parsed = parseUpsert(body);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const { vault, notes } = parsed.value;
        const now = new Date().toISOString();
        const { error } = await db.from("vault_notes").upsert(notes.map((n) => ({
          org_id: orgId, vault, path: n.path, title: n.title, folder: n.folder, content: n.content,
          content_hash: n.hash, size_bytes: new TextEncoder().encode(n.content).length, mtime: n.mtime, synced_at: now,
        })), { onConflict: "org_id,vault,path" });
        if (error) throw new Error(`upsert notes: ${error.message}`);
        // Replace each note's outgoing links.
        const sources = notes.map((n) => n.path);
        const { error: delErr } = await db.from("vault_links").delete().eq("org_id", orgId).eq("vault", vault).in("source_path", sources);
        if (delErr) throw new Error(`clear links: ${delErr.message}`);
        const links = notes.flatMap((n) => n.links.map((t) => ({ org_id: orgId, vault, source_path: n.path, target_path: t })));
        for (let i = 0; i < links.length; i += 1000) {
          const { error: lErr } = await db.from("vault_links").upsert(links.slice(i, i + 1000), { onConflict: "org_id,vault,source_path,target_path", ignoreDuplicates: true });
          if (lErr) throw new Error(`insert links: ${lErr.message}`);
        }
        return json({ upserted: notes.length, links: links.length });
      }

      case "finish": {
        const vault = body.vault;
        if (!isVault(vault)) return json({ error: "unknown vault" }, 400);
        const [{ count: notes }, { count: links }] = await Promise.all([
          db.from("vault_notes").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("vault", vault),
          db.from("vault_links").select("source_path", { count: "exact", head: true }).eq("org_id", orgId).eq("vault", vault),
        ]);
        const lastError = typeof body.error === "string" ? body.error.slice(0, 500) : null;
        const { error } = await db.from("vault_sync_status").upsert({
          org_id: orgId, vault, note_count: notes ?? 0, link_count: links ?? 0, last_error: lastError,
          ...(lastError ? {} : { last_synced_at: new Date().toISOString() }), updated_at: new Date().toISOString(),
        }, { onConflict: "org_id,vault" });
        if (error) throw new Error(`status: ${error.message}`);
        return json({ notes: notes ?? 0, links: links ?? 0 });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error("[vault-sync]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
