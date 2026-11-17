/**
 * Shared email body formatting helpers.
 *
 * Outbound email pipelines (workflow-processor's send_email action,
 * workflow-action-test's per-action Send Test, dispatchOrgEmail via
 * SendGrid, sendEmailFromUser via Gmail) all deliver email as
 * `Content-Type: text/html`. Legacy templates (`config.body` on the
 * pre-unification send_email action, plus operator-typed plain text
 * in the new SendEmailConfig "Raw email" mode) store body as plain
 * text with `\n` newlines. Without conversion, receiving clients
 * collapse those newlines and render the message as a wall of text.
 *
 * normalizeEmailBodyToHtml() auto-detects:
 *   - body already contains HTML element tags → pass through unchanged
 *   - else → HTML-escape special chars, split on blank lines into <p>
 *     blocks, and convert remaining single newlines to <br>
 */

const HTML_TAG_RE = /<\s*(?:p|br|div|span|a|img|h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|strong|em|b|i|u|hr|pre|code|blockquote|figure|figcaption|section|article|header|footer|nav|main|aside)[\s>/]/i;

export function normalizeEmailBodyToHtml(body: string): string {
  if (!body) return body;
  if (HTML_TAG_RE.test(body)) return body;

  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const paragraphs = escaped
    .split(/\n{2,}/)
    .filter(p => p.length > 0)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`);

  return paragraphs.join("");
}
