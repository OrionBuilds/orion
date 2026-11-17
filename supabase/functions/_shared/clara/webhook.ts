/**
 * Shared plumbing for Clara's Twilio webhook functions: signature verification (fail closed),
 * form parsing, the PUBLIC url Twilio signed, TwiML responses, and the service-role client.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { verifyTwilioWebhookSignature } from "../twilio.ts";
import type { Env } from "./phones.ts";
import type { TwilioAuth } from "./twilio-rest.ts";

export const denoEnv: Env = { get: (k) => Deno.env.get(k) };

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function twilioAuth(env: Env = denoEnv): TwilioAuth | null {
  const accountSid = env.get("TWILIO_ACCOUNT_SID")?.trim();
  const authToken = env.get("TWILIO_AUTH_TOKEN")?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

/** https://<ref>.supabase.co/functions/v1 (or CLARA_WEBHOOK_BASE if a custom domain fronts it). */
export function functionsBase(env: Env = denoEnv): string {
  return (env.get("CLARA_WEBHOOK_BASE")?.trim() || `${env.get("SUPABASE_URL")}/functions/v1`).replace(/\/+$/, "");
}

/** The URL Twilio actually requested (and signed), rebuilt from config because the runtime may see an internal host. */
export function publicUrl(req: Request, fn: string, env: Env = denoEnv): string {
  return `${functionsBase(env)}/${fn}${new URL(req.url).search}`;
}

export function parseForm(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

/** Reads + verifies a Twilio POST. Null (=> respond 403) when unsigned, forged, or unconfigured. */
export async function readSignedForm(req: Request, fn: string, env: Env = denoEnv): Promise<Record<string, string> | null> {
  const params = parseForm(await req.text());
  const auth = twilioAuth(env);
  const signature = req.headers.get("X-Twilio-Signature") ?? "";
  if (!auth || !signature) return null;
  return (await verifyTwilioWebhookSignature(publicUrl(req, fn, env), params, signature, auth.authToken)) ? params : null;
}

export const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });

export const twiml = (inner: string, status = 200) =>
  xml(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, status);

export const FORBIDDEN = () => new Response("invalid Twilio signature", { status: 403 });

/** Run `p` after the response is sent (EdgeRuntime.waitUntil), or inline where that isn't available. */
export function background(p: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const safe = p.catch((e) => console.error("[clara background]", e));
  if (rt?.waitUntil) rt.waitUntil(safe);
}

/** Delay then run, kept alive past the response. */
export function scheduleLater(fn: () => Promise<void>, ms: number): void {
  background(new Promise<void>((r) => setTimeout(r, ms)).then(fn));
}
