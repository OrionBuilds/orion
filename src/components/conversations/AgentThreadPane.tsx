import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2, MessageCircleQuestion, Phone, Smartphone } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { InternalMessageThread } from './InternalMessageThread';
import { QuickPrompts, quickPromptsFor, type QuickPrompt } from './QuickPrompts';
import {
  getChannelMessages,
  markChannelAsRead,
  sendMessage,
  subscribeToChannelMessages,
  type ChannelWithDetails,
  type TeamAttachment,
  type TeamMessage,
} from '../../services/teamMessaging';
import {
  getAgentThreadTurns,
  overheardMessageIds,
  subscribeToAgentThreadTurns,
  turnStatusLabel,
  type AgentThreadTurn,
  type PinnedAgentThread,
} from '../../services/agentThreads';

const TONE: Record<string, string> = {
  muted: 'text-hud-cream-mute',
  busy: 'text-hud-gold-soft',
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-rose-400',
};

function StatusIcon({ status }: { status: AgentThreadTurn['status'] }) {
  if (status === 'working' || status === 'picked_up') return <Loader2 className="w-3 h-3 animate-spin" />;
  if (status === 'answered') return <CheckCircle2 className="w-3 h-3" />;
  if (status === 'needs_input') return <MessageCircleQuestion className="w-3 h-3" />;
  if (status === 'failed') return <AlertCircle className="w-3 h-3" />;
  return <Clock className="w-3 h-3" />;
}

/**
 * A pinned agent's thread (the user's DM with Clara / FRIDAY / ...): the ordinary team-message
 * thread plus, under each of the user's messages, where it stands with the agent
 * (sent -> picked up -> answered), and a "via SMS / call" tag on turns mirrored from the phone.
 */
