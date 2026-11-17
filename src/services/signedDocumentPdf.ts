// Signed-document PDF export — the copy you hand a merchant during a payment dispute.
//
// WHAT MAKES THIS DIFFERENT FROM contractPdfExport.ts. That one calls generateContractHTML() with
// the CURRENT contract row and opens a print dialog. For everyday "send me a copy" that's fine. For
// a dispute it is the wrong document: it re-renders today's data, so any edit made after signing
// silently appears in a file being presented as what the client agreed to. This module renders
// `frozen_html_snapshot` — the exact bytes shown at signing, written at send time by
// contractSigning.ts — and nothing else.
//
// ON DEMAND, NOT AT SIGNING. The archival record is already the snapshot + frozen_document_hash in
// the database; the PDF is only a rendering of it. Generating on demand means every historic signed
// record works immediately with no backfill, and nothing new has to be kept in sync.
//
// WHY AN IFRAME. The snapshots are complete standalone documents (<!doctype html>, own <style>,
// dark #0f172a theme), not fragments. They cannot be injected into the app DOM — their CSS would
// leak into the admin UI and the app's CSS would alter the document being presented as evidence.
// Rendering inside an iframe is also the pattern already used to display these snapshots
// (PublicChangeRequestStatusPage.tsx, ClientPortalChangeRequestDetailPage.tsx).
//
// Deliberately NOT sanitizeHtml()'d: that helper's allowlist has no html/head/style/body, so it
// would strip a standalone document down to unstyled fragments — it exists for the section-level
// fragments the sign pages render, which is a different job. The isolation here comes from the
// sandboxed iframe, and the content is our own generated template, re-read from our own database.
//
// READ-ONLY. Generating a PDF writes nothing to the database or to storage.

import { supabase } from '../lib/supabase';

export type SignedDocKind = 'contract' | 'proposal';

/** What the certificate block can show. Every field is optional because some of it was never
 *  recorded — see NOT_RECORDED below. */
export interface SignatureEvidence {
  signer_name?: string | null;
  signer_email?: string | null;
  signature_type?: string | null;
  signature_text?: string | null;
  signature_image_url?: string | null;
  signed_at?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  consent_text?: string | null;
  document_hash?: string | null;
}

/**
 * Printed wherever evidence is genuinely absent rather than left blank.
 *
 * This matters more than it looks. One accepted proposal in production has no row in
 * proposal_signatures at all, and no signature has ever captured an IP (both sign pages hardcode
 * null). An empty cell in a dispute document reads as "nothing to see"; a document that quietly
 * implies evidence it does not have is worse than one that admits the gap, and it is the half a
 * merchant's counterparty would attack.
 */
const NOT_RECORDED = 'Not recorded';

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fieldOrMissing(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s
    ? `<span style="color:#d1fae5;">${esc(s)}</span>`
    : `<span style="color:#94a3b8;font-style:italic;">${NOT_RECORDED}</span>`;
}

function formatSignedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/**
 * Fetch an image and inline it as a data URI.
 *
 * Canvas rendering taints on a cross-origin image and then refuses to rasterise, so the signature
 * would come out as a blank box — the one element a merchant most wants to see. Inlining sidesteps
 * CORS entirely. Returns null on any failure so a missing image degrades to NOT_RECORDED rather
 * than aborting the whole export.
 */
