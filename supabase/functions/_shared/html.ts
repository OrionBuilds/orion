// Minimal HTML escaping for the few edge functions that return an HTML body.
//
// OAuth callbacks render a "something went wrong" page that interpolates the provider's `error`
// query parameter. That value is attacker-controlled - anyone can send a victim to
// .../callback?error=<script>... - so interpolating it raw is reflected XSS on the project's
// own origin.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a string for safe interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
