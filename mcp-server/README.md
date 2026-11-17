# Orion MCP Server

`orion-mcp-server` — a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Orion (CRM + business automation) to MCP-compatible clients (Claude, IDE agents, etc.).

It is a **thin, permission-scoped wrapper** over the OS: every tool forwards to the platform's Supabase REST API or edge functions using the caller's user JWT, so all access runs under that user's Row Level Security. The MCP server holds no privileged logic of its own and never talks to the database directly.

## Architecture

- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`). One Node HTTP server, session-based.
- **Endpoints:**
  - `POST /mcp` — JSON-RPC. First `initialize` call mints a session; the response's `mcp-session-id` header must be sent on every subsequent request.
  - `GET /mcp` — server-to-client stream for an existing session (`mcp-session-id` required).
  - `DELETE /mcp` — tears down a session.
  - `GET /health` — liveness probe, returns `{"status":"ok","server":"orion-mcp-server","version":"1.0.0"}`.
- **Auth (per-request, multi-agent):** each `/mcp` request carries its own `Authorization: Bearer <user JWT>`, forwarded downstream to Supabase (with the `apikey` anon key) via an `AsyncLocalStorage` context — so several agents can each connect to one server and act as their own OS user under their own RLS. `ACCESS_TOKEN` is an **optional** fallback used only when a request has no `Authorization` header. There is no per-tool auth; the caller's JWT is the boundary.
- **Surface:** **472 tools** across 28 modules, plus 3 resources (see [Tool catalog](#tool-catalog)).

## Requirements

- Node.js 18+ (the package is ESM — `"type": "module"`).
- A reachable Orion Supabase project and a valid user JWT for the account the tools should act as.

## Setup

```bash
cd mcp-server
npm install
cp .env.example .env   # then fill in the values below
npm run build          # tsc -> dist/
npm start              # node dist/index.js
```

For local development with live reload of TypeScript:

```bash
npm run dev            # tsx src/index.ts
```

On start you should see:

```
Orion MCP Server running on http://127.0.0.1:3100/mcp
Health check: http://127.0.0.1:3100/health
```

## Configuration

Config is read from environment variables in [`src/config.ts`](src/config.ts).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | — | Project URL, e.g. `https://<ref>.supabase.co`. (`VITE_SUPABASE_URL` also accepted.) |
| `SUPABASE_ANON_KEY` | ✅ | — | Anon/publishable key, sent as `apikey`. (`VITE_SUPABASE_ANON_KEY` also accepted.) |
| `ACCESS_TOKEN` | — | — | Optional **fallback** user JWT, used only for requests with no `Authorization` header. In multi-agent use leave it unset so unauthenticated calls 401 instead of acting as a default identity. |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | — | Read into config but not required to boot; reserved for service-role flows. |
| `MCP_PORT` | optional | `3100` | HTTP listen port. |
| `MCP_HOST` | optional | `127.0.0.1` | Bind address. Loopback-only by default (every client is on this box). With the default bind, a **local** client connects to the literal `127.0.0.1` (not `localhost`): the server binds IPv4 loopback, and `localhost` can resolve to IPv6 `::1`. To serve a **remote** client, set `0.0.0.0` (or a specific LAN IP) to expose it — and firewall it; the remote client then connects to this server's reachable address, **not** `127.0.0.1` (which would reach the remote's own loopback). |

