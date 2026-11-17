// Brute-force protection for the MCP auth tools (auth_sign_in / auth_sign_up).
//
// Replaces the limiter proposed in PR #25 (closed), which keyed every caller to 'unknown' — one
// global bucket that anyone could exhaust to lock out every sign-in, and that any successful login
// reset. Here:
//   - buckets are per client IP, plus per IP+email for sign-in;
//   - sign-in counts only attempts whose credentials Supabase REJECTED, and a success clears only
//     that IP+email bucket — never the IP bucket, so logging into your own account cannot reset a
//     password-spraying counter;
//   - sign-up counts every attempt per IP (mass account creation succeeds, so failures alone
//     would not catch it);
//   - memory is bounded: expired entries are swept and the oldest evicted past `maxKeys`.
// FRIDAY/CLARA never call these tools (their osmcp allowlists exclude them; they send their
// own Bearer JWT on every request), so nothing here sits on the agents' path.

export interface Rule {
  max: number;
  windowMs: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly rule: Rule,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** 0 when `key` may proceed, otherwise ms until its oldest counted hit leaves the window. */
  retryAfterMs(key: string): number {
    const live = this.live(key);
    if (live.length < this.rule.max) return 0;
    return Math.max(1, live[0] + this.rule.windowMs - this.now());
  }

  record(key: string): void {
    const live = this.live(key);
    live.push(this.now());
    // Re-insert so Map order tracks recency for eviction; only the newest `max` hits can matter.
    this.hits.delete(key);
    this.hits.set(key, live.slice(-this.rule.max));
    if (this.hits.size > this.maxKeys) this.evict();
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.rule.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  private evict(): void {
    const cutoff = this.now() - this.rule.windowMs;
    for (const [k, ts] of this.hits) if (ts[ts.length - 1] <= cutoff) this.hits.delete(k);
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(k); // oldest-touched first
    }
  }
}

const MINUTE = 60_000;
export const SIGN_IN_PER_ACCOUNT: Rule = { max: 5, windowMs: 15 * MINUTE }; // one IP + one email
export const SIGN_IN_PER_IP: Rule = { max: 20, windowMs: 15 * MINUTE }; // one IP, any emails
export const SIGN_UP_PER_IP: Rule = { max: 5, windowMs: 60 * MINUTE };

const accountKey = (ip: string, email: string) => `${ip}|${email.trim().toLowerCase()}`;

function tooMany(what: string, ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / MINUTE));
  return `Too many ${what} attempts from this client. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

/** Supabase refused the credentials/request itself — the only sign-in outcome that counts. A 429
 *  (Supabase's own limiter) or a 5xx is not the caller's guess being wrong. */
export function isCredentialRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

export class AuthRateLimits {
  readonly signInAccount: SlidingWindowLimiter;
  readonly signInIp: SlidingWindowLimiter;
  readonly signUpIp: SlidingWindowLimiter;

  constructor(now: () => number = Date.now, maxKeys = 10_000) {
    this.signInAccount = new SlidingWindowLimiter(SIGN_IN_PER_ACCOUNT, maxKeys, now);
    this.signInIp = new SlidingWindowLimiter(SIGN_IN_PER_IP, maxKeys, now);
    this.signUpIp = new SlidingWindowLimiter(SIGN_UP_PER_IP, maxKeys, now);
  }

  /** Refusal message, or null to proceed. */
  checkSignIn(ip: string, email: string): string | null {
    const wait = Math.max(this.signInAccount.retryAfterMs(accountKey(ip, email)), this.signInIp.retryAfterMs(ip));
    return wait > 0 ? tooMany('sign-in', wait) : null;
  }

  signInFailed(ip: string, email: string): void {
    this.signInAccount.record(accountKey(ip, email));
    this.signInIp.record(ip);
  }

  signInSucceeded(ip: string, email: string): void {
    this.signInAccount.reset(accountKey(ip, email));
  }

  /** Refusal message, or null to proceed — and the attempt is counted when it proceeds. */
  admitSignUp(ip: string): string | null {
    const wait = this.signUpIp.retryAfterMs(ip);
    if (wait > 0) return tooMany('sign-up', wait);
    this.signUpIp.record(ip);
    return null;
  }
}

export const authRateLimits = new AuthRateLimits();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
type Headers = Record<string, string | string[] | undefined>;
const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.trim() || undefined;

/**
 * The caller's IP. Forwarded headers are honoured ONLY when the TCP peer is loopback (the
 * cloudflared tunnel or a local proxy) — from any other peer they are caller-controlled, and
 * trusting them would let a client pick a fresh bucket per request. Behind the tunnel,
 * CF-Connecting-IP (set by Cloudflare) wins; X-Forwarded-For falls back to its LAST entry, the one
 * the nearest proxy appended, since earlier entries are whatever the client sent.
 */
export function clientIpFrom(remoteAddress: string | undefined, headers: Headers): string {
  const peer = remoteAddress || 'unknown';
  if (!LOOPBACK.has(peer)) return peer;
  const cf = first(headers['cf-connecting-ip']);
  if (cf) return cf;
  const xff = first(headers['x-forwarded-for'])?.split(',').map((s) => s.trim()).filter(Boolean);
  return xff?.length ? xff[xff.length - 1] : peer;
}
