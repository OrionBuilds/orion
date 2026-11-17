/**
 * SharePoint-api behaviour for personal Microsoft accounts: they have no SharePoint sites or shared libraries, only
 * their own OneDrive (/me/drive). Work and external accounts are untouched.
 */
import { graphFetch } from "./ms-graph.ts";

export const PERSONAL_UNAVAILABLE = "Not available for personal Microsoft accounts";
type F = typeof fetch;
const NO_ENV = { get: (_k: string): string | undefined => undefined };

export class PersonalUnavailableError extends Error {
  constructor() { super(PERSONAL_UNAVAILABLE); }
}

/** Env view for drive resolution: a personal account never sees the configured SharePoint site/library. */
export const personalEnv = NO_ENV;

/** The drive a personal account may use: its own OneDrive. A different requested drive id is refused (SharePoint/library). */
export async function personalDriveId(token: string, requested: unknown, fetchImpl?: F): Promise<string> {
  const r = await graphFetch(token, "/me/drive?$select=id", {}, fetchImpl);
  if (!r.ok) throw new Error(`Could not resolve OneDrive: ${r.status}`);
  const id = (await r.json() as { id: string }).id;
  if (typeof requested === "string" && requested && requested !== id) throw new PersonalUnavailableError();
  return id;
}
