import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';
import type {
  BuilderAgent,
  BuilderMessage,
  CreateMode,
  TaskProposal,
} from '../../supabase/functions/_shared/agent-task-proposal';
import type { AgentTaskSchedule } from './agentTasks';

/**
 * Client for the agent-task-builder edge function (conversational "New schedule" flow).
 * The function owns the LLM call, proposal validation and the schedule insert; this module only
 * shuttles the conversation and the owner-confirmed proposal.
 */

export type BuilderReply =
  | { type: 'questions'; text: string; model: string }
  | {
      type: 'proposal';
      proposal: TaskProposal;
      adjustments: string[];
      recommended_mode: CreateMode;
      model: string;
    };

async function post<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const res = await callEdgeFunction('agent-task-builder', body);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(parseEdgeFunctionError(data, fallback));
  return data as T;
}

export function converseTaskBuilder(agent: BuilderAgent, messages: BuilderMessage[]): Promise<BuilderReply> {
  return post<BuilderReply>({ action: 'converse', agent, messages }, 'The task assistant failed to respond');
}

export function createTaskFromProposal(args: {
  agent: BuilderAgent;
  proposal: TaskProposal;
  mode: CreateMode;
  messages: BuilderMessage[];
  model?: string | null;
}): Promise<{ schedule: AgentTaskSchedule; adjustments: string[] }> {
  return post({ action: 'create', ...args }, 'Failed to create the task');
}
