import { supabase } from '../lib/supabase';

export const MMS_MAX_FILES = 10;
export const MMS_MAX_FILE_SIZE = 5 * 1024 * 1024;

export async function uploadMessageMedia(file: File, orgId: string): Promise<string> {
  const ext = file.name.split('.').pop() || 'bin';
  const path = `${orgId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from('message-media')
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) throw new Error(`Media upload failed: ${error.message}`);

  const { data } = supabase.storage.from('message-media').getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Send a previously-inserted outbound SMS row via Twilio. Looks up the row,
 * resolves to/from/body/media from it, then invokes twilio-sms-send with
 * existingMessageId so that function updates this row in place rather than
 * inserting a duplicate.
 */
export async function sendSms(messageId: string): Promise<{ sid: string; status: string }> {
  const { data: msg, error: fetchErr } = await supabase
    .from('messages')
    .select('id, organization_id, body, media_urls, metadata, contact_id, conversation_id')
    .eq('id', messageId)
    .single();

  if (fetchErr || !msg) throw new Error(fetchErr?.message || 'Message not found');

  const meta = (msg.metadata || {}) as Record<string, unknown>;
  const toNumber = (meta.to_number as string) || '';
  const fromNumber = meta.from_number as string | undefined;

  if (!toNumber) throw new Error('Message has no to_number in metadata');

  const { data, error } = await supabase.functions.invoke('twilio-sms-send', {
    body: {
      orgId: msg.organization_id,
      toNumber,
      fromNumber,
      body: msg.body,
      mediaUrls: (msg.media_urls as string[]) || [],
      contactId: msg.contact_id,
      conversationId: msg.conversation_id,
      existingMessageId: msg.id,
      metadata: { source: 'composer' },
    },
  });

  if (error) throw new Error(error.message || 'Failed to send SMS');
  if (!data?.ok) throw new Error(data?.error || 'Failed to send SMS');

  return { sid: data.sid || '', status: 'sent' };
}

/**
 * Mark an outbound SMS row failed when sendSms threw before twilio-sms-send
 * recorded an outcome (e.g. the edge call itself was rejected), so the thread
 * shows it with Retry instead of leaving it stuck as "pending". No-op when the
 * edge function already set the status.
 */
export async function markSmsFailedIfPending(messageId: string, errorMessage: string): Promise<void> {
  const { data: msg, error: fetchErr } = await supabase
    .from('messages')
    .select('status, metadata')
    .eq('id', messageId)
    .single();
  if (fetchErr || !msg || msg.status !== 'pending') return;

  const meta = { ...((msg.metadata as Record<string, unknown>) || {}), error_message: errorMessage };
  const { error } = await supabase
    .from('messages')
    .update({ status: 'failed', metadata: meta })
    .eq('id', messageId)
    .eq('status', 'pending');
  if (error) throw error;
}

export async function retrySms(messageId: string): Promise<{ sid: string; status: string }> {
  // Preserve to_number/from_number (and any other metadata); only clear the
  // fields from the failed attempt. Blanking metadata here would make sendSms
  // throw "Message has no to_number".
  const { data: msg, error: fetchErr } = await supabase
    .from('messages')
    .select('metadata')
    .eq('id', messageId)
    .single();
  if (fetchErr) throw fetchErr;

  const meta = { ...((msg?.metadata as Record<string, unknown>) || {}) };
  delete meta.error;
  delete meta.error_message;
  delete meta.provider_message_id;
  delete meta.provider_status;
  delete meta.rail;

  const { error } = await supabase
    .from('messages')
    .update({ status: 'pending', metadata: meta })
    .eq('id', messageId);

  if (error) throw error;
  return sendSms(messageId);
}
