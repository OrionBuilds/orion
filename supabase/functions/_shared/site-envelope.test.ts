import { assert, assertEquals } from "jsr:@std/assert@1";
import { envelopeToLead, parseEnvelope } from "./site-envelope.ts";

const good = () => ({
  id: "6f0d3bb5-77b3-4b3d-9f2d-3ac95778a3f0",
  kind: "contact",
  formName: "contact",
  schemaVersion: 1,
  receivedAt: "2026-10-30T12:00:00.000Z",
  source: { path: "/contact", userAgent: "UA", referer: "https://google.com" },
  contact: { name: "Jane  Q Doe", email: "Jane@Example.com", company: "Acme", role: "Founder" },
  consent: { accepted: true, version: "2026-10-29", acceptedAt: "2026-10-30T12:00:00.000Z" },
  answers: [
    { questionId: "help_type", label: "What do you need help with?", type: "single", value: "cmo", display: "Fractional CMO" },
    { questionId: "problem", label: "The problem", type: "text", value: "Leads dry up", display: "Leads dry up" },
    { questionId: "systems", label: "Systems", type: "multi", value: ["crm", "ads"], display: "" },
    { questionId: "bad", label: "x", type: "text", value: { nested: true } },
  ],
  spam: { honeypotEmpty: true, elapsedMs: 42000 },
});

Deno.test("parseEnvelope accepts the sender's shape and normalizes", () => {
  const r = parseEnvelope(good());
  assert(r.ok);
  assertEquals(r.value.contact.email, "jane@example.com");
  assertEquals(r.value.answers.length, 3); // object value dropped
  assertEquals(r.value.answers[2].display, "crm, ads"); // display derived when missing
});

Deno.test("parseEnvelope rejects bad ids, kinds, form names and emails", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...good(), id: "nope" }, "id must be a UUID"],
    [{ ...good(), kind: "lead" }, "kind must be assessment or contact"],
    [{ ...good(), formName: "newsletter" }, "unknown formName: newsletter"],
    [{ ...good(), contact: { name: "J", email: "bad" } }, "contact.email invalid"],
    [{ ...good(), contact: { name: "", email: "a@b.co" } }, "contact.name required"],
  ];
  for (const [input, error] of cases) {
    const r = parseEnvelope(input);
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.error, error);
  }
  assertEquals(parseEnvelope("string").ok, false);
});

Deno.test("envelopeToLead maps contact fields, slug and a readable description", () => {
  const r = parseEnvelope(good());
  assert(r.ok);
  const lead = envelopeToLead(r.value);
  assertEquals(lead.slug, "sr-contact");
  assertEquals(lead.firstName, "Jane");
  assertEquals(lead.lastName, "Q Doe");
  assertEquals(lead.jobTitle, "Founder");
  assertEquals(lead.company, "Acme");
  assertEquals(lead.opportunityName, "Jane  Q Doe — Contact form");
  assertEquals(lead.fields, [["What do you need help with?", "Fractional CMO"], ["The problem", "Leads dry up"], ["Systems", "crm, ads"]]);
  assert(lead.description.startsWith("Contact form — example.com (/contact)\nName: Jane  Q Doe\nEmail: jane@example.com\nCompany: Acme\nRole: Founder\n\nWhat do you need help with?: Fractional CMO"));
  assertEquals(lead.attribution.landing_page, "/contact");
  assertEquals(lead.attribution.site, "example.com");
});

Deno.test("assessment form names map to their prefixed slugs", () => {
  const r = parseEnvelope({ ...good(), kind: "assessment", formName: "assessment-ai-readiness" });
  assert(r.ok);
  assertEquals(envelopeToLead(r.value).slug, "sr-assessment-ai-readiness");
  assertEquals(envelopeToLead(r.value).formLabel, "AI Readiness Assessment");
});
