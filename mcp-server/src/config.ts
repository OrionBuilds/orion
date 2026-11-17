export const config = {
  supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  accessToken: process.env.ACCESS_TOKEN || '',
  port: parseInt(process.env.MCP_PORT || '3100', 10),
  // Loopback by default: every client (CLARA, FRIDAY, Office) is on this box. Set MCP_HOST=0.0.0.0
  // only if a remote client is ever added — and firewall it.
  host: process.env.MCP_HOST || '127.0.0.1',
};

export function validateConfig(): void {
  if (!config.supabaseUrl) {
    throw new Error('SUPABASE_URL is required');
  }
  if (!config.supabaseAnonKey) {
    throw new Error('SUPABASE_ANON_KEY is required');
  }
  // ACCESS_TOKEN is now OPTIONAL: for multi-agent use, each agent authenticates
  // its own /mcp requests with its own `Authorization: Bearer <JWT>` and that
  // token is forwarded downstream (per-request). ACCESS_TOKEN is only the
  // fallback when a request carries no Authorization header (single-agent/dev).
  if (!config.accessToken) {
    console.warn(
      '[config] No ACCESS_TOKEN set — every request must send its own Authorization: Bearer <JWT>, or calls will 401.',
    );
  }
}