export function AgentThreadPane({ agent, quickPrompts = false }: { agent: PinnedAgentThread; quickPrompts?: boolean }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [turns, setTurns] = useState<Record<string, AgentThreadTurn>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [showOverheard, setShowOverheard] = useState(false);

  // What a listening device overheard is not conversation: folded away unless asked for.
  const overheard = useMemo(() => overheardMessageIds(messages, agent.agent_user_id), [messages, agent.agent_user_id]);
  const visible = useMemo(
    () => (showOverheard || !overheard.size ? messages : messages.filter((m) => !overheard.has(m.id))),
    [messages, overheard, showOverheard],
  );

  const channel: ChannelWithDetails = useMemo(() => ({
    id: agent.channel_id,
    organization_id: user?.organization_id ?? '',
    name: null,
    type: 'direct',
    description: null,
    created_by: user?.id ?? '',
    department_id: null,
    avatar_url: agent.avatar_url,
    is_archived: false,
    created_at: '',
    updated_at: '',
    agent_user_id: agent.agent_user_id,
    unread_count: 0,
    member_count: 2,
    members: [
      { user_id: agent.agent_user_id, role: 'member', name: agent.name, email: agent.email, avatar_url: agent.avatar_url },
      { user_id: user?.id ?? '', role: 'member', name: user?.name ?? 'You', email: user?.email ?? '', avatar_url: null },
    ],
  }), [agent, user?.id, user?.organization_id, user?.name, user?.email]);

  const load = useCallback(async (showRefreshing = false) => {
    try {
      if (showRefreshing) setRefreshing(true); else setLoading(true);
      const [msgs, ts] = await Promise.all([
        getChannelMessages(agent.channel_id, 200),
        getAgentThreadTurns(agent.channel_id).catch(() => [] as AgentThreadTurn[]),
      ]);
      setMessages(msgs);
      setTurns(Object.fromEntries(ts.map((t) => [t.message_id, t])));
      markChannelAsRead(agent.channel_id).catch(() => {});
    } catch (e) {
      console.error('Failed to load agent thread:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [agent.channel_id]);

  useEffect(() => { load(); }, [load]);

  // Realtime: new messages (owner, agent replies, mirrored SMS) and status changes.
  useEffect(() => {
    const offMessages = subscribeToChannelMessages(agent.channel_id, (m) => {
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      if (m.sender_id !== user?.id) markChannelAsRead(agent.channel_id).catch(() => {});
    });
    const offTurns = subscribeToAgentThreadTurns(agent.channel_id, (t) => {
      setTurns((prev) => ({ ...prev, [t.message_id]: t }));
    });
    return () => { offMessages(); offTurns(); };
  }, [agent.channel_id, user?.id]);

  const handleSend = useCallback(async (content: string, attachments?: TeamAttachment[]) => {
    setSendError(null);
    try {
      const sent = await sendMessage(agent.channel_id, content, undefined, attachments);
      setMessages((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, sent]));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendError(`Not sent: ${msg}`);
      throw e;
    }
  }, [agent.channel_id]);

  const renderMeta = useCallback((m: TeamMessage) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const source = meta.source as string | undefined;
    const turn = turns[m.id];
    const bits: ReactNode[] = [];
    if (source === 'sms' || source === 'voice') {
      bits.push(
        <span key="src" className="inline-flex items-center gap-1 text-hud-cream-mute">
          {source === 'sms' ? <Smartphone className="w-3 h-3" /> : <Phone className="w-3 h-3" />}
          {source === 'sms' ? 'via SMS' : 'via call'}
        </span>,
      );
    }
    if (turn) {
      const s = turnStatusLabel(turn, agent.name);
      bits.push(
        <span key="st" className={`inline-flex items-center gap-1 ${TONE[s.tone]}`} title={turn.error ?? undefined}>
          <StatusIcon status={turn.status} />
          {s.label}
          {turn.status === 'failed' && turn.error ? ` · ${turn.error.slice(0, 120)}` : ''}
        </span>,
      );
    }
    if (!bits.length) return null;
    return <div className={`mt-1 flex gap-3 text-[11px] ${m.sender_id === user?.id ? 'justify-end' : ''}`}>{bits}</div>;
  }, [turns, agent.name, user?.id]);

  const subtitle = agent.mode === 'clara'
    ? 'Your assistant · same conversation as your texts with her'
    : agent.mode === 'friday'
      ? 'Engineering agent · questions are answered here; work is queued and reported back when done'
      : 'Agent · messages are queued; replies arrive when the work is done';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {sendError && (
        <div className="px-4 py-2 text-xs text-rose-300 bg-rose-500/10 border-b border-rose-500/20">{sendError}</div>
      )}
      {overheard.size > 0 && (
        <div className="flex items-center justify-between gap-3 border-b border-hud-line-soft px-4 py-1 text-xs text-hud-cream-mute">
          <span className="min-w-0 truncate">
            {showOverheard ? 'Showing' : 'Hidden:'} {overheard.size} overheard {overheard.size === 1 ? 'line' : 'lines'} {agent.name.split(' ')[0]} stayed quiet on
          </span>
          <button
            type="button"
            onClick={() => setShowOverheard((v) => !v)}
            className="-my-1 min-h-[44px] shrink-0 px-2 font-medium text-hud-gold-soft hover:text-hud-gold"
            data-testid="agent-thread-overheard-toggle"
          >
            {showOverheard ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
      <InternalMessageThread
        channel={channel}
        messages={visible}
        loading={loading}
        refreshing={refreshing}
        onSendMessage={handleSend}
        onRefresh={() => load(true)}
        renderMessageMeta={renderMeta}
        subtitle={subtitle}
        composerPrefill={prefill}
        composerTop={quickPrompts ? (
          <QuickPrompts
            prompts={quickPromptsFor(agent.mode)}
            onPick={(p: QuickPrompt) => {
              if (p.send) void handleSend(p.text).catch(() => {});
              else setPrefill({ text: p.text, nonce: Date.now() });
            }}
          />
        ) : undefined}
      />
    </div>
  );
}
