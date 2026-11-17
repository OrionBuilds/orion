import { fetchEdge } from '../lib/edgeFunction';

export interface TwilioConnection {
  id: string;
  org_id: string;
  account_sid: string | null;
  friendly_name: string | null;
  status: 'connected' | 'disconnected' | 'error';
  connected_at: string | null;
  last_tested_at: string | null;
}

export interface TwilioStatusResult {
  envConfigured: boolean;
  connection: TwilioConnection | null;
}

export interface TwilioTestResult {
  envConfigured: boolean;
  ok: boolean;
  account?: { sid: string; friendly_name: string; status: string; type: string };
  error?: string;
}

const SLUG = 'twilio-connection';

export async function getTwilioStatus(orgId: string): Promise<TwilioStatusResult> {
  const response = await fetchEdge(SLUG, { body: { orgId, action: 'status' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export async function testTwilio(orgId: string): Promise<TwilioTestResult> {
  const response = await fetchEdge(SLUG, { body: { orgId, action: 'test' } });
  const result = await response.json();
  if (!response.ok && response.status !== 400) throw new Error(result.error);
  return result;
}
