// Audit every read (*_list) MCP tool against the LIVE schema under a SuperAdmin JWT (clara vault =
// the owner's login, so RLS returns data and any error is a genuine tool bug, not a scoping-induced empty).
// Prints tools that return isError, categorized: SCHEMA (fixable column/embed bug) vs PARAM
// (needs a required arg — not a bug). Run: node scripts/audit-tools.mjs
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
if (!SB || !ANON) throw new Error("Set SUPABASE_URL and SUPABASE_ANON_KEY");

const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".agentic-os", "clara", "os-session.json"), "utf8"));
const tok = await (await fetch(`${SB}/auth/v1/token?grant_type=refresh_token`, {
  method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ refresh_token: s.refresh_token }),
})).json();
if (!tok.access_token) { console.error("no token", tok); process.exit(1); }

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3100/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
});
const c = new Client({ name: "audit", version: "1.0.0" }, { capabilities: {} });
await c.connect(transport);

const { tools } = await c.listTools();
const lists = tools.map((t) => t.name).filter((n) => n.endsWith("_list")).sort();
console.log(`Auditing ${lists.length} *_list tools of ${tools.length} total...\n`);

const SCHEMA_RE = /does not exist|Could not embed|more than one relationship|PGRST|relation .* does not|42703|42P01|API Error 300|API Error 400|column|foreign key|schema cache/i;
const PARAM_RE = /required|must provide|Invalid arguments|Expected|invalid_type|missing/i;

const schemaBugs = [], paramNeeded = [], otherErr = [];
for (const name of lists) {
  try {
    const r = await c.callTool({ name, arguments: { limit: 1 } });
    if (!r.isError) continue;
    const txt = (r.content || []).map((x) => (x.text || "")).join(" ").replace(/\s+/g, " ").trim();
    if (SCHEMA_RE.test(txt) && !PARAM_RE.test(txt)) schemaBugs.push([name, txt.slice(0, 180)]);
    else if (PARAM_RE.test(txt)) paramNeeded.push([name, txt.slice(0, 90)]);
    else otherErr.push([name, txt.slice(0, 180)]);
  } catch (e) {
    otherErr.push([name, String(e.message || e).slice(0, 180)]);
  }
}

const dump = (title, arr) => { console.log(`\n### ${title} (${arr.length})`); for (const [n, t] of arr) console.log(`  ${n}\n     ${t}`); };
dump("SCHEMA BUGS — fix these", schemaBugs);
dump("OTHER ERRORS — inspect", otherErr);
dump("PARAM-NEEDED (not bugs; need an id/arg)", paramNeeded);
console.log(`\nSummary: ${schemaBugs.length} schema bugs, ${otherErr.length} other, ${paramNeeded.length} param-needed, of ${lists.length} list tools.`);
await c.close();
