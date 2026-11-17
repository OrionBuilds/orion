import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  CLIENT_REVIEW_STATUSES, canTransition, clientDecisionStatus, decideNotify, escapeHtml, parseClientDecision,
  portalUrl, reviewNoticeEmail,
} from "./client-reviews.ts";

Deno.test("client review status machine: every pair matches the SQL rule", () => {
  const allowed = new Set([
    "pending>accepted", "pending>changes_requested", "pending>closed", "pending>superseded",
    "accepted>closed", "accepted>superseded", "changes_requested>closed", "changes_requested>superseded",
  ]);
  for (const from of CLIENT_REVIEW_STATUSES) {
    for (const to of CLIENT_REVIEW_STATUSES) {
      const want = from === to || allowed.has(`${from}>${to}`);
      assertEquals(canTransition(from, to), want, `${from} -> ${to}`);
    }
  }
});

Deno.test("terminal states never reopen and unknown states are refused", () => {
  assertEquals(canTransition("closed", "pending"), false);
  assertEquals(canTransition("superseded", "accepted"), false);
  assertEquals(canTransition("accepted", "changes_requested"), false);
  assertEquals(canTransition("changes_requested", "accepted"), false);
  assertEquals(canTransition("pending", "approved"), false);
  assertEquals(canTransition("bogus", "bogus"), false);
});

Deno.test("client decisions map to statuses", () => {
  assertEquals(clientDecisionStatus("approve"), "accepted");
  assertEquals(clientDecisionStatus("request_changes"), "changes_requested");
  assertEquals(parseClientDecision("approve"), "approve");
  assertEquals(parseClientDecision("reject"), null);
});

Deno.test("portal url strips trailing slashes and falls back to a relative path", () => {
  assertEquals(portalUrl("https://os.example.com///", "p1"), "https://os.example.com/client-portal/projects/p1");
  assertEquals(portalUrl(undefined, "p1"), "/client-portal/projects/p1");
  assertEquals(portalUrl("", "a/b"), "/client-portal/projects/a%2Fb");
});

Deno.test("notice email escapes every client-facing value and links the portal", () => {
  const m = reviewNoticeEmail({
    clientName: "Pat <script>", orgName: "Acme & Co", projectName: "Site", title: "New \"home\" page",
    summary: "Line 1\n<b>Line 2</b>", portalUrl: "https://os.example.com/client-portal/projects/p1",
  });
  assertEquals(m.subject, "Ready for your review: New \"home\" page");
  assert(!m.html.includes("<script>"));
  assert(!m.html.includes("<b>Line 2</b>"));
  assertStringIncludes(m.html, "Acme &amp; Co");
  assertStringIncludes(m.html, "&lt;b&gt;Line 2&lt;/b&gt;");
  assertStringIncludes(m.html, 'href="https://os.example.com/client-portal/projects/p1"');
  assertStringIncludes(m.text, "https://os.example.com/client-portal/projects/p1");
  assertStringIncludes(m.text, "— Acme & Co");
  assertEquals(escapeHtml(`'"`), "&#39;&quot;");
});

Deno.test("notice email without a client name or summary still reads well", () => {
  const m = reviewNoticeEmail({ orgName: "Org", title: "T", portalUrl: "https://x/y" });
  assert(m.text.startsWith("Hi,\n"));
  assert(!m.text.includes("undefined"));
});

Deno.test("decideNotify: only sends when asked, configured, allowed, first time, with an email", () => {
  const base = { send: true, appBase: "https://os.example.com", commsEnabled: true, alreadyNotified: false, email: "pat@client.com" };
  assertEquals(decideNotify(base), { send: true });
  assertEquals(decideNotify({ ...base, send: false }), { send: false, reason: "not_requested" });
  assertEquals(decideNotify({ ...base, appBase: "" }), { send: false, reason: "no_app_base_url" });
  assertEquals(decideNotify({ ...base, commsEnabled: false }), { send: false, reason: "client_comms_off" });
  assertEquals(decideNotify({ ...base, alreadyNotified: true }), { send: false, reason: "already_notified" });
  assertEquals(decideNotify({ ...base, email: null }), { send: false, reason: "no_client_email" });
  assertEquals(decideNotify({ ...base, email: "not-an-email" }), { send: false, reason: "no_client_email" });
});