Startup fails fast (`validateConfig()`) if `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `ACCESS_TOKEN` is missing.

> **Note:** the committed `.env.example` also lists a `MAILGUN_*` block. That is a leftover from the platform's earlier email provider and is **not read by this server** — email now runs on Resend. Safe to ignore; only the five variables above matter here.

## Tool catalog

454 tools registered via [`src/tools/index.ts`](src/tools/index.ts):

| Module | Tools | Module | Tools |
|---|---:|---|---:|
| proposals | 51 | conversations | 14 |
| projects | 45 | government | 10 |
| payments | 33 | agent-tasks | 10 |
| system | 31 | agent-requests | 8 |
| opportunities | 31 | agent-approvals | 8 |
| calendars | 28 | compliance | 7 |
| contacts | 26 | auth | 7 |
| administration | 21 | documents | 6 |
| integrations | 20 | tasks | 3 |
| forms | 18 | entity-mentions | 3 |
| files | 17 | client-reviews | 3 |
| reporting | 15 | agent-code-runs | 2 |
| communications | 15 | meetings | 1 |
| ai-agents | 15 | agent-usage | 1 |
| project-knowledge | 5 |  |  |
|  |  | **Total** | **454** |

The workflow-engine tools were retired with the engine (2026-10); the two approval-queue tools
(`workflow_approval_queue_list` / `_update`) moved to agent-approvals.

Plus 3 read-only **resources** registered in [`src/resources/index.ts`](src/resources/index.ts).

**Live integration rails** (the OS's current providers, reflected in the tools):

- **SMS/voice → Twilio:** `send_sms`, plus the `phone_*` tools.
- **Email → Resend:** `email_send`, `resend_provider` (`status` | `test`), `resend_domains` (`list` | `sync`). Legacy Mailgun/Plivo tools have been removed.

## Smoke test

With the server running (see below for a throwaway boot), confirm health, the MCP handshake, and the tool list. `tools/list` needs no valid user token; live `tools/call` does.

Throwaway boot (real URL + anon key, placeholder token — fine for `/health` and `tools/list`):

```bash
SUPABASE_URL="https://<ref>.supabase.co" \
SUPABASE_ANON_KEY="<anon-key>" \
ACCESS_TOKEN="placeholder" \
MCP_PORT=3100 \
node dist/index.js
```

```bash
# health
curl -s http://127.0.0.1:3100/health

# initialize -> capture the mcp-session-id response header
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  | grep -i mcp-session-id

# then, with SID from above:
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

A healthy server returns 472 tools. With a placeholder token, `tools/call` returns a graceful `isError` result (e.g. `401: Invalid JWT`) rather than crashing — send a real user JWT in the `Authorization` header to get live data.

For a scripted check (health, tool count, unauthenticated-call rejection, and one read per module with a real JWT), run [`scripts/smoke.ts`](scripts/smoke.ts):

```bash
SMOKE_JWT="<real supabase user jwt>" npx tsx scripts/smoke.ts
```

## Connecting a client

Point any Streamable-HTTP MCP client at `http://<host>:<MCP_PORT>/mcp`. The server manages sessions via the `mcp-session-id` header automatically once the client completes the `initialize` handshake. Each connecting agent should send its own `Authorization: Bearer <user JWT>` on every request.

## Run as an always-on service (Windows)

For the production agents (FRIDAY/CLARA) this server must stay up 24/7. a set of PowerShell scripts (not included in this template) installs it as a supervised background service, mirroring the agents' own supervisor pattern:

- `orion-mcp-supervisor.ps1` — forever-loops `npm start`, singleton mutex, log + 5s restart backoff. Sets `SUPABASE_URL`/`SUPABASE_ANON_KEY` (both non-secret) and **leaves `ACCESS_TOKEN` unset** so unauthenticated calls 401.
- `orion-mcp-watchdog.ps1` — polls `/health` each minute, force-recycles after 3 consecutive down-checks.
- `install-orion-mcp-service.ps1` — registers both as Scheduled Tasks (run **elevated**; `npm install && npm run build` first).

```powershell
powershell -ExecutionPolicy Bypass -File "scripts\install-orion-mcp-service.ps1"
Start-ScheduledTask -TaskName ORION-MCP
```

## Project layout

```
mcp-server/
├── src/
│   ├── index.ts            # HTTP server + transport + session handling
│   ├── config.ts           # env config + validateConfig()
│   ├── helpers/            # rest-client, edge-client, tool-utils, auth-context
│   ├── resources/          # read-only MCP resources
│   └── tools/              # 29 tool modules, registered in index.ts
├── scripts/                # smoke.ts + Windows service (supervisor/watchdog/install)
├── .env.example
├── package.json
└── tsconfig.json
```
