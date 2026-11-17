import { describe, expect, it } from 'vitest';
import { matchPinnedAgent, overheardMessageIds, turnStatusLabel, type PinnedAgentThread, type ThreadMessageLike } from './agentThreads';

const clara: PinnedAgentThread = {
  agent_user_id: 'u-clara', name: 'Clara', email: 'clara@example.com', avatar_url: null,
  role_name: 'ClaraAgent', mode: 'clara', channel_id: 'ch-1', sort_order: 1,
};
const friday: PinnedAgentThread = {
  agent_user_id: 'u-friday', name: 'Friday Daily', email: 'friday@example.com', avatar_url: null,
  role_name: 'FridayAgent', mode: 'agent_request', channel_id: 'ch-2', sort_order: 2,
};

describe('matchPinnedAgent (?agent= deep links)', () => {
  const list = [clara, friday];
  it('matches by agent user id or channel id', () => {
    expect(matchPinnedAgent(list, 'u-friday')).toBe(friday);
    expect(matchPinnedAgent(list, 'ch-1')).toBe(clara);
  });
  it('matches keywords so links never need ids', () => {
    expect(matchPinnedAgent(list, 'clara')).toBe(clara);
    expect(matchPinnedAgent(list, 'friday')).toBe(friday);
    expect(matchPinnedAgent(list, 'FRIDAY')).toBe(friday);
  });
  it('returns null for nothing or an unknown key', () => {
    expect(matchPinnedAgent(list, null)).toBeNull();
    expect(matchPinnedAgent(list, 'nobody')).toBeNull();
    expect(matchPinnedAgent([], 'clara')).toBeNull();
  });
});

describe('turnStatusLabel', () => {
  it('walks FRIDAY from sent to picked up to answered', () => {
    expect(turnStatusLabel({ mode: 'agent_request', status: 'queued' }, 'FRIDAY').label).toContain('waiting for FRIDAY');
    expect(turnStatusLabel({ mode: 'agent_request', status: 'picked_up' }, 'FRIDAY').label).toBe('Picked up by FRIDAY');
    expect(turnStatusLabel({ mode: 'agent_request', status: 'answered' }, 'FRIDAY')).toEqual({ label: 'Answered', tone: 'ok' });
    expect(turnStatusLabel({ mode: 'agent_request', status: 'needs_input' }, 'FRIDAY').tone).toBe('warn');
  });
  it('covers a friday-mode thread: answered here, or queued as work', () => {
    expect(turnStatusLabel({ mode: 'friday', status: 'working' }, 'FRIDAY')).toEqual({ label: 'FRIDAY is working on it', tone: 'busy' });
    expect(turnStatusLabel({ mode: 'friday', status: 'queued' }, 'FRIDAY').label).toContain('waiting for FRIDAY');
    expect(turnStatusLabel({ mode: 'friday', status: 'answered' }, 'FRIDAY').tone).toBe('ok');
    const fri = { ...friday, mode: 'friday' as const };
    expect(matchPinnedAgent([clara, fri], 'friday')).toBe(fri);
  });
  it('shows Clara working and failures as errors', () => {
    expect(turnStatusLabel({ mode: 'clara', status: 'working' }, 'Clara').label).toBe('Clara is working on it');
    expect(turnStatusLabel({ mode: 'clara', status: 'failed' }, 'Clara').tone).toBe('error');
  });
});

describe('overheardMessageIds (what an always-listening device picked up)', () => {
  let n = 0;
  const msg = (who: 'me' | 'clara', content: string, sec: number, source: string | null = 'voice'): ThreadMessageLike => ({
    id: `m${++n}`, sender_id: who === 'me' ? 'u-me' : 'u-clara', content,
    created_at: new Date(Date.UTC(2026, 10, 4, 20, 0, sec)).toISOString(), metadata: source ? { source, mirrored: true } : {},
  });
  const hidden = (list: ThreadMessageLike[]) => list.filter((m) => overheardMessageIds(list, 'u-clara').has(m.id)).map((m) => m.content);

  it('folds away room talk together with the "staying quiet" reply', () => {
    const list = [
      msg('me', 'Clara, what is on tomorrow?', 0), msg('clara', 'Two meetings.', 1),
      msg('me', 'We want him to push our software.', 30), msg('clara', "Still not addressed to me, so I'm staying quiet. Say Clara when you need me.", 31),
    ];
    expect(hidden(list)).toEqual(['We want him to push our software.', "Still not addressed to me, so I'm staying quiet. Say Clara when you need me."]);
  });
  it('folds away a beep and the reply about it, but keeps a reply that says something else', () => {
    const list = [
      msg('me', '[phone beeping]', 0), msg('clara', 'That was just a phone beep. Do you need anything from me?', 0),
      msg('me', '[phone beeps]', 60), msg('clara', 'I got that wrong earlier. Tomorrow is Friday.', 60),
    ];
    expect(hidden(list)).toEqual(['[phone beeping]', 'That was just a phone beep. Do you need anything from me?', '[phone beeps]']);
  });
  it('never touches typed or texted messages, or the request before an unrelated quiet reply', () => {
    const list = [
      msg('me', 'This was not addressed to me, was it?', 0, null), msg('clara', 'It was addressed to me.', 1, 'agent'),
      msg('me', 'Clara, book the room.', 100), msg('clara', "Still not addressed to me, so I'm staying quiet.", 400),
    ];
    expect(hidden(list)).toEqual(["Still not addressed to me, so I'm staying quiet."]);
  });
});
