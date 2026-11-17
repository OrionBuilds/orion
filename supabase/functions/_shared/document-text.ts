/**
 * Server-side document text extraction for the AI generators (proposal / contract).
 *
 * Supported:
 *   - PDF  via npm:unpdf (pdf.js build that runs in Deno / edge runtimes)
 *   - DOCX / PPTX / XLSX  via npm:fflate (unzip) + a small OOXML text walker
 *   - text/plain, text/csv, text/markdown, text/html, application/json, RTF (crude)
 * Anything else is reported as `unsupported` rather than guessed at.
 *
 * A PDF that yields (almost) no text is reported as `no_text` — almost always a scanned image
 * PDF that needs OCR, which we deliberately do not attempt here.
 */
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";

export type ExtractionStatus = "extracted" | "no_text" | "unsupported" | "too_large" | "failed";

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  pageCount: number | null;
  extractor: string;
  error?: string;
}

/** Hard ceiling on what we keep per document (characters). Generators cap again per prompt. */
export const MAX_STORED_TEXT_CHARS = 1_000_000;
/** Below this many characters per page, a PDF is treated as scanned (no text layer). */
const MIN_CHARS_PER_PDF_PAGE = 25;

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  rtf: "application/rtf",
  htm: "text/html",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
};

/** Lower-cased extension of a filename ("" when none). */
export function fileExtension(name: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((name ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

/** MIME implied by a filename's extension, or null. */
export function mimeFromFilename(name: string | null | undefined): string | null {
  return EXT_MIME[fileExtension(name)] ?? null;
}

/**
 * Normalises a server-reported content type: strips parameters, and replaces generic
 * binary types (octet-stream, binary/octet-stream, x-download) with the extension's MIME.
 */
export function normalizeMime(contentType: string | null | undefined, filename?: string | null): string {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const generic = !base || base === "application/octet-stream" || base === "binary/octet-stream" ||
    base === "application/x-download" || base === "application/force-download";
  if (generic) return mimeFromFilename(filename) ?? "application/octet-stream";
  return base;
}

const DOCX = EXT_MIME.docx;
const PPTX = EXT_MIME.pptx;
const XLSX = EXT_MIME.xlsx;

/** Collapses whitespace runs while keeping paragraph breaks. */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \f\v\u00a0]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return tidyText(decodeXmlEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ));
}

/** WordprocessingML (word/document.xml) → text: paragraphs, tabs, breaks, table cells. */
export function wordXmlToText(xml: string): string {
  const body = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    // Only text runs (<w:t>) carry visible text; instrText (field codes) etc. are dropped.
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<(?!\/?w:t[ >])[^>]+>/g, "")
    .replace(/<\/?w:t[^>]*>/g, "");
  return tidyText(decodeXmlEntities(body));
}

/** DrawingML text (<a:t>) as used by PPTX slides; one line per paragraph. */
export function drawingXmlToText(xml: string): string {
  const out = xml
    .replace(/<\/a:p>/g, "\n")
    .replace(/<a:br\/>/g, "\n")
    .replace(/<(?!\/?a:t[ >])[^>]+>/g, "")
    .replace(/<\/?a:t[^>]*>/g, "");
  return tidyText(decodeXmlEntities(out));
}

function numericSuffix(path: string): number {
  const m = /(\d+)\.xml$/.exec(path);
  return m ? parseInt(m[1], 10) : 0;
}

/** XLSX: shared strings + inline strings + numeric cell values, one line per row. */
export function xlsxToText(files: Record<string, Uint8Array>): string {
  const shared: string[] = [];
  const ss = files["xl/sharedStrings.xml"];
  if (ss) {
    for (const si of strFromU8(ss).match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decodeXmlEntities((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
        .map((t) => t.replace(/<[^>]+>/g, "")).join("")));
    }
  }
  const sheets = Object.keys(files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));
  const lines: string[] = [];
  for (const [i, p] of sheets.entries()) {
    lines.push(`# Sheet ${i + 1}`);
    const xml = strFromU8(files[p]);
    for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const type = /\bt="([^"]+)"/.exec(c)?.[1];
        if (type === "inlineStr") {
          cells.push(decodeXmlEntities((c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
          continue;
        }
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        if (v === undefined) continue;
        cells.push(type === "s" ? (shared[parseInt(v, 10)] ?? "") : decodeXmlEntities(v));
      }
      if (cells.some((x) => x.trim())) lines.push(cells.join("\t"));
    }
  }
  return tidyText(lines.join("\n"));
}

