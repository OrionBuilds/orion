import { assert, assertStringIncludes } from "jsr:@std/assert";
import { buildGovCompanySection, buildGovSystemPrompt } from "./gov-proposal-templates.ts";

Deno.test("org profile + past performance are used verbatim when configured", () => {
  const out = buildGovCompanySection({ name: "Acme" }, { companyProfile: "PROFILE X", pastPerformance: "PAST Y" });
  assertStringIncludes(out, "PROFILE X");
  assertStringIncludes(out, "PAST Y");
});

Deno.test("without a profile, the prompt names the org and forbids invented past performance", () => {
  const prompt = buildGovSystemPrompt("RFP", { name: "Acme Corp", website: "acme.test", email: "" });
  assertStringIncludes(prompt, "Acme Corp");
  assertStringIncludes(prompt, "acme.test");
  assertStringIncludes(prompt, "Never invent contracts");
  assert(!prompt.includes("Acme Holdings"), "no hardcoded company may leak into other orgs' prompts");
});
