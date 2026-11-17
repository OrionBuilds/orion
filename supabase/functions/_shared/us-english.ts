/**
 * US spelling for everything the OS's models write (2026-11-13: a client flagged British spellings in
 * generated text). Applied to every Anthropic Messages / OpenAI chat request that goes through
 * meteredFetch(), which is how the OS reaches a model, so Clara's client emails, SMS and web chat,
 * proposals, contracts, reports and portal text all get it without each call site remembering.
 */
export const US_SPELLING_RULE =
  "Write in American English with US spelling (color, behavior, organize, recognize, analyze, center, " +
  "practice as a verb, judgment, labeled, canceled, favor, gray). Leave quotes, names, code identifiers " +
  "and text you are not rewriting exactly as they are.";

type Provider = "anthropic" | "openai";

/** The request with the rule added once to its system prompt; anything it can't read is left as is. */
export function withUsSpelling(provider: Provider, init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string" || init.body.includes(US_SPELLING_RULE)) return init;
  let body: Record<string, unknown>;
  try { body = JSON.parse(init.body); } catch { return init; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return init;
  if (provider === "anthropic") {
    const s = body.system;
    if (Array.isArray(s)) body.system = [...s, { type: "text", text: US_SPELLING_RULE }];
    else body.system = typeof s === "string" && s ? `${s}\n\n${US_SPELLING_RULE}` : US_SPELLING_RULE;
  } else if (Array.isArray(body.messages)) {
    body.messages = [{ role: "system", content: US_SPELLING_RULE }, ...body.messages];
  } else if (typeof body.instructions === "string" || body.input !== undefined) {
    body.instructions = typeof body.instructions === "string" && body.instructions ? `${body.instructions}\n\n${US_SPELLING_RULE}` : US_SPELLING_RULE;
  } else {
    return init;
  }
  return { ...init, body: JSON.stringify(body) };
}
