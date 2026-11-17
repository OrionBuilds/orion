/**
 * Pinned agent threads (Clara, FRIDAY, ...) at the top of Conversations.
 *
 * Each pinned agent is a direct team channel between the signed-in user and the agent user
 * (team_channels.agent_user_id). Which agents are pinned is organizations.pinned_agent_user_ids
 * (no settings UI; CLARA + FRIDAY when empty). get_pinned_agent_threads() returns them in order and
 * creates the caller's DM (with both members) the first time. Routing and replies happen in the
 * database + the agent-thread edge function; the UI only sends team messages and shows the
 * per-message status from agent_thread_turns (realtime).
 */
import { supabase } from '../lib/supabase';

/** clara: Clara's owner brain. friday: the OS answers questions as FRIDAY and queues real work to its runner. agent_request: every message is queued to the agent. */
export type AgentThreadMode = 'clara' | 'agent_request' | 'friday';

export interface PinnedAgentThread {
  agent_user_id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role_name: string | null;
  mode: AgentThreadMode;
  channel_id: string;
  sort_order: number;
}

export type AgentTurnStatus =
  | 'sent' | 'working' | 'queued' | 'picked_up' | 'answered' | 'needs_input' | 'failed';

export interface AgentThreadTurn {
  message_id: string;
  channel_id: string;
  agent_user_id: string;
  mode: AgentThreadMode;
  status: AgentTurnStatus;
  agent_request_id: string | null;
  reply_message_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function getPinnedAgentThreads(): Promise<PinnedAgentThread[]> {
  const { data, error } = await supabase.rpc('get_pinned_agent_threads');
  if (error) throw error;
  return ((data ?? []) as PinnedAgentThread[]).sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Resolve a `?agent=` deep-link value against the pinned list: an agent user id, or a mode /
 * name keyword ("clara", "friday") so links never need to know ids.
 */
export function matchPinnedAgent(threads: PinnedAgentThread[], key: string | null | undefined): PinnedAgentThread | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  return (
    threads.find((t) => t.agent_user_id === key || t.channel_id === key) ??
    threads.find((t) => t.mode === k) ??
    threads.find((t) => t.email.toLowerCase().startsWith(`${k}@`) || t.name.toLowerCase().startsWith(k)) ??
    null
  );
}

export async function getAgentThreadTurns(channelId: string, limit = 200): Promise<AgentThreadTurn[]> {
  const { data, error } = await supabase
    .from('agent_thread_turns')
    .select('message_id, channel_id, agent_user_id, mode, status, agent_request_id, reply_message_id, error, created_at, updated_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AgentThreadTurn[];
}

/** The latest signs of life in an agent's thread: its last message and the state of the last turn sent to it. */
export interface AgentThreadPulse {
  lastReplyAt: string | null;
  lastTurn: Pick<AgentThreadTurn, 'status' | 'error' | 'created_at' | 'updated_at'> | null;
}

export async function getAgentThreadPulse(channelId: string, agentUserId: string): Promise<AgentThreadPulse> {
  const [reply, turn] = await Promise.all([
    supabase.from('team_messages').select('created_at')
      .eq('channel_id', channelId).eq('sender_id', agentUserId).eq('is_deleted', false)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('agent_thread_turns').select('status, error, created_at, updated_at')
      .eq('channel_id', channelId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (reply.error) throw reply.error;
  if (turn.error) throw turn.error;
  return { lastReplyAt: reply.data?.created_at ?? null, lastTurn: (turn.data as AgentThreadPulse['lastTurn']) ?? null };
}

export function subscribeToAgentThreadTurns(channelId: string, onChange: (turn: AgentThreadTurn) => void) {
  const channel = supabase
    .channel(`agent-thread-turns-${channelId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'agent_thread_turns', filter: `channel_id=eq.${channelId}` },
      (payload) => {
        if (payload.new && (payload.new as AgentThreadTurn).message_id) onChange(payload.new as AgentThreadTurn);
      },
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

const SOUND_ONLY = /^(\s*\[[^\]]*\]\s*)+$/;
const NOT_FOR_HER = /\baddressed to me\b/i;
/** A reply follows what was heard within a moment: the two are written together. */
const PAIR_MS = 5_000;

export interface ThreadMessageLike {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Pure: the voice turns that were never conversation. An always-listening device picks up the room, and each
 * overheard line arrives with the agent's "not addressed to me, so I'm staying quiet"; a beep arrives as "[beep]"
 * with a reply about the beep. Both halves are returned so the thread can fold them away.
 */
export function overheardMessageIds(messages: ThreadMessageLike[], agentUserId: string): Set<string> {
  const voice = messages.filter((m) => m.metadata?.source === 'voice')
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const near = (a: ThreadMessageLike, b: ThreadMessageLike) => Math.abs(Date.parse(b.created_at) - Date.parse(a.created_at)) <= PAIR_MS;
  const out = new Set<string>();
  voice.forEach((m, i) => {
    const mine = m.sender_id !== agentUserId;
    if (mine && SOUND_ONLY.test(m.content)) {
      out.add(m.id);
      const reply = voice[i + 1];
      if (reply && reply.sender_id === agentUserId && near(m, reply) && /\bbeep/i.test(reply.content)) out.add(reply.id);
    } else if (!mine && NOT_FOR_HER.test(m.content)) {
      out.add(m.id);
      const heard = voice[i - 1];
      if (heard && heard.sender_id !== agentUserId && near(heard, m)) out.add(heard.id);
    }
  });
  return out;
}

/** Label + tone for a turn's status chip. */
export function turnStatusLabel(turn: Pick<AgentThreadTurn, 'mode' | 'status'>, agentName: string): { label: string; tone: 'muted' | 'busy' | 'ok' | 'warn' | 'error' } {
  switch (turn.status) {
    case 'sent': return { label: 'Sent', tone: 'muted' };
    case 'working': return { label: `${agentName} is working on it`, tone: 'busy' };
    case 'queued': return { label: `Sent · waiting for ${agentName} to pick it up`, tone: 'muted' };
    case 'picked_up': return { label: `Picked up by ${agentName}`, tone: 'busy' };
    case 'answered': return { label: 'Answered', tone: 'ok' };
    case 'needs_input': return { label: `${agentName} has a question`, tone: 'warn' };
    case 'failed': return { label: 'Failed', tone: 'error' };
    default: return { label: turn.status, tone: 'muted' };
  }
}
