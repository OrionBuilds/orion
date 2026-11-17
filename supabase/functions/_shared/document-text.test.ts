import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import {
  decodeXmlEntities,
  extractDocumentText,
  fileExtension,
  htmlToText,
  isExtractableMime,
  normalizeMime,
  rtfToText,
  wordXmlToText,
} from "./document-text.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Minimal single-page PDF with one line of text (valid xref offsets computed on the fly). */
export function makePdf(lines: string[]): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td 14 TL " +
    lines.map((l) => `(${l.replace(/[()\\]/g, (c) => "\\" + c)}) '`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

Deno.test("normalizeMime falls back to the extension for generic binary types", () => {
  assertEquals(normalizeMime("application/octet-stream", "RFP_Amendment.PDF"), "application/pdf");
  assertEquals(normalizeMime("binary/octet-stream", "sow.docx"), DOCX);
  assertEquals(normalizeMime("application/pdf; charset=binary", "x"), "application/pdf");
  assertEquals(normalizeMime(null, "noext"), "application/octet-stream");
  assertEquals(fileExtension("a.b.XLSX"), "xlsx");
  assert(isExtractableMime(DOCX));
  assert(!isExtractableMime("image/png"));
});

Deno.test("entity + html helpers", () => {
  assertEquals(decodeXmlEntities("A &amp; B &#x2014; &#169; &lt;x&gt;"), "A & B — © <x>");
  assertEquals(htmlToText("<p>Hello<br/>World</p><script>x()</script><div>Next</div>"), "Hello\nWorld\nNext");
  assertStringIncludes(rtfToText("{\\rtf1\\ansi {\\fonttbl\\f0 Arial;}\\f0 Scope of work\\par Line two}"), "Scope of work\nLine two");
});

Deno.test("wordXmlToText keeps paragraphs, tabs and table cells, drops field codes", () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>Section C</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">Statement of Work</w:t></w:r></w:p>` +
    `<w:p><w:r><w:instrText>PAGE</w:instrText><w:t>Para &amp; two</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CLIN</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0001</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const t = wordXmlToText(xml);
  assertStringIncludes(t, "Section C\tStatement of Work");
  assertStringIncludes(t, "Para & two");
  assert(!t.includes("PAGE"));
  assertStringIncludes(t, "CLIN");
  assertStringIncludes(t, "0001");
});

Deno.test("extracts DOCX, PPTX and XLSX text", async () => {
  const docx = zipSync({
    "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>Performance Work Statement</w:t></w:r></w:p></w:body></w:document>`),
    "word/media/image1.png": new Uint8Array(10),
  });
  const d = await extractDocumentText(docx, DOCX, "pws.docx");
  assertEquals(d.status, "extracted");
  assertEquals(d.text, "Performance Work Statement");

  const pptx = zipSync({
    "ppt/slides/slide2.xml": strToU8(`<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`),
    "ppt/slides/slide1.xml": strToU8(`<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>`),
  });
  const p = await extractDocumentText(pptx, PPTX, "deck.pptx");
  assertEquals(p.status, "extracted");
  assert(p.text.indexOf("First") < p.text.indexOf("Second"));

  const xlsx = zipSync({
    "xl/sharedStrings.xml": strToU8(`<sst><si><t>Item</t></si><si><t>Price</t></si><si><t>Widget</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row></sheetData></worksheet>`),
  });
  const x = await extractDocumentText(xlsx, "application/octet-stream", "pricing.xlsx");
  assertEquals(x.status, "extracted");
  assertStringIncludes(x.text, "Item\tPrice");
  assertStringIncludes(x.text, "Widget\t12.5");
});

Deno.test("extracts text from a PDF with a text layer", async () => {
  const pdf = makePdf(["Request for Proposal W912-26-R-0001", "Section L: Instructions to Offerors and evaluation factors"]);
  const r = await extractDocumentText(pdf, "application/pdf", "rfp.pdf");
  assertEquals(r.status, "extracted", r.error);
  assertEquals(r.pageCount, 1);
  assertStringIncludes(r.text, "W912-26-R-0001");
  assertStringIncludes(r.text, "Instructions to Offerors");
});

Deno.test("flags a PDF with no text layer as no_text (scanned)", async () => {
  const r = await extractDocumentText(makePdf([]), "application/pdf", "scan.pdf");
  assertEquals(r.status, "no_text");
  assertEquals(r.text, "");
});

Deno.test("plain text, unsupported and corrupt inputs never throw", async () => {
  const t = await extractDocumentText(new TextEncoder().encode("line 1\r\n\r\n\r\nline 2"), "text/plain", "a.txt");
  assertEquals(t.text, "line 1\n\nline 2");
  const u = await extractDocumentText(new Uint8Array([1, 2, 3]), "image/png", "a.png");
  assertEquals(u.status, "unsupported");
  const f = await extractDocumentText(new Uint8Array([1, 2, 3]), DOCX, "broken.docx");
  assertEquals(f.status, "failed");
  const bad = await extractDocumentText(new Uint8Array([1, 2, 3]), "application/pdf", "broken.pdf");
  assertEquals(bad.status, "failed");
});
