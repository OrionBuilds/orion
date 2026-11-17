import { supabase } from '../lib/supabase';
import { fetchEdge } from '../lib/edgeFunction';
import type { EmailSetupStatus, EmailTestLog } from '../types';

const SLUG = 'email-send';

export async function getEmailSetupStatus(): Promise<EmailSetupStatus> {
  const response = await fetchEdge(SLUG, { body: { action: 'check-status' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.status;
}

export interface TestEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  blockingReasons?: string[];
  from?: string;
  replyTo?: string | null;
  unsubscribeUrl?: string | null;
}

/** Sends a test via Resend using the org's Defaults; omit fromAddressId to use the default sender. */
export async function sendTestEmail(
  toEmail: string,
  fromAddressId?: string,
  subject?: string,
  body?: string
): Promise<TestEmailResult> {
  const response = await fetchEdge(SLUG, {
    body: { action: 'test', toEmail, fromAddressId: fromAddressId || undefined, subject, body },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons: string[] | undefined = result.blockingReasons;
    return {
      success: false,
      error: reasons?.length ? `${result.error}: ${reasons.join('; ')}` : result.error || `HTTP ${response.status}`,
      blockingReasons: reasons,
    };
  }
  return {
    success: true,
    messageId: result.messageId,
    from: result.from,
    replyTo: result.replyTo ?? null,
    unsubscribeUrl: result.unsubscribeUrl ?? null,
  };
}

/** Sends a pending outbound email `messages` row through Resend (Conversations "Resend" sender). */
export async function sendConversationEmail(
  messageId: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const response = await fetchEdge(SLUG, { body: { action: 'send-message', messageId } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    return { success: false, error: result.error || `HTTP ${response.status}` };
  }
  return { success: true, messageId: result.messageId };
}

export async function getTestEmailLogs(orgId: string, limit = 10): Promise<EmailTestLog[]> {
  const { data, error } = await supabase
    .from('email_test_logs')
    .select(`
      *,
      from_address:email_from_addresses(email, display_name),
      sent_by_user:users(name, email)
    `)
    .eq('org_id', orgId)
    .order('sent_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export interface SendEmailOptions {
  toEmail: string;
  toName?: string;
  fromAddressId?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  unsubscribeGroupId?: string;
  trackOpens?: boolean;
  trackClicks?: boolean;
  transactional?: boolean;
}

export async function sendEmail(
  options: SendEmailOptions
): Promise<{ success: boolean; messageId?: string; error?: string; blockingReasons?: string[] }> {
  const response = await fetchEdge(SLUG, {
    body: { action: 'send', ...options },
  });
  const result = await response.json();
  if (!response.ok) {
    return { success: false, error: result.error, blockingReasons: result.blockingReasons };
  }
  return { success: true, messageId: result.messageId };
}