/** Extracts text from an OOXML (zip) container. Throws when the zip is unreadable. */
export function extractOoxml(bytes: Uint8Array, mime: string): string {
  const files = unzipSync(bytes, {
    // Only inflate the parts we read: keeps memory bounded for media-heavy decks.
    filter: (f) => /^(word\/(document|footnotes|endnotes)\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml)$/.test(f.name),
  });
  if (mime === DOCX) {
    const parts = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]
      .filter((p) => files[p]).map((p) => wordXmlToText(strFromU8(files[p])));
    return tidyText(parts.join("\n\n"));
  }
  if (mime === PPTX) {
    const slides = Object.keys(files).filter((p) => p.startsWith("ppt/slides/"))
      .sort((a, b) => numericSuffix(a) - numericSuffix(b));
    return tidyText(slides.map((p, i) => `# Slide ${i + 1}\n${drawingXmlToText(strFromU8(files[p]))}`).join("\n\n"));
  }
  return xlsxToText(files);
}

/** Very small RTF → text: drops control words and groups, keeps literal text. */
export function rtfToText(rtf: string): string {
  return tidyText(
    rtf
      .replace(/\\par[d]?/g, "\n")
      .replace(/\{\\\*[^{}]*\}/g, "")
      .replace(/\\'([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
      .replace(/[{}]/g, ""),
  );
}

async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("npm:unpdf@1.4.0");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: tidyText(Array.isArray(text) ? text.join("\n\n") : text), pages: totalPages };
}

const TEXT_MIMES = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "text/tab-separated-values"]);

/** True when we know how to pull text out of this MIME type. */
export function isExtractableMime(mime: string): boolean {
  return mime === "application/pdf" || mime === DOCX || mime === PPTX || mime === XLSX ||
    TEXT_MIMES.has(mime) || mime === "text/html" || mime === "application/rtf" || mime === "text/rtf";
}

function cap(text: string): string {
  return text.length > MAX_STORED_TEXT_CHARS ? text.slice(0, MAX_STORED_TEXT_CHARS) : text;
}

/**
 * Extracts plain text. Never throws: failures come back as `{ status: "failed", error }`.
 * `mime` should already be normalised (see normalizeMime).
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  mime: string,
  filename?: string | null,
): Promise<ExtractionResult> {
  const m = normalizeMime(mime, filename);
  try {
    if (m === "application/pdf") {
      const { text, pages } = await extractPdf(bytes);
      const scanned = text.replace(/\s+/g, "").length < MIN_CHARS_PER_PDF_PAGE * Math.max(1, pages);
      return {
        status: scanned ? "no_text" : "extracted",
        text: scanned ? "" : cap(text),
        pageCount: pages,
        extractor: "unpdf",
        ...(scanned ? { error: "PDF has no text layer (likely scanned); OCR is not performed" } : {}),
      };
    }
    if (m === DOCX || m === PPTX || m === XLSX) {
      const text = extractOoxml(bytes, m);
      return { status: text ? "extracted" : "no_text", text: cap(text), pageCount: null, extractor: "ooxml" };
    }
    if (TEXT_MIMES.has(m) || m.startsWith("text/plain")) {
      const text = tidyText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
      return { status: text ? "extracted" : "no_text", text: cap(text), pageCount: null, extractor: "utf8" };
    }
    if (m === "text/html") {
      const text = htmlToText(new TextDecoder().decode(bytes));
      return { status: text ? "extracted" : "no_text", text: cap(text), pageCount: null, extractor: "html" };
    }
    if (m === "application/rtf" || m === "text/rtf") {
      const text = rtfToText(new TextDecoder("latin1").decode(bytes));
      return { status: text ? "extracted" : "no_text", text: cap(text), pageCount: null, extractor: "rtf" };
    }
    return { status: "unsupported", text: "", pageCount: null, extractor: "none", error: `No text extractor for ${m}` };
  } catch (e) {
    return { status: "failed", text: "", pageCount: null, extractor: "error", error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
}
