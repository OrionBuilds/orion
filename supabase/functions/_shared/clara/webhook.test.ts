import { assertEquals } from "jsr:@std/assert@1";
import { functionsBase, parseForm, publicUrl, readSignedForm } from "./webhook.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });

async function sign(url: string, params: Record<string, string>, token: string) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
}

const E = env({ SUPABASE_URL: "https://ref.supabase.co", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });

Deno.test("public url ignores the runtime's host and keeps the query Twilio signed", () => {
  const req = new Request("http://internal:9999/clara-voice?rec=start&a=1");
  assertEquals(publicUrl(req, "clara-voice", E), "https://ref.supabase.co/functions/v1/clara-voice?rec=start&a=1");
  assertEquals(functionsBase(env({ CLARA_WEBHOOK_BASE: "https://hooks.example.com/" })), "https://hooks.example.com");
});

Deno.test("signed requests pass; unsigned, forged, wrong-url and unconfigured all fail closed", async () => {
  const body = "CallSid=CA1&From=%2B15551230000&SpeechResult=hello+there";
  const params = parseForm(body);
  assertEquals(params.SpeechResult, "hello there");
  const url = "https://ref.supabase.co/functions/v1/clara-voice?rec=start";
  const good = await sign(url, params, "tok");
  const mk = (sig?: string) => new Request("http://internal/clara-voice?rec=start", { method: "POST", body, headers: sig ? { "X-Twilio-Signature": sig } : {} });
  assertEquals((await readSignedForm(mk(good), "clara-voice", E))?.CallSid, "CA1");
  assertEquals(await readSignedForm(mk(), "clara-voice", E), null);
  assertEquals(await readSignedForm(mk("AAAA"), "clara-voice", E), null);
  assertEquals(await readSignedForm(mk(await sign(url, params, "other-token")), "clara-voice", E), null);
  assertEquals(await readSignedForm(mk(await sign("https://evil.example/clara-voice?rec=start", params, "tok")), "clara-voice", E), null);
  assertEquals(await readSignedForm(mk(good), "clara-voice", env({ SUPABASE_URL: "https://ref.supabase.co" })), null); // no creds
});
