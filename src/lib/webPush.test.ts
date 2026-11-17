import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import { pushStatus, sameServerKey, urlBase64ToUint8Array, type PushEnv } from './webPush';

const env = (o: Partial<PushEnv> = {}): PushEnv => ({
  hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default', isIOS: false, isStandalone: false, subscribed: false, ...o,
});

describe('pushStatus', () => {
  it('Android Chrome can enable straight away; once subscribed it is on', () => {
    expect(pushStatus(env())).toBe('off');
    expect(pushStatus(env({ permission: 'granted', subscribed: true }))).toBe('on');
  });
  it('iPhone/iPad need the app installed first', () => {
    expect(pushStatus(env({ isIOS: true }))).toBe('needs-install');
    expect(pushStatus(env({ isIOS: true, hasPushManager: false, hasNotification: false }))).toBe('needs-install');
    expect(pushStatus(env({ isIOS: true, isStandalone: true }))).toBe('off');
  });
  it('blocked permission, missing support and missing server keys are reported', () => {
    expect(pushStatus(env({ permission: 'denied' }))).toBe('blocked');
    expect(pushStatus(env({ hasServiceWorker: false }))).toBe('unsupported');
    expect(pushStatus(env({ hasPushManager: false }))).toBe('unsupported');
    expect(pushStatus(env(), false)).toBe('not-configured');
  });
});

describe('sameServerKey', () => {
  it('spots a subscription made with a key the server no longer uses', () => {
    expect(sameServerKey(urlBase64ToUint8Array('AQID').buffer, 'AQID')).toBe(true);
    expect(sameServerKey(urlBase64ToUint8Array('AQIE').buffer, 'AQID')).toBe(false);
    expect(sameServerKey(urlBase64ToUint8Array('AQ').buffer, 'AQID')).toBe(false);
    expect(sameServerKey(null, 'AQID')).toBe(true);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url without padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array('_-8'))).toEqual([255, 239]);
  });
});