async function inlineImage(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Compose snapshot + certificate into one standalone document.
 *
 * Pure and exported so it can be reasoned about and tested without a browser. Mirrors
 * buildSignedProposalHTML (supabase/functions/proposal-signed-pdf/index.ts) — duplicated rather
 * than shared because that one runs in Deno on the edge and this must run in the browser, and the
 * repo has no client/edge shared-module path. Keep the two visually consistent if either changes.
 */
export function buildSignedDocumentHtml(
  frozenHtml: string,
  sig: SignatureEvidence,
  opts: { kind: SignedDocKind; signatureImageDataUri?: string | null } = { kind: 'contract' },
): string {
  const signedDate = formatSignedAt(sig.signed_at);

  // ONLY an inlined data URI, never the remote URL. A PDF must be self-contained: a remote <img>
  // cannot be relied on when the file is opened later, offline, or by a merchant. It also fails
  // today — one client's signature row points at a storage object that returns NoSuchKey, so the
  // upload silently never landed while the URL was still written to the row. Falling back to the
  // remote URL would put a broken-image box in a dispute document; falling back to the typed name
  // shows what was actually recorded.
  const imgSrc = opts.signatureImageDataUri ?? null;

  // Whether anything is actually absent decides if the closing note is shown at all. On a complete
  // document a sentence explaining what "Not recorded" means is noise, and worse, it plants the
  // idea that something is missing when nothing is.
  const anyMissing = [sig.signer_name, sig.signer_email, signedDate, sig.ip_address, sig.document_hash]
    .some((v) => !(v ?? '').toString().trim());

  const signatureMark = imgSrc
    ? `<img src="${esc(imgSrc)}" alt="Signature" style="max-height:80px;max-width:300px;" />`
    : (sig.signature_text || sig.signer_name)
      ? `<span style="font-family:Georgia,serif;font-size:32px;font-style:italic;color:#f1f5f9;">${esc(sig.signature_text || sig.signer_name)}</span>`
      : `<span style="color:#94a3b8;font-style:italic;font-size:14px;">${NOT_RECORDED}</span>`;

  const cell = (label: string, value: string) => `
        <div>
          <div style="font-size:10px;font-weight:600;letter-spacing:0.8px;color:#6ee7b7;text-transform:uppercase;margin-bottom:2px;">${label}</div>
          <div style="font-size:14px;">${value}</div>
        </div>`;

  const certificate = `
    <div style="background:#064e3b;border:2px solid #059669;border-radius:12px;padding:24px 28px;margin:20px 0;page-break-inside:avoid;">
      <div style="font-size:18px;font-weight:700;color:#34d399;letter-spacing:0.5px;margin-bottom:16px;">ELECTRONICALLY SIGNED</div>
      <div style="border-bottom:2px solid #065f46;padding-bottom:16px;margin-bottom:16px;">${signatureMark}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${cell('Signer', fieldOrMissing(sig.signer_name))}
        ${cell('Email', fieldOrMissing(sig.signer_email))}
        ${cell('Signed on', fieldOrMissing(signedDate))}
        ${cell('IP address', fieldOrMissing(sig.ip_address))}
      </div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #065f46;">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.8px;color:#6ee7b7;text-transform:uppercase;margin-bottom:4px;">Document hash (SHA-256)</div>
        <div style="font-size:11px;color:#a7f3d0;font-family:monospace;word-break:break-all;">${fieldOrMissing(sig.document_hash)}</div>
      </div>
      ${sig.user_agent ? `<div style="margin-top:12px;">
        <div style="font-size:10px;font-weight:600;letter-spacing:0.8px;color:#6ee7b7;text-transform:uppercase;margin-bottom:4px;">Signing device</div>
        <div style="font-size:11px;color:#a7f3d0;word-break:break-all;">${esc(sig.user_agent)}</div>
      </div>` : ''}
      ${sig.consent_text ? `<div style="margin-top:12px;font-size:11px;color:#6ee7b7;font-style:italic;">${esc(sig.consent_text)}</div>` : ''}
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #065f46;font-size:10px;color:#6ee7b7;">
        This ${opts.kind} is reproduced from the immutable snapshot stored when it was sent for
        signature.${anyMissing ? ` Fields marked "${NOT_RECORDED}" were not captured at signing time.` : ''}
      </div>
    </div>`;

  const page = `<div style="padding:40px 50px 60px;page-break-before:always;">${certificate}</div>`;

  // The snapshots are full documents, so the certificate belongs inside <body>. Appending after
  // </body> would put it outside the styled page and some renderers drop it entirely.
  const insertAt = frozenHtml.lastIndexOf('</body>');
  return insertAt === -1
    ? frozenHtml + page
    : frozenHtml.slice(0, insertAt) + page + frozenHtml.slice(insertAt);
}

interface LoadedDoc {
  html: string;
  sig: SignatureEvidence;
  filenameStem: string;
}

async function loadContract(id: string): Promise<LoadedDoc> {
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('id, contract_number, title, signed_at, frozen_html_snapshot, frozen_document_hash')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not load the contract: ${error.message}`);
  if (!contract) throw new Error('Contract not found.');
  if (!contract.frozen_html_snapshot) {
    throw new Error('This contract has no signed snapshot, so there is no signed copy to export.');
  }

  const { data: sigRow } = await supabase
    .from('contract_signatures')
    .select('signer_name, signer_email, signature_type, signature_text, signature_image_url, ip_address, user_agent, consent_text, document_hash, created_at')
    .eq('contract_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    html: contract.frozen_html_snapshot,
    sig: {
      ...(sigRow ?? {}),
      signed_at: contract.signed_at ?? sigRow?.created_at ?? null,
      document_hash: sigRow?.document_hash ?? contract.frozen_document_hash ?? null,
    },
    filenameStem: `signed-contract-${contract.contract_number ?? contract.id.slice(0, 8)}`,
  };
}

async function loadProposal(id: string): Promise<LoadedDoc> {
  const { data: proposal, error } = await supabase
    .from('proposals')
    .select('id, proposal_number, title, signed_at, frozen_html_snapshot, frozen_document_hash')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not load the proposal: ${error.message}`);
  if (!proposal) throw new Error('Proposal not found.');
  if (!proposal.frozen_html_snapshot) {
    throw new Error('This proposal has no signed snapshot, so there is no signed copy to export.');
  }

  // May legitimately be absent — at least one accepted proposal in production has no signature row.
  const { data: sigRow } = await supabase
    .from('proposal_signatures')
    .select('signer_name, signer_email, signature_type, signature_text, signature_image_url, ip_address, user_agent, consent_text, document_hash, created_at')
    .eq('proposal_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    html: proposal.frozen_html_snapshot,
    sig: {
      ...(sigRow ?? {}),
      signed_at: proposal.signed_at ?? sigRow?.created_at ?? null,
      document_hash: sigRow?.document_hash ?? proposal.frozen_document_hash ?? null,
    },
    filenameStem: `signed-proposal-${proposal.proposal_number ?? proposal.id.slice(0, 8)}`,
  };
}

