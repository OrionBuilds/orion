import { supabase } from '../lib/supabase';

const BUCKET = 'email-attachments';
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * A file attachment for an outbound Conversations email. The edge function
 * (gmail-api) downloads `bucket`/`path` (service role) to base64-encode it into
 * the MIME message; `url` is a signed URL kept for in-app display.
 */
export interface EmailAttachment {
  bucket: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string;
}

export async function uploadEmailAttachment(file: File, orgId: string): Promise<EmailAttachment> {
  const ext = file.name.split('.').pop() || 'bin';
  const path = `${orgId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const mimeType = file.type || 'application/octet-stream';

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`Attachment upload failed: ${error.message}`);

  let url: string | undefined;
  const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, ONE_YEAR);
  if (signed?.signedUrl) url = signed.signedUrl;

  return {
    bucket: BUCKET,
    path,
    filename: file.name,
    mimeType,
    size: file.size,
    url,
  };
}
