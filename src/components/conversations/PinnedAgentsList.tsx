import { useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Pin, Sparkles } from 'lucide-react';
import type { PinnedAgentThread } from '../../services/agentThreads';
import { useDevice } from '../../contexts/DeviceContext';

interface PinnedAgentsListProps {
  agents: PinnedAgentThread[];
  selectedAgentId: string | null;
  onSelect: (agent: PinnedAgentThread) => void;
}

const COLLAPSED_KEY = 'orion.conversations.agentsCollapsed';

function readCollapsed(): boolean | null {
  try {
    const v = localStorage.getItem(COLLAPSED_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function Avatar({ agent, size }: { agent: PinnedAgentThread; size: string }) {
  if (agent.avatar_url) return <img src={agent.avatar_url} alt="" className={`${size} rounded-full object-cover flex-shrink-0`} />;
  return (
    <div className={`${size} rounded-full bg-gradient-to-br from-hud-gold to-blue-600 flex items-center justify-center flex-shrink-0`}>
      {agent.mode === 'clara' ? <Sparkles className="w-1/2 h-1/2 text-white" /> : <Bot className="w-1/2 h-1/2 text-white" />}
    </div>
  );
}

/**
 * The org's pinned agents (Clara, FRIDAY, ...), always at the top of Conversations. The section folds down to one
 * row of chips so the conversation list keeps the screen; an agent is one tap away either way. A phone starts
 * folded, and the choice is remembered per device.
 */
export function PinnedAgentsList({ agents, selectedAgentId, onSelect }: PinnedAgentsListProps) {
  const { device } = useDevice();
  const [choice, setChoice] = useState<boolean | null>(readCollapsed);
  if (agents.length === 0) return null;
  const collapsed = choice ?? device === 'phone';
  const toggle = () => {
    const next = !collapsed;
    setChoice(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode: the choice lasts for this visit */ }
  };

  return (
    <div className="border-b border-hud-bg-elev flex-shrink-0" data-testid="pinned-agents">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="pinned-agents-list"
        data-testid="pinned-agents-toggle"
        className="w-full min-h-[44px] px-4 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-hud-cream-mute hover:text-hud-cream-soft transition-colors touch-manipulation"
      >
        <Pin className="w-3 h-3" /> Agents
        <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
          {collapsed ? 'Show' : 'Hide'}
          {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </span>
      </button>

      {collapsed ? (
        <ul id="pinned-agents-list" className="flex gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
          {agents.map((a) => {
            const selected = a.agent_user_id === selectedAgentId;
            return (
              <li key={a.agent_user_id} className="flex-shrink-0">
                <button
                  type="button"
                  onClick={() => onSelect(a)}
                  aria-label={`Open ${a.name}`}
                  className={`min-h-[44px] flex items-center gap-2 rounded-full border pl-1.5 pr-3 text-sm text-white transition-colors touch-manipulation ${
                    selected ? 'border-hud-gold bg-hud-gold/15' : 'border-hud-bg-elev hover:bg-hud-bg-elev/60'
                  }`}
                >
                  <Avatar agent={a} size="w-7 h-7" />
                  <span className="max-w-[7rem] truncate">{a.name.split(' ')[0]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul id="pinned-agents-list" className="pb-2">
          {agents.map((a) => {
            const selected = a.agent_user_id === selectedAgentId;
            return (
              <li key={a.agent_user_id}>
                <button
                  type="button"
                  onClick={() => onSelect(a)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors touch-manipulation ${
                    selected ? 'bg-hud-gold/15 border-l-2 border-hud-gold' : 'hover:bg-hud-bg-elev/60 border-l-2 border-transparent'
                  }`}
                >
                  <Avatar agent={a} size="w-8 h-8" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">{a.name}</div>
                    <div className="text-xs text-hud-cream-dim truncate">
                      {a.mode === 'clara' ? 'Assistant · app + SMS' : a.mode === 'friday' ? 'Engineering · answers + work queue' : 'Agent · work queue'}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
