import { restRpc } from './rest-client.js';

/** The calling agent's OS identity (agent_whoami RPC, bound to the caller's JWT). */
export interface Whoami {
  user_id: string;
  organization_id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  agent_slug: string | null;
}

export async function whoami(): Promise<Whoami> {
  const raw = await restRpc('agent_whoami');
  const w = (Array.isArray(raw) ? raw[0] : raw) as Whoami | undefined;
  if (!w || !w.organization_id) throw new Error('agent_whoami failed: could not resolve caller identity');
  return w;
}
