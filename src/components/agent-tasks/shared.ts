import type { AgentSlug } from '../../services/agentTasks';

/** The agents the Agent Schedules page manages, with what each is good at. */
export const AGENT_DIRECTORY: { slug: Extract<AgentSlug, 'clara' | 'friday'>; label: string; blurb: string }[] = [
  { slug: 'clara', label: 'CLARA', blurb: 'Personal / owner assistant — briefings, triage, meeting prep' },
  { slug: 'friday', label: 'FRIDAY', blurb: 'Engineering — housekeeping, data hygiene, monitoring, orchestration' },
];

export const inputCls =
  'w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold';
export const labelCls = 'block text-sm font-medium text-hud-cream-soft mb-1';
