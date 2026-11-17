/**
 * Shared Twilio helper.
 *
 * Used by every Twilio edge function (twilio-sms-send, twilio-numbers,
 * the inbound/status/voice webhooks, etc.) and by workflow-processor to
 * dispatch outbound SMS / MMS through the Twilio Messages API. Credentials
 * are platform-wide env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_FROM_NUMBER, and TWILIO_MESSAGING_SERVICE_SID.
 *
 * Twilio API reference: https://www.twilio.com/docs/sms/api/message-resource
 */

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface SendTwilioSmsOptions {
  accountSid: string;
  authToken: string;
  to: string;
  body: string;
  /** E.164 sender number. Ignored if `messagingServiceSid` is provided. */
  from?: string;
  /** Twilio Messaging Service SID — takes precedence over `from`. */
  messagingServiceSid?: string;
  /** Public URLs for MMS attachments. */
  mediaUrls?: string[];
  /** Optional status-webhook URL Twilio will POST delivery events to. */
  statusCallback?: string;
}

export interface SendTwilioSmsResult {
  ok: boolean;
  status: number;
  /** Twilio Message SID (e.g. "SMxxx" / "MMxxx") — present on 2xx. */
  sid?: string;
  /** Twilio-provided status string (e.g. "queued", "sending", "failed"). */
  providerStatus?: string;
  error?: string;
  errorCode?: number;
}

/**
 * Send a single outbound SMS or MMS via Twilio. The caller is responsible for
 * any TCPA / consent gating before invoking this helper.
 */
export async function sendTwilioSms(
  opts: SendTwilioSmsOptions,
): Promise<SendTwilioSmsResult> {
  if (!opts.accountSid || !opts.authToken) {
    return { ok: false, status: 400, error: "Missing Twilio credentials" };
  }
  if (!opts.to) {
    return { ok: false, status: 400, error: "Missing 'to' number" };
  }
  if (!opts.body && (!opts.mediaUrls || opts.mediaUrls.length === 0)) {
    return { ok: false, status: 400, error: "Body or mediaUrls required" };
  }
  if (!opts.messagingServiceSid && !opts.from) {
    return { ok: false, status: 400, error: "from or messagingServiceSid required" };
  }

  const params = new URLSearchParams();
  params.append("To", opts.to);
  if (opts.body) params.append("Body", opts.body);
  if (opts.messagingServiceSid) {
    params.append("MessagingServiceSid", opts.messagingServiceSid);
  } else if (opts.from) {
    params.append("From", opts.from);
  }
  for (const url of opts.mediaUrls ?? []) {
    if (url) params.append("MediaUrl", url);
  }
  if (opts.statusCallback) params.append("StatusCallback", opts.statusCallback);

  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`;
  const basicAuth = "Basic " + btoa(`${opts.accountSid}:${opts.authToken}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Twilio request failed";
    return { ok: false, status: 0, error: message };
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = await response.json();
  } catch {
    // ignore — Twilio always returns JSON, but be defensive
  }

  if (!response.ok) {
    const errorMessage =
      (data && typeof data.message === "string" && data.message) ||
      `Twilio API error ${response.status}`;
    const errorCode =
      data && typeof data.code === "number" ? (data.code as number) : undefined;
    return {
      ok: false,
      status: response.status,
      error: errorMessage,
      errorCode,
    };
  }

  const sid = data && typeof data.sid === "string" ? (data.sid as string) : undefined;
  const providerStatus =
    data && typeof data.status === "string" ? (data.status as string) : undefined;

  return { ok: true, status: response.status, sid, providerStatus };
}

/**
 * Read Twilio credentials from platform-wide env vars. Returns null if the
 * required keys are missing — callers should record a failed-status message
 * row rather than throwing.
 */
export function getTwilioEnvCreds(): {
  accountSid: string;
  authToken: string;
  defaultFromNumber: string | null;
  messagingServiceSid: string | null;
} | null {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!accountSid || !authToken) return null;
  return {
    accountSid,
    authToken,
    defaultFromNumber: Deno.env.get("TWILIO_FROM_NUMBER") ?? null,
    messagingServiceSid: Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") ?? null,
  };
}

