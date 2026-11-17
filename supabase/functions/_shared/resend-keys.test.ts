import { assertEquals } from "jsr:@std/assert@1";
import {
  listResendApiKeys, listResendWebhookSecrets, resendDomainOf, resendEnvNamesFor, resolveResendApiKey,
} from "./resend.ts";

const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

Deno.test("resendDomainOf handles bare addresses, display names and bare domains", () => {
  assertEquals(resendDomainOf("info@mail.example.com"), "mail.example.com");
  assertEquals(resendDomainOf("Clara Example <clara@Mail.Example.org>"), "mail.example.org");
  assertEquals(resendDomainOf("example.com"), "example.com");
  assertEquals(resendDomainOf("not an address"), null);
  assertEquals(resendDomainOf(""), null);
  assertEquals(resendDomainOf(undefined), null);
});

Deno.test("env names walk from the exact domain to the registrable domain", () => {
  assertEquals(resendEnvNamesFor("RESEND_API_KEY", "mail.example.com"), [
    "RESEND_API_KEY__MAIL_EXAMPLE_COM",
    "RESEND_API_KEY__EXAMPLE_COM",
  ]);
  assertEquals(resendEnvNamesFor("RESEND_API_KEY", "example.org"), ["RESEND_API_KEY__EXAMPLE_ORG"]);
  assertEquals(resendEnvNamesFor("RESEND_WEBHOOK_SECRET", "a.b.example.co.uk"), [
    "RESEND_WEBHOOK_SECRET__A_B_EXAMPLE_CO_UK",
    "RESEND_WEBHOOK_SECRET__B_EXAMPLE_CO_UK",
    "RESEND_WEBHOOK_SECRET__EXAMPLE_CO_UK",
    "RESEND_WEBHOOK_SECRET__CO_UK",
  ]);
});

Deno.test("resolveResendApiKey: per-domain key wins, exact beats parent, default otherwise", () => {
  const e = env({
    RESEND_API_KEY: "re_default",
    RESEND_API_KEY__EXAMPLE_COM: "re_acme",
    RESEND_API_KEY__MAIL_EXAMPLE_ORG: "re_sr_mail",
  });
  assertEquals(resolveResendApiKey("info@mail.example.com", e), { apiKey: "re_acme", label: "RESEND_API_KEY__EXAMPLE_COM" });
  assertEquals(resolveResendApiKey("clara@mail.example.org", e), { apiKey: "re_sr_mail", label: "RESEND_API_KEY__MAIL_EXAMPLE_ORG" });
  assertEquals(resolveResendApiKey("hello@example.org", e), { apiKey: "re_default", label: "RESEND_API_KEY" });
  assertEquals(resolveResendApiKey("someone@other.io", e), { apiKey: "re_default", label: "RESEND_API_KEY" });
  assertEquals(resolveResendApiKey(null, e), { apiKey: "re_default", label: "RESEND_API_KEY" });
  assertEquals(resolveResendApiKey("x@y.com", env({})), null);
  assertEquals(resolveResendApiKey("x@example.com", env({ RESEND_API_KEY__EXAMPLE_COM: "  re_only " })), { apiKey: "re_only", label: "RESEND_API_KEY__EXAMPLE_COM" });
});

Deno.test("listResendApiKeys and listResendWebhookSecrets collect default + per-domain, deduplicated", () => {
  const vars = {
    RESEND_API_KEY: "re_default",
    RESEND_API_KEY__ZZZ_COM: "re_default",
    RESEND_API_KEY__EXAMPLE_COM: "re_acme",
    RESEND_WEBHOOK_SECRET: "whsec_1",
    RESEND_WEBHOOK_SECRET__EXAMPLE_COM: "whsec_2",
    OTHER: "x",
  };
  assertEquals(listResendApiKeys(vars), [
    { apiKey: "re_default", label: "RESEND_API_KEY" },
    { apiKey: "re_acme", label: "RESEND_API_KEY__EXAMPLE_COM" },
  ]);
  assertEquals(listResendWebhookSecrets(vars), ["whsec_1", "whsec_2"]);
  assertEquals(listResendApiKeys({}), []);
});
