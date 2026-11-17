// Lightweight smoke test for the Orion MCP server — nothing like this existed before this pass,
// and this server is about to become business-critical infra for three production agents.
// Not attempting to cover all 471 tools: just "is this actually up, authenticating correctly, and
// serving a representative read-only call from each major module."
//
// Usage: SMOKE_JWT=<a real Supabase access token> npx tsx scripts/smoke.ts
// (no JWT -> only the /health and the "unauthenticated call is rejected" checks run)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = process.env.MCP_PORT ?? "3100";
const BASE = `http://127.0.0.1:${PORT}`;
const JWT = process.env.SMOKE_JWT;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function callTool(name: string, args: Record<string, unknown>, jwt?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} },
  });
  const client = new Client({ name: "orion-smoke", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  // 1. /health
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    check("GET /health returns 200", r.status === 200, `got ${r.status}`);
  } catch (e) {
    check("GET /health returns 200", false, String(e));
  }

  // 2. Unauthenticated tool call is rejected (proves ACCESS_TOKEN fallback is NOT silently open).
  // Note: a failed tool call comes back as a normal CallToolResult with isError:true — the MCP
  // SDK does NOT throw for this — so both the reject-via-throw and reject-via-isError paths count.
  try {
    const res = await callTool("contacts_list", { limit: 1 });
    const text = Array.isArray(res.content) ? res.content.map((c: any) => ("text" in c ? c.text : "")).join(" ") : "";
    check("unauthenticated call is rejected", Boolean(res.isError), res.isError ? text.slice(0, 100) : "call succeeded — ACCESS_TOKEN fallback may be set");
  } catch (e) {
    check("unauthenticated call is rejected", true, String(e).slice(0, 80));
  }

  if (!JWT) {
    console.log("\nNo SMOKE_JWT set — skipping authenticated module checks.");
    console.log(failures === 0 ? "\nALL PASS (unauthenticated checks only)" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // 3. One representative read-only call per major module, under a real JWT.
  const REPRESENTATIVE: Array<[string, string, Record<string, unknown>]> = [
    ["contacts", "contacts_list", { limit: 1 }],
    ["opportunities", "opportunities_list", { limit: 1 }],
    ["projects", "projects_list", { limit: 1 }],
    ["proposals", "proposals_list", { limit: 1 }],
    ["calendars", "calendars_list", {}],
    ["payments", "invoices_list", { limit: 1 }],
    ["agent-approvals", "workflow_approval_queue_list", { limit: 1 }],
    ["reporting", "analytics_dashboard", {}],
    ["administration", "users_list", { limit: 1 }],
    ["system", "notifications_list", { limit: 1 }],
  ];
  for (const [mod, tool, args] of REPRESENTATIVE) {
    try {
      const res = await callTool(tool, args, JWT);
      check(`${mod}: ${tool}`, !res.isError, res.isError ? "tool returned isError" : undefined);
    } catch (e) {
      check(`${mod}: ${tool}`, false, String(e).slice(0, 120));
    }
  }

  // 4. (manual) Pipeline ownership guard — run under an AGENT JWT (e.g. CLARA) against a
  // project that lives in a pipeline owned by another agent (e.g. Engineering / friday). The call
  // must come back with isError:true and a message naming both pipelines, BEFORE the DB's
  // composite FK ever sees it. Left commented because it needs live ids for the org:
  //
  //   const refused = await callTool("project_move_stage", { id: "<engineering project id>", stage_id: "<any stage id>" }, JWT);
  //   check("pipeline guard refuses cross-pipeline move", Boolean(refused.isError),
  //     (refused.content as any[]).map((c) => c.text).join(" ").slice(0, 160));
  //   // -> Error: CLARA (clara) may only act on no pipeline (none is assigned to it); project <id> is in "Engineering" (owner friday).
  //
  //   const foreignStage = await callTool("projects_update", { id: "<other pipeline project id>", stage_id: "<engineering stage id>" }, JWT);
  //   check("pipeline guard refuses foreign stage", Boolean(foreignStage.isError));
  //   // -> Error: Stage <id> does not belong to pipeline "<other pipeline>". Use project_pipelines_get to list valid stage ids.

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
