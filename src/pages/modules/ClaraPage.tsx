import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bot, Loader2 } from 'lucide-react';
import { AgentThreadPane } from '../../components/conversations/AgentThreadPane';
import { getPinnedAgentThreads, matchPinnedAgent, type PinnedAgentThread } from '../../services/agentThreads';

/**
 * Talk to Clara (or switch to Friday, Harvey, Jason): one-tap prompts, dictation and the live thread, without
 * going through Conversations. It is the same thread as her texts and calls.
 */
export function ClaraPage() {
  const [params, setParams] = useSearchParams();
  const [threads, setThreads] = useState<PinnedAgentThread[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPinnedAgentThreads().then((t) => { if (!cancelled) setThreads(t); }).catch(() => { if (!cancelled) setThreads([]); });
    return () => { cancelled = true; };
  }, []);

  const key = params.get('agent') || 'clara';
  const agent = threads ? (matchPinnedAgent(threads, key) ?? matchPinnedAgent(threads, 'clara') ?? threads[0] ?? null) : null;

  return (
    <div className="-m-3 sm:-m-4 md:-m-6 h-[calc(100dvh-64px-var(--safe-top)-var(--bottom-nav))] flex flex-col bg-hud-bg-mid overflow-hidden">
      {threads && threads.length > 1 && (
        <div className="flex gap-2 overflow-x-auto border-b border-hud-bg-elev bg-hud-bg-card px-3 py-2 snap-x-row" role="tablist" aria-label="Agents">
          {threads.map((t) => {
            const active = agent?.channel_id === t.channel_id;
            return (
              <button
                key={t.channel_id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setParams({ agent: t.mode || t.name.toLowerCase() }, { replace: true })}
                className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium touch-manipulation ${active ? 'bg-hud-gold-deep text-white' : 'bg-hud-bg-mid text-hud-cream-soft border border-hud-bg-elev'}`}
              >
                <Bot className="w-3.5 h-3.5" /> {t.name.split(' ')[0]}
              </button>
            );
          })}
        </div>
      )}
      {!threads && <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-hud-cream-dim" /></div>}
      {threads && !agent && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center text-hud-cream-dim">
          <Bot className="w-8 h-8" />
          <p className="text-sm">Clara isn't available for your account.</p>
        </div>
      )}
      {agent && <AgentThreadPane key={agent.channel_id} agent={agent} quickPrompts />}
    </div>
  );
}
