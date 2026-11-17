// Client-side mirror of the upload-ticket-attachment limits enforced in
// supabase/functions/client-portal-auth/index.ts. The edge function stays the
// enforcement point; this only stops the portal offering files the server will
// reject. The picker used to accept `image/*`, which admitted .heif/.avif/.bmp/
// .svg/.tiff — each then failed server-side and aborted the whole ticket.
// Keep this list in sync with ALLOWED_EXT / MAX_BYTES there.
export const TICKET_ATTACHMENT_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'pdf', 'doc', 'docx', 'txt', 'log', 'csv',
] as const;

export const TICKET_ATTACHMENT_ACCEPT = TICKET_ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',');

export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Why the server would reject this file, or null when it will be accepted. */
export function ticketAttachmentProblem(file: { name: string; size: number }): string | null {
  const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : '';
  if (!(TICKET_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `${file.name}: file type not supported (use PNG, JPG, GIF, WEBP, HEIC, PDF, DOC, DOCX, TXT, LOG or CSV)`;
  }
  if (file.size === 0) return `${file.name}: file is empty`;
  if (file.size > TICKET_ATTACHMENT_MAX_BYTES) return `${file.name}: larger than 10 MB`;
  return null;
}

/** Turn a portal request failure (`Portal request "x" failed (401): …`) into
 *  something a client can act on. */
export function friendlyPortalError(err: unknown, fallback = 'Failed to submit. Please try again.'): string {
  const msg = err instanceof Error ? err.message : '';
  if (/\(401\)|Unauthorized/i.test(msg)) {
    return 'Your portal session has expired. Please sign in again and resubmit.';
  }
  if (/\(403\)|Forbidden/i.test(msg)) {
    return "Your portal login isn't linked to this project yet. Please email us and we'll fix your access.";
  }
  if (/\(413\)/.test(msg)) return 'File is too large to upload.';
  if (/File type not allowed/i.test(msg)) return 'File type not supported.';
  if (/exceeds 10MB/i.test(msg)) return 'File is empty or larger than 10 MB.';
  return msg || fallback;
}
