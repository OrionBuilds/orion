import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { slug: string; options: Record<string, unknown> }[] = [];

vi.mock('../lib/edgeFunction', () => ({
  fetchEdge: (slug: string, options: Record<string, unknown>) => {
    calls.push({ slug, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ calendars: [], selectedCalendarIds: [], success: true }) });
  },
}));

const mod = await import('./googleCalendarConnections');

beforeEach(() => { calls.length = 0; });

describe('per-account calendar calls', () => {
  it('send nothing extra without an account (single-account users unchanged)', async () => {
    await mod.getGoogleConnection();
    await mod.getGoogleCalendarList();
    await mod.updateSelectedCalendars(['a']);
    await mod.testGoogleSync();
    await mod.disconnectGoogle();
    expect(calls[0].options).toEqual({ method: 'GET', path: '/connection' });
    expect(calls[1].options).toEqual({ method: 'GET', path: '/calendars' });
    expect(calls[2].options).toEqual({ method: 'POST', path: '/calendars', body: { calendarIds: ['a'] } });
    expect(calls[3].options).toEqual({ method: 'POST', path: '/test-sync' });
    expect(calls[4].options).toEqual({ method: 'POST', path: '/disconnect' });
    expect(calls.every((c) => c.slug === 'google-calendar-oauth')).toBe(true);
  });

  it('send connection_id as a query param for reads and in the body for writes', async () => {
    await mod.getGoogleConnection('g2');
    await mod.getGoogleCalendarList('g2');
    await mod.updateSelectedCalendars(['a'], 'g2');
    await mod.testGoogleSync('g2');
    await mod.disconnectGoogle('g2');
    expect(calls[0].options).toMatchObject({ params: { connection_id: 'g2' } });
    expect(calls[1].options).toMatchObject({ params: { connection_id: 'g2' } });
    expect(calls[2].options).toMatchObject({ body: { calendarIds: ['a'], connection_id: 'g2' } });
    expect(calls[3].options).toMatchObject({ body: { connection_id: 'g2' } });
    expect(calls[4].options).toMatchObject({ body: { connection_id: 'g2' } });
  });
});
