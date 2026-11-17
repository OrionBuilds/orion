/**
 * The agents Settings → AI Agents manages, grouped under their parent.
 *
 * Mirrors the agent repos (they are not imported from here):
 *   CLARA  — clara/src/lib/clara/subagents.ts         (souls: packages/souls/clara/subagents/*.md)
 *   FRIDAY — friday/src/lib/friday/subagents.ts        (department subagents)
 *            friday/src/lib/friday/agents.ts           (dispatch specialists, per-role engine)
 * When a subagent is added or renamed there, add it here so it gets a settings row. Keys follow
 * agent_settings.agent_key: `<parent>` or `<parent>.<id>`, where <id> is the id the agent repo uses
 * (that is what the agent passes as `subagent` to agent-settings-get).
 *
 * `defaultTools` is what the agent's code grants today — shown as suggestions; a settings row can
 * only narrow it (allowed_tools ∩ code allowlist), never widen it.
 */

export type AgentRootKey = 'clara' | 'friday';

export interface AgentDefinition {
  key: string;
  parent: AgentRootKey | null;
  name: string;
  description: string;
  /** Sub-heading under the parent in the selector. */
  group?: string;
  /** Places a voice applies (CLARA answers and places calls). */
  usesVoice?: boolean;
  /** What the code currently hard-codes, for the "inherits" hint. */
  builtInModel?: string;
  defaultTools?: string[];
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    key: 'clara',
    parent: null,
    name: 'CLARA',
    description: 'Executive assistant: calendar, inbox, contacts, calls and client communication.',
    usesVoice: true,
    builtInModel: 'claude-sonnet-5-5 (router) / claude-opus-4-8 (engine)',
  },
  {
    key: 'clara.front-desk', parent: 'clara', name: 'Front Desk', group: 'Subagents',
    description: 'Greets callers and leads, looks up CRM records, books appointments, tracks follow-ups.',
    usesVoice: true,
    defaultTools: ['crm_lookup', 'deal_lookup', 'add_contact_note', 'book_appointment', 'check_availability', 'list_calendar', 'track_followup', 'list_followups', 'escalate_out_of_scope_request', 'portal_message'],
  },
  {
    key: 'clara.scheduler', parent: 'clara', name: 'Scheduler', group: 'Subagents',
    description: 'Finds free time and books, moves or cancels events.',
    defaultTools: ['list_calendar', 'find_free_slot', 'book_event', 'move_event', 'cancel_event', 'check_availability', 'book_appointment', 'coordinate_event'],
  },
  {
    key: 'clara.inbox-triage', parent: 'clara', name: 'Inbox Triage', group: 'Subagents',
    description: 'Sweeps the inbox, unsubscribes and blocks, drafts replies.',
    defaultTools: ['find_email', 'sweep_inbox', 'list_subscriptions', 'unsubscribe_from', 'block_sender', 'list_blocked', 'draft_email'],
  },
  {
    key: 'clara.contracts-docs', parent: 'clara', name: 'Contracts & Docs', group: 'Subagents',
    description: 'Searches, reads and drafts documents in Drive.',
    defaultTools: ['drive_search', 'drive_read', 'drive_create', 'drive_edit', 'make_document', 'deep_work'],
  },
  {
    key: 'clara.researcher', parent: 'clara', name: 'Researcher', group: 'Subagents',
    description: 'Deep research across Drive and the web.',
    defaultTools: ['deep_work', 'drive_search', 'drive_read', 'get_weather'],
  },
  {
    key: 'clara.advisor', parent: 'clara', name: 'Advisor', group: 'Subagents',
    description: 'Briefings, pipeline and invoice status.',
    defaultTools: ['brief_me', 'pipeline_status', 'invoice_status', 'deal_lookup', 'deep_work'],
  },

  {
    key: 'friday',
    parent: null,
    name: 'FRIDAY',
    description: 'Delivery lead: projects, builds, deploys, QA and client updates.',
    usesVoice: true,
    builtInModel: 'claude-sonnet-5 (router) / codex + claude-opus-4-8 (engines)',
  },
  {
    key: 'friday.builder', parent: 'friday', name: 'Builder', group: 'Department subagents',
    description: 'Dispatches build tasks and writes project docs.',
    defaultTools: ['dispatch_task', 'list_projects', 'project_status', 'create_doc'],
  },
  {
    key: 'friday.qa-e2e', parent: 'friday', name: 'QA / E2E', group: 'Department subagents',
    description: 'Site health and end-to-end checks.',
    defaultTools: ['site_health', 'read_deploys', 'dispatch_task', 'list_projects'],
  },
  {
    key: 'friday.devops-deploy', parent: 'friday', name: 'DevOps / Deploy', group: 'Department subagents',
    description: 'Deploys, rollbacks and workspace provisioning.',
    defaultTools: ['deploy', 'rollback_deploy', 'read_deploys', 'site_health', 'provision_workspace'],
  },
  {
    key: 'friday.reviewer', parent: 'friday', name: 'Reviewer', group: 'Department subagents',
    description: 'Code and deliverable review.',
    defaultTools: ['dispatch_task', 'list_projects', 'project_status'],
  },
  {
    key: 'friday.project-manager', parent: 'friday', name: 'Project Manager', group: 'Department subagents',
    description: 'Project status, client health and meeting follow-up.',
    defaultTools: ['project_status', 'list_projects', 'client_health', 'recent_meetings', 'dispatch_task'],
  },
  {
    key: 'friday.client-comms', parent: 'friday', name: 'Client Comms', group: 'Department subagents',
    description: 'Weekly client updates and client health.',
    defaultTools: ['weekly_update', 'client_health', 'find_contact', 'create_doc'],
  },
  {
    key: 'friday.docs-sop', parent: 'friday', name: 'Docs / SOP', group: 'Department subagents',
    description: 'Documentation and SOPs.',
    defaultTools: ['create_doc', 'drive_search', 'deep_work', 'recent_meetings'],
  },
  ...([
    ['architect', 'Architect', 'Plans architecture and breaks work down.'],
    ['pm', 'PM', 'Plans scope and sequencing.'],
    ['dev', 'Dev', 'Implements code changes.'],
    ['designer', 'Designer', 'UI and visual design work.'],
    ['devops', 'DevOps', 'Infrastructure and pipelines.'],
    ['debug', 'Debug', 'Investigates and fixes failures.'],
    ['seo', 'SEO', 'Search optimization work.'],
    ['qa', 'QA', 'Test plans and verification.'],
    ['automation', 'Automation', 'Workflow and automation builds.'],
    ['support', 'Support', 'Client support requests.'],
    ['research-qa', 'Research QA', 'Fact-checks research output.'],
  ] as const).map(([id, name, description]): AgentDefinition => ({
    key: `friday.${id}`,
    parent: 'friday',
    name,
    description,
    group: 'Dispatch specialists',
  })),
];

export function getAgentDefinition(key: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.find((a) => a.key === key);
}

export function rootAgents(): AgentDefinition[] {
  return AGENT_REGISTRY.filter((a) => a.parent === null);
}

export function childrenOf(root: string): AgentDefinition[] {
  return AGENT_REGISTRY.filter((a) => a.parent === root);
}
