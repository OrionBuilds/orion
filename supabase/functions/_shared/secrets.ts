/**
 * Third-party secrets at rest (integration tokens, API keys).
 *
 * sealSecret encrypts with crypto.ts (AES-GCM, "<24 hex iv>:<hex ciphertext>"); openSecret reverses
 * it. Values written before 2026-10-29 were stored as plain text, so openSecret passes anything that
 * isn't in the sealed format straight through, and sealSecret leaves an already-sealed value alone
 * (safe to run twice). The strict pattern matters: crypto.ts's isEncryptedToken only checks for a
 * colon, which plain JSON credentials and some keys also contain.
 */
import { decryptToken, encryptToken } from "./crypto.ts";

const SEALED = /^[0-9a-f]{24}:[0-9a-f]+$/;

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && SEALED.test(value);
}

export async function sealSecret(value: string | null | undefined): Promise<string | null> {
  if (value === null || value === undefined || value === "") return null;
  return isSealed(value) ? value : await encryptToken(value);
}

export async function openSecret(value: string | null | undefined): Promise<string | null> {
  if (value === null || value === undefined || value === "") return null;
  return isSealed(value) ? await decryptToken(value) : value;
}
