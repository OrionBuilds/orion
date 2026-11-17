import { describe, expect, it } from 'vitest';
import {
  TICKET_ATTACHMENT_ACCEPT,
  TICKET_ATTACHMENT_MAX_BYTES,
  friendlyPortalError,
  ticketAttachmentProblem,
} from './ticketAttachments';

const file = (name: string, size = 1024) => ({ name, size });

describe('ticketAttachmentProblem', () => {
  it('accepts every extension the edge function allows, case-insensitively', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'IMG_1.HEIC', 'f.pdf', 'g.doc', 'h.docx', 'i.txt', 'j.log', 'k.csv']) {
      expect(ticketAttachmentProblem(file(name))).toBeNull();
    }
  });

  it('rejects image types the old image/* picker let through', () => {
    for (const name of ['photo.heif', 'shot.avif', 'x.bmp', 'logo.svg', 'scan.tiff']) {
      expect(ticketAttachmentProblem(file(name))).toMatch(/file type not supported/);
    }
  });

  it('rejects files with no extension', () => {
    expect(ticketAttachmentProblem(file('README'))).toMatch(/file type not supported/);
  });

  it('enforces the 10 MB limit and rejects empty files', () => {
    expect(ticketAttachmentProblem(file('big.png', TICKET_ATTACHMENT_MAX_BYTES))).toBeNull();
    expect(ticketAttachmentProblem(file('big.png', TICKET_ATTACHMENT_MAX_BYTES + 1))).toMatch(/larger than 10 MB/);
    expect(ticketAttachmentProblem(file('empty.png', 0))).toMatch(/empty/);
  });

  it('builds the picker accept list from the same extensions', () => {
    expect(TICKET_ATTACHMENT_ACCEPT).toBe('.png,.jpg,.jpeg,.gif,.webp,.heic,.pdf,.doc,.docx,.txt,.log,.csv');
  });
});

describe('friendlyPortalError', () => {
  it('maps session, access and size failures to actionable messages', () => {
    expect(friendlyPortalError(new Error('Portal request "create-support-ticket" failed (401): {"error":"Unauthorized"}'))).toMatch(/session has expired/);
    expect(friendlyPortalError(new Error('Portal request "create-support-ticket" failed (403): {"error":"Forbidden"}'))).toMatch(/isn't linked to this project/);
    expect(friendlyPortalError(new Error('Portal request "upload-ticket-attachment" failed (413)'))).toMatch(/too large/);
  });

  it('passes other messages through and falls back when there is none', () => {
    expect(friendlyPortalError(new Error('Upload failed: bucket offline'))).toBe('Upload failed: bucket offline');
    expect(friendlyPortalError('nope', 'upload failed')).toBe('upload failed');
  });
});
