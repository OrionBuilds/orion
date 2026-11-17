import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { config, validateConfig } from './config.js';
import { registerAllTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { runWithAuth } from './helpers/auth-context.js';
import { clientIpFrom } from './helpers/authRateLimit.js';

validateConfig();

// A McpServer can only be connected to ONE transport, so each session gets its
// own server instance. (A single shared server crashes with "Already connected
// to a transport" the moment a second client connects — which would break
// multiple agents connecting concurrently.)
function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'orion',
    version: '1.0.0',
  });
  registerAllTools(server);
  registerResources(server);
  return server;
}

// One-shot notice that a token-less request is riding the shared ACCESS_TOKEN
// identity — per-request logging would drown the logs in single-agent setups.
let accessTokenFallbackWarned = false;
function warnAccessTokenFallbackOnce(): void {
  if (accessTokenFallbackWarned) return;
  accessTokenFallbackWarned = true;
  console.warn(
    '[mcp] Request without Authorization header — falling back to the shared ACCESS_TOKEN identity. ' +
    'Every token-less caller that can reach this port acts as that database user; ' +
    'unset ACCESS_TOKEN to require per-agent JWTs instead.',
  );
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'orion-mcp-server', version: '1.0.0' }));
    return;
  }

  if (url.pathname === '/mcp') {
    // Each agent authenticates its own requests; forward that JWT downstream.
    const bearer =
      (req.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '') || undefined;

    // A request with no Authorization header used to fall through to the global
    // ACCESS_TOKEN inside every REST/edge helper — so anyone who could reach
    // this port invoked tools under the shared token's database identity, with
    // all of its RLS permissions, and nothing was ever logged. The fallback is
    // now explicit and opt-in: it only applies when ACCESS_TOKEN is configured
    // (single-agent / local dev), it is announced once, and with no ACCESS_TOKEN
    // a token-less request is rejected here instead of surfacing later as an
    // opaque Supabase 401 mid-tool-call.
    if (req.method !== 'OPTIONS' && !bearer) {
      if (config.accessToken) {
        warnAccessTokenFallbackOnce();
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Unauthorized: /mcp requires an Authorization: Bearer <supabase user JWT> header (no ACCESS_TOKEN fallback is configured on this server).',
        }));
        return;
      }
    }

    if (req.method === 'POST') {
      // Stateless: one transport + one McpServer per request, torn down when the response ends.
      //
      // The session map this replaced (2026-09-14) retained every session's McpServer — ~530
      // registered tools, ~1.5 MB — forever, because every agent call opens a fresh session
      // (agent-core osmcp: connect → call → close) and the SDK client's close() never sends the
      // DELETE that would have freed it. At ~60 sessions/min that was ~90 MB/min: the process
      // hit V8's 4 GB heap and died about every 44 minutes. Nothing resumes a session, so
      // stateless mode (SDK-native: sessionIdGenerator undefined) loses no behaviour.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildMcpServer();
      res.on('close', () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      // The `initialize` POST is auth-wrapped too (it used to run outside runWithAuth).
      // The client IP rides along so auth_sign_in / auth_sign_up can rate-limit per caller.
      await runWithAuth(bearer, () => transport.handleRequest(req, res), clientIpFrom(req.socket.remoteAddress, req.headers));
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // Stateless mode has no resumable SSE stream and no session to terminate.
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' });
      res.end(JSON.stringify({ error: 'Method Not Allowed: this server is stateless (POST only)' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        // Authorization: each agent authenticates its own /mcp requests with a Bearer JWT, so a
        // browser/preflighting client must be allowed to send that header. mcp-session-id is also
        // exposed so a browser client can read the session id minted on `initialize`.
        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, Authorization',
        'Access-Control-Expose-Headers': 'mcp-session-id',
      });
      res.end();
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(config.port, config.host, () => {
  // Advertise a concrete, client-reachable loopback/host, not the bind token:
  //  - 0.0.0.0 is a wildcard bind, not an address a client can connect to -> report 127.0.0.1.
  //  - :: is the IPv6 wildcard bind, likewise unreachable as an address -> report ::1.
  //  - We deliberately avoid "localhost" here: it can resolve to ::1 (IPv6) while we bind IPv4
  //    only, which would make the advertised URL unreachable for same-host clients.
  // For a specific non-loopback bind (e.g. a LAN IP) the exact address is reachable, so use it.
  const reachableHost =
    config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  // IPv6 literals must be bracketed inside a URL authority (e.g. http://[::1]:3100/mcp).
  const displayHost = reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost;
  console.log(`Orion MCP Server running on http://${displayHost}:${config.port}/mcp`);
  console.log(`Health check: http://${displayHost}:${config.port}/health`);
});