/**
 * Print the signed document to PDF via the browser's own print engine.
 *
 * WHY NOT A ONE-CLICK RASTER DOWNLOAD. That was tried first (html2pdf/html2canvas) and the output
 * was rejected as illegible, correctly: it produced seven full-page 1632x2112 JPEGs on 612x792pt
 * pages — 192dpi, soft, JPEG artefacts over a dark background, 2.7MB, and not a single character of
 * real text. A rasterised page cannot be zoomed, selected, searched or copied, which is most of
 * what a merchant reviewing a disputed contract actually does with it.
 *
 * The print engine emits real vector text: crisp at any zoom, selectable, searchable, and roughly
 * an order of magnitude smaller. The cost is one extra interaction — the browser's print dialog,
 * where the user picks "Save as PDF". For a document that has to stand up in a payment dispute,
 * legibility beats saving a click.
 *
 * Prints an iframe rather than window.open() so there is no popup to block. The print dialog's
 * default filename comes from the printed document's <title>, so that is set to `filename`.
 */
export async function renderSignedHtmlToPdf(
  html: string,
  filename: string,
): Promise<void> {
  const iframe = document.createElement('iframe');
  // Offscreen rather than display:none — a display:none frame has no layout and Chrome will not
  // print it.
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:816px;height:1056px;border:0;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) { iframe.remove(); throw new Error('Could not open a render frame for the document.'); }

  // print-color-adjust is not optional here. The signed document is dark-themed (#0f172a); without
  // it every browser strips backgrounds when printing and the contract comes out as pale text on
  // white — a different-looking document from the one that was signed.
  const printCss = `
    <style>
      @page { size: letter; margin: 0.5in; }
      html, body {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      @media print { body { margin: 0 !important; } }
    </style>`;
  const titled = `<title>${filename}</title>${printCss}`;
  const withPrintCss = html.includes('</head>')
    ? html.replace('</head>', `${titled}</head>`)
    : titled + html;

  doc.open();
  doc.write(withPrintCss);
  doc.close();

  // Let layout settle and any images finish, or the print captures a half-painted page.
  await new Promise((r) => setTimeout(r, 200));
  await Promise.all(
    Array.from(doc.images).map((img) =>
      img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; }),
    ),
  );

  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();

  // The frame must outlive the print dialog — removing it immediately cancels the print in Chrome.
  // There is no reliable cross-browser "dialog closed" event, so this is a generous timeout rather
  // than a race against the user.
  setTimeout(() => iframe.remove(), 60_000);
}

/**
 * Build and download the signed PDF for a contract or proposal.
 *
 * Throws with a message fit to show the user. Callers should surface it rather than swallowing —
 * silently producing no file is indistinguishable from a browser that blocked the download.
 */
export async function downloadSignedPdf(kind: SignedDocKind, id: string): Promise<void> {
  const doc = kind === 'contract' ? await loadContract(id) : await loadProposal(id);
  const dataUri = await inlineImage(doc.sig.signature_image_url);
  const html = buildSignedDocumentHtml(doc.html, doc.sig, { kind, signatureImageDataUri: dataUri });
  const stamp = (doc.sig.signed_at ?? new Date().toISOString()).slice(0, 10);
  await renderSignedHtmlToPdf(html, `${doc.filenameStem}-${stamp}`);
}
