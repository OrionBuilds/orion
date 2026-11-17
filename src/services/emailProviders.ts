import { fetchEdge } from '../lib/edgeFunction';

const SLUG = 'resend-provider';

/**
 * Resend is the only email provider. Its API key is a Supabase secret managed from
 * Settings → Integrations → Resend; this only reports whether it is configured.
 */
export interface ProviderStatus {
  /** Whether RESEND_API_KEY / RESEND_FROM_EMAIL resolve in the edge runtime. */
  envConfigured: boolean;
  /** Platform default From (RESEND_FROM_EMAIL), used when an org has no From Address. */
  fromEmail: string | null;
  fromName: string | null;
}

export const RESEND_INTEGRATION_PATH = '/settings/integrations?tab=all';

export async function getProviderStatus(orgId: string): Promise<ProviderStatus | null> {
  const response = await fetchEdge(SLUG, { body: { orgId, action: 'status' } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return {
    envConfigured: !!result.envConfigured,
    fromEmail: (result.fromEmail as string) ?? null,
    fromName: (result.fromName as string) ?? null,
  };
}
