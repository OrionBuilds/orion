import { describe, expect, it } from 'vitest';
import { attentionItems, countByStage, eventTone, liveness, minutesSince, stageLabel, type HarveyStatusRow } from './harvey';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const status = (ago: number, snapshot: HarveyStatusRow['snapshot'] = {}): HarveyStatusRow => ({
  snapshot, updated_at: new Date(NOW - ago * 60000).toISOString(),
});

describe('liveness', () => {
  it('is offline when Harvey has never reported', () => {
    expect(liveness(null, NOW).level).toBe('offline');
  });
  it('is live within 3 minutes, stale within 15, offline after', () => {
    expect(liveness(status(1), NOW).level).toBe('live');
    expect(liveness(status(10), NOW).level).toBe('stale');
    expect(liveness(status(45), NOW).level).toBe('offline');
    expect(liveness(status(300), NOW).reason).toContain('5 h');
  });
  it('treats an unreadable time as infinitely old', () => {
    expect(minutesSince('nope', NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(minutesSince(null, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('attentionItems', () => {
  it('is empty when live, running and nothing is waiting', () => {
    expect(attentionItems(status(0, { paused: false }), 0, NOW)).toEqual([]);
  });
  it('puts an automatic pause in the red, and a manual one in amber', () => {
    const auto = attentionItems(status(0, { paused: true, paused_automatically: true, paused_reason: '2 policy blocks' }), 0, NOW);
    expect(auto[0]).toMatchObject({ tone: 'bad' });
    expect(auto[0].text).toContain('2 policy blocks');
    const manual = attentionItems(status(0, { paused: true, paused_automatically: false }), 0, NOW);
    expect(manual[0].tone).toBe('warn');
  });
  it('reports a silent Harvey first, then waiting drafts', () => {
    const items = attentionItems(status(60), 3, NOW);
    expect(items[0].text).toContain('offline');
    expect(items[items.length - 1].text).toBe('3 drafts waiting for your approval.');
    expect(attentionItems(status(0), 1, NOW)[0].text).toBe('1 draft waiting for your approval.');
  });
  it('flags a mailbox Harvey can no longer read as urgent', () => {
    const items = attentionItems(status(0, { mail_read: { ok: false, error: 'sign-in revoked.' } }), 0, NOW);
    expect(items[0].tone).toBe('bad');
    expect(items[0].text).toContain('harvey microsoft login');
    expect(attentionItems(status(0, { mail_read: { ok: true } }), 0, NOW)).toEqual([]);
  });
  it('flags an unavailable brain', () => {
    const items = attentionItems(status(0, { brain: { ok: false, reason: 'login expired' } }), 0, NOW);
    expect(items[0].text).toContain('login expired');
  });
});

describe('stages and events', () => {
  it('counts prospects by stage in pipeline order, unknown stages last', () => {
    const rows = [{ stage: 'replied' }, { stage: 'queued' }, { stage: 'queued' }, { stage: 'weird' }];
    expect(countByStage(rows)).toEqual([
      { stage: 'queued', n: 2 }, { stage: 'replied', n: 1 }, { stage: 'weird', n: 1 },
    ]);
  });
  it('labels stages for people', () => {
    expect(stageLabel('meeting_booked')).toBe('Meeting booked');
  });
  it('colors bad outcomes red and replies green', () => {
    expect(eventTone('reply')).toBe('ok');
    expect(eventTone('policy_block')).toBe('bad');
    expect(eventTone('draft')).toBe('muted');
  });
});

describe('attentionItems: LinkedIn and limits', () => {
  const li = (over: Record<string, unknown>) => ({ linkedin: { enabled: true, mode: 'assist' as const, ...over } });
  const queued = (n: number) => Array.from({ length: n }, (_, i) => ({ outbox_id: `o${i}`, prospect_id: `p${i}`, name: 'A', company: 'B', profile_url: 'https://linkedin.com/in/a', kind: 'connect' as const, body: '' }));

  it('tells the owner how many approved LinkedIn notes are waiting to be sent by hand', () => {
    const one = attentionItems(status(0, li({ queue: queued(1) })), 0, NOW);
    expect(one.map((i) => i.text)).toContain('1 approved LinkedIn note is waiting for you to send by hand (LinkedIn tab).');
    const many = attentionItems(status(0, li({ queue: queued(3) })), 0, NOW);
    expect(many.some((i) => i.text.startsWith('3 approved LinkedIn notes are waiting'))).toBe(true);
  });
  it('does not nag about a queue outside assist mode', () => {
    expect(attentionItems(status(0, li({ mode: 'auto', queue: queued(2) })), 0, NOW)).toEqual([]);
  });
  it('flags a LinkedIn safety stop or a disabled account in red', () => {
    const stop = attentionItems(status(0, li({ tripped_until: '2026-10-31T18:00:00Z' })), 0, NOW);
    expect(stop[0]).toMatchObject({ tone: 'bad' });
    const off = attentionItems(status(0, li({ disabled: true })), 0, NOW);
    expect(off[0].text).toContain('disabled');
  });
  it('flags channels that hit their send limit', () => {
    const items = attentionItems(status(0, { safety: [
      { channel: 'email', label: 'Email per day', cap: 15, used: 15, period: 'day', state: 'full' },
      { channel: 'sms', label: 'SMS per day', cap: 20, used: 3, period: 'day', state: 'ok' },
    ] }), 0, NOW);
    expect(items).toEqual([{ tone: 'warn', text: 'Send limit reached today: Email per day.' }]);
  });
});
