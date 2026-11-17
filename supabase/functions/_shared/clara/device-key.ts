/**
 * Clara device keys (the always-listening desk daemon, the Android app). CLARA_VOICE_DEVICE_KEY holds one key
 * per device, comma-separated, so one lost phone is revoked alone. Unset secret = every device refused.
 */
function sameKey(given: string, want: string): boolean {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(want);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function deviceKeyOk(given: string | null, want: string | undefined): boolean {
  if (!given || !want) return false;
  return want.split(",").map((k) => k.trim()).filter(Boolean).some((k) => sameKey(given, k));
}
