/**
 * Recording-consent basis for a meeting transcript. Pure and dependency-free: used by the edge
 * functions that import or transcribe, and by the browser forms (src imports it).
 */
export const CONSENT_BASES = [
  { value: "announced", label: "It was announced at the start (host or recording bot)" },
  { value: "invite_notice", label: "The invite said the meeting would be recorded" },
  { value: "verbal_each", label: "Every participant agreed aloud when asked" },
  { value: "one_party_checked", label: "A participant consented and I checked one-party consent applies" },
] as const;

export type ConsentBasis = (typeof CONSENT_BASES)[number]["value"];

export interface ConsentInput {
  basis: ConsentBasis;
  note: string | null;
}

/** Wording to copy into invites and the start of a call. */
export const CONSENT_SCRIPTS = {
  invite: "This meeting will be recorded and transcribed so we can keep accurate notes. Tell me before it starts if you would rather it was not.",
  announcement: "Before we start: this meeting is being recorded and transcribed for our notes. If anyone objects, say so now and we will stop.",
  ask: "Is everyone comfortable with me recording and transcribing this? Please say yes out loud so it is on the record.",
};

/** Validates what the caller sent. Returns null when the basis is missing or unknown: nothing is assumed. */
export function parseConsent(basis: unknown, note?: unknown): ConsentInput | null {
  if (typeof basis !== "string") return null;
  const hit = CONSENT_BASES.find((b) => b.value === basis);
  if (!hit) return null;
  const n = typeof note === "string" ? note.trim().slice(0, 500) : "";
  return { basis: hit.value, note: n || null };
}

export const CONSENT_REQUIRED_MESSAGE =
  "State how participants were told about the recording (announced, invite notice, verbal agreement, or one-party consent checked) before importing or transcribing.";
