/**
 * Try API keys in order. The platform key (ANTHROPIC_API_KEY, what every other AI function uses) goes first,
 * then any key saved in Settings. A rejected key (HTTP 401/403) moves on to the next one; any other failure is
 * real and is thrown immediately. Added after dashboard-insights tried only a stale saved key and failed on
 * every call for two weeks (`HTTP 401: invalid x-api-key`) while the platform key worked.
 */
export async function callWithKeyFallback<T>(
  keys: (string | null | undefined)[],
  call: (key: string) => Promise<T>,
): Promise<T> {
  const unique = [...new Set(keys.map((k) => (k ?? "").trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("No API key available");
  let last: Error | null = null;
  for (const k of unique) {
    try {
      return await call(k);
    } catch (e) {
      last = e as Error;
      if (!/\b(401|403)\b/.test(last.message)) throw last;
      console.warn("[key-fallback] a key was rejected; trying the next one");
    }
  }
  throw last!;
}
