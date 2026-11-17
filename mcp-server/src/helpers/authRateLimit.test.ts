import { describe, it, expect } from 'vitest';
import {
  AuthRateLimits,
  SlidingWindowLimiter,
  clientIpFrom,
  isCredentialRejection,
} from './authRateLimit.js';

const MIN = 60_000;
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('SlidingWindowLimiter', () => {
  it('allows max hits, then blocks until the oldest leaves the window', () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ max: 3, windowMs: 10 * MIN }, 100, c.now);
    for (let i = 0; i < 3; i++) { expect(l.retryAfterMs('k')).toBe(0); l.record('k'); c.advance(MIN); }
    expect(l.retryAfterMs('k')).toBe(7 * MIN);
    c.advance(7 * MIN);
    expect(l.retryAfterMs('k')).toBe(0);
  });

  it('reset clears one key only', () => {
    const l = new SlidingWindowLimiter({ max: 1, windowMs: MIN });
    l.record('a'); l.record('b');
    l.reset('a');
    expect(l.retryAfterMs('a')).toBe(0);
    expect(l.retryAfterMs('b')).toBeGreaterThan(0);
  });

  it('stays bounded: expired keys swept, oldest evicted past maxKeys', () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ max: 5, windowMs: MIN }, 3, c.now);
    for (const k of ['a', 'b', 'c', 'd', 'e']) l.record(k);
    expect(l.size).toBe(3);
    expect(l.retryAfterMs('e')).toBe(0); // still counted, just under max
    c.advance(2 * MIN);
    l.record('f');
    expect(l.size).toBe(1); // everything else expired
  });
});

describe('AuthRateLimits', () => {
  it('locks one account after 5 failures without touching other emails or other clients', () => {
    const r = new AuthRateLimits(clock().now);
    for (let i = 0; i < 5; i++) r.signInFailed('1.1.1.1', 'Casey@Initechbox.com');
    expect(r.checkSignIn('1.1.1.1', 'casey@initechbox.com ')).toMatch(/Too many sign-in attempts.*15 minutes/);
    expect(r.checkSignIn('1.1.1.1', 'someone@else.com')).toBeNull();
    expect(r.checkSignIn('2.2.2.2', 'casey@initechbox.com')).toBeNull(); // PR #25's global bucket locked everyone
  });

  it('caps password spraying per IP at 20 failures across emails', () => {
    const r = new AuthRateLimits(clock().now);
    for (let i = 0; i < 20; i++) r.signInFailed('3.3.3.3', `victim${i}@x.com`);
    expect(r.checkSignIn('3.3.3.3', 'fresh@x.com')).not.toBeNull();
    expect(r.checkSignIn('4.4.4.4', 'fresh@x.com')).toBeNull();
  });

  it("a successful login clears that account's bucket but never the IP bucket", () => {
    const r = new AuthRateLimits(clock().now);
    for (let i = 0; i < 4; i++) r.signInFailed('5.5.5.5', 'me@x.com');
    for (let i = 0; i < 15; i++) r.signInFailed('5.5.5.5', `v${i}@x.com`);
    r.signInSucceeded('5.5.5.5', 'me@x.com'); // attacker logs into their own account
    expect(r.checkSignIn('5.5.5.5', 'me@x.com')).toBeNull();
    r.signInFailed('5.5.5.5', 'v99@x.com'); // 20th failure from this IP
    expect(r.checkSignIn('5.5.5.5', 'another@x.com')).not.toBeNull();
  });

  it('failures expire after the 15-minute window', () => {
    const c = clock();
    const r = new AuthRateLimits(c.now);
    for (let i = 0; i < 5; i++) r.signInFailed('6.6.6.6', 'a@x.com');
    c.advance(15 * MIN);
    expect(r.checkSignIn('6.6.6.6', 'a@x.com')).toBeNull();
  });

  it('admits 5 sign-ups per IP per hour', () => {
    const c = clock();
    const r = new AuthRateLimits(c.now);
    for (let i = 0; i < 5; i++) expect(r.admitSignUp('7.7.7.7')).toBeNull();
    expect(r.admitSignUp('7.7.7.7')).toMatch(/Too many sign-up attempts/);
    expect(r.admitSignUp('8.8.8.8')).toBeNull();
    c.advance(60 * MIN);
    expect(r.admitSignUp('7.7.7.7')).toBeNull();
  });
});

describe('isCredentialRejection', () => {
  it('counts 4xx credential refusals, not Supabase 429s or server errors', () => {
    expect(isCredentialRejection(400)).toBe(true);
    expect(isCredentialRejection(422)).toBe(true);
    expect(isCredentialRejection(429)).toBe(false);
    expect(isCredentialRejection(503)).toBe(false);
    expect(isCredentialRejection(200)).toBe(false);
  });
});

describe('clientIpFrom', () => {
  it('uses the TCP peer and ignores forwarded headers from a non-loopback caller', () => {
    expect(clientIpFrom('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })).toBe('203.0.113.9');
  });

  it('behind the tunnel (loopback peer) prefers CF-Connecting-IP', () => {
    expect(clientIpFrom('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '9.9.9.9' })).toBe('198.51.100.7');
  });

  it('falls back to the LAST X-Forwarded-For hop, not the client-supplied first one', () => {
    expect(clientIpFrom('::1', { 'x-forwarded-for': 'spoofed, 198.51.100.8' })).toBe('198.51.100.8');
  });

  it('loopback with no forwarding headers is the loopback peer itself', () => {
    expect(clientIpFrom('::ffff:127.0.0.1', {})).toBe('::ffff:127.0.0.1');
    expect(clientIpFrom(undefined, {})).toBe('unknown');
  });
});
