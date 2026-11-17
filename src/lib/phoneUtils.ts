/**
 * Vendor-agnostic phone number helpers used by the conversations UI and
 * any caller that needs E.164 normalization or SMS-segment counting.
 *
 * (Previously lived in src/services/channels/twilio.ts.)
 */

export function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (!phone.startsWith('+')) return `+${digits}`;
  return phone;
}

export function formatPhoneForDisplay(phone: string): string {
  const normalized = normalizePhoneNumber(phone);
  const digits = normalized.replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('1')) {
    const areaCode = digits.slice(1, 4);
    const exchange = digits.slice(4, 7);
    const number = digits.slice(7);
    return `(${areaCode}) ${exchange}-${number}`;
  }

  return phone;
}

/**
 * De-duplicate a contact's candidate phone numbers (primary phone plus any
 * phone-type custom fields), keeping the first spelling of each number and
 * dropping blanks / values too short to be a phone number.
 */
export function collectPhoneNumbers(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const phone = raw?.trim();
    if (!phone) continue;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) continue;
    const key = normalizePhoneNumber(phone);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phone);
  }
  return out;
}

/**
 * Count SMS segments for a given message body using the standard GSM-7 /
 * UCS-2 thresholds Twilio bills against.
 */
export function calculateSMSSegments(body: string): { segments: number; encoding: string } {
  const gsmRegex = /^[\x00-\x7F£¥èéùìòÇØøÅåΔΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà]*$/;
  const isGSM = gsmRegex.test(body);

  if (isGSM) {
    if (body.length <= 160) return { segments: 1, encoding: 'GSM-7' };
    return { segments: Math.ceil(body.length / 153), encoding: 'GSM-7' };
  } else {
    if (body.length <= 70) return { segments: 1, encoding: 'UCS-2' };
    return { segments: Math.ceil(body.length / 67), encoding: 'UCS-2' };
  }
}