function twilioBasicAuth(accountSid: string, authToken: string): string {
  return "Basic " + btoa(`${accountSid}:${authToken}`);
}

export interface TwilioAccount {
  sid: string;
  friendly_name: string;
  status: string;
  type: string;
}

/**
 * GET /Accounts/{Sid}.json — used by the "Test connection" button to verify
 * credentials and surface the Twilio account's friendly name.
 */
export async function getTwilioAccount(
  accountSid: string,
  authToken: string,
): Promise<{ ok: boolean; status: number; account?: TwilioAccount; error?: string }> {
  try {
    const response = await fetch(
      `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}.json`,
      { headers: { Authorization: twilioBasicAuth(accountSid, authToken) } },
    );
    if (!response.ok) {
      let err = `Twilio API error ${response.status}`;
      try {
        const data = await response.json();
        if (data?.message) err = data.message;
      } catch {
        // ignore
      }
      return { ok: false, status: response.status, error: err };
    }
    const data = await response.json();
    return {
      ok: true,
      status: response.status,
      account: {
        sid: data.sid,
        friendly_name: data.friendly_name,
        status: data.status,
        type: data.type,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Twilio request failed";
    return { ok: false, status: 0, error: message };
  }
}

export interface TwilioIncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: { sms?: boolean; mms?: boolean; voice?: boolean; fax?: boolean };
  status: string;
  origin: string;
  /**
   * Where Twilio actually sends inbound traffic. Carried so `twilio_numbers.webhook_configured`
   * can be DERIVED rather than hand-set — it used to be a manually-maintained flag with no source
   * of truth behind it, and it drifted: +1 813-555-0100 read `webhook_configured = false` in the
   * OS while both URLs were live and answering calls. Empty string when Twilio returns null.
   */
  voice_url: string;
  sms_url: string;
}

/**
 * Paginated GET /Accounts/{Sid}/IncomingPhoneNumbers.json — used by the
 * "Sync from Twilio" button to populate twilio_numbers.
 */
export async function listTwilioNumbers(
  accountSid: string,
  authToken: string,
): Promise<{ ok: boolean; status: number; numbers: TwilioIncomingNumber[]; error?: string }> {
  const numbers: TwilioIncomingNumber[] = [];
  let nextUrl: string | null = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json?PageSize=100`;
  let lastStatus = 0;

  while (nextUrl) {
    try {
      const response: Response = await fetch(nextUrl, {
        headers: { Authorization: twilioBasicAuth(accountSid, authToken) },
      });
      lastStatus = response.status;
      if (!response.ok) {
        let err = `Twilio API error ${response.status}`;
        try {
          const data = await response.json();
          if (data?.message) err = data.message;
        } catch {
          // ignore
        }
        return { ok: false, status: response.status, numbers, error: err };
      }
      const data = await response.json();
      for (const n of data.incoming_phone_numbers ?? []) {
        numbers.push({
          sid: n.sid,
          phone_number: n.phone_number,
          friendly_name: n.friendly_name ?? "",
          capabilities: n.capabilities ?? {},
          status: n.status ?? "in-use",
          origin: n.origin ?? "twilio",
          voice_url: n.voice_url ?? "",
          sms_url: n.sms_url ?? "",
        });
      }
      const next: string | null =
        typeof data.next_page_uri === "string" && data.next_page_uri
          ? `https://api.twilio.com${data.next_page_uri}`
          : null;
      nextUrl = next;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Twilio request failed";
      return { ok: false, status: lastStatus, numbers, error: message };
    }
  }

  return { ok: true, status: lastStatus || 200, numbers };
}

/**
 * Verify a Twilio webhook signature. Twilio signs each webhook request with
 * HMAC-SHA1 over `url + concat(sorted(params))` keyed with the auth token.
 * Caller passes the full request URL (including query string) and the parsed
 * form-urlencoded body params.
 *
 * Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export async function verifyTwilioWebhookSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): Promise<boolean> {
  try {
    const sortedKeys = Object.keys(params).sort();
    const data = url + sortedKeys.map((k) => k + params[k]).join("");
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(authToken),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return constantTimeEqual(computed, signature);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
