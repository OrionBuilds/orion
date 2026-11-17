import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { decryptToken } from "../_shared/crypto.ts";
import { filterRepos, type GithubRepo } from "../_shared/github.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_PAGES = 10; // 1,000 repos

/**
 * The caller's own GitHub account (Settings → Integrations → GitHub; token stored encrypted by
 * integrations-oauth-callback). Actions:
 *   status       → { connected, login }
 *   search-repos → { repos } every repo the account can reach — owned, collaborator (invited) and
 *                  organization — filtered by `query` on owner/name and description.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = getSupabaseClient();
    const ctx = await extractUserContext(req, supabase);
    if (!ctx) return json({ error: "Unauthorized" }, 401);
    const body = await req.json().catch(() => ({})) as { action?: string; query?: string };

    const { data: conn } = await supabase
      .from("integration_connections")
      .select("id, status, access_token_encrypted, account_info, integration:integrations!inner(key)")
      .eq("integration.key", "github")
      .eq("user_id", ctx.id)
      .eq("status", "connected")
      .maybeSingle();

    if (body.action === "status") {
      return json({ connected: Boolean(conn), login: (conn?.account_info as { login?: string } | null)?.login ?? null });
    }
    if (body.action !== "search-repos") return json({ error: "Unknown action" }, 400);
    if (!conn?.access_token_encrypted) return json({ error: "GitHub is not connected", code: "not_connected" }, 409);

    const token = await decryptToken(conn.access_token_encrypted);
    const repos: GithubRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetch(
        `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "orion" } },
      );
      if (r.status === 401) {
        await supabase.from("integration_connections")
          .update({ status: "error", error_message: "GitHub token was revoked or expired; reconnect GitHub" })
          .eq("id", conn.id);
        return json({ error: "GitHub needs to be reconnected", code: "reauth" }, 409);
      }
      if (!r.ok) return json({ error: `GitHub returned ${r.status}` }, 502);
      const batch = await r.json() as GithubRepo[];
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return json({ repos: filterRepos(repos, body.query ?? "") });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[github-api]", msg);
    return json({ error: msg }, 500);
  }
});
