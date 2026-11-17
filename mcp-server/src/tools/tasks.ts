import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * A2: the "agents can close tasks" surface for FRIDAY/CLARA -- a thin
 * federated read/write layer over contact_tasks, project_tasks, and
 * calendar_tasks, mirroring src/services/tasksHub.ts on the app side. Writes
 * go straight through PostgREST under the caller's own JWT, so the same RLS
 * policies that gate the UI gate these tools too (an agent role with
 * tasks.view but not tasks.manage gets a 403 on status/create calls
 * unless the underlying table's own row policy independently allows it).
 */

const PARENT_TYPES = ['contact', 'project', 'personal'] as const;
type ParentType = (typeof PARENT_TYPES)[number];

const TABLE_BY_PARENT: Record<ParentType, string> = {
  contact: 'contact_tasks',
  project: 'project_tasks',
  personal: 'calendar_tasks',
};

// Normalized status -> raw status accepted by each table's CHECK constraint.
function denormalizeStatus(parentType: ParentType, status: string): string {
  if (parentType === 'project') return status; // todo|in_progress|in_review|completed|cancelled
  if (status === 'todo') return 'pending';
  if (status === 'in_review') return 'in_progress'; // contact_tasks/calendar_tasks have no in_review bucket
  if (status === 'cancelled' && parentType === 'personal') {
    throw new Error('Personal (calendar) tasks cannot be cancelled -- use completed or delete instead.');
  }
  return status;
}

function normalizeStatus(parentType: ParentType, raw: string): string {
  if (parentType === 'project') return raw;
  if (raw === 'pending') return 'todo';
  return raw;
}

interface RawContactTask {
  id: string;
  contact_id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  assigned_to_user_id: string | null;
  origin_type: string | null;
  origin_id: string | null;
  [k: string]: unknown;
}
interface RawProjectTask {
  id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  assigned_user_id: string | null;
  origin_type: string | null;
  origin_id: string | null;
  [k: string]: unknown;
}
interface RawCalendarTask {
  id: string;
  calendar_id: string;
  title: string;
  status: string;
  priority: string;
  due_at_utc: string;
  user_id: string;
  origin_type: string | null;
  origin_id: string | null;
  [k: string]: unknown;
}

function normalizeContact(row: RawContactTask) {
  return {
    id: row.id,
    parent_type: 'contact' as const,
    parent_id: row.contact_id,
    title: row.title,
    status: normalizeStatus('contact', row.status),
    raw_status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    assigned_user_id: row.assigned_to_user_id,
    origin_type: row.origin_type,
    origin_id: row.origin_id,
  };
}
function normalizeProject(row: RawProjectTask) {
  return {
    id: row.id,
    parent_type: 'project' as const,
    parent_id: row.project_id,
    title: row.title,
    status: normalizeStatus('project', row.status),
    raw_status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    assigned_user_id: row.assigned_user_id,
    origin_type: row.origin_type,
    origin_id: row.origin_id,
  };
}
function normalizeCalendar(row: RawCalendarTask) {
  return {
    id: row.id,
    parent_type: 'personal' as const,
    parent_id: row.calendar_id,
    title: row.title,
    status: normalizeStatus('personal', row.status),
    raw_status: row.status,
    priority: row.priority,
    due_date: row.due_at_utc,
    assigned_user_id: row.user_id,
    origin_type: row.origin_type,
    origin_id: row.origin_id,
  };
}

export function registerTasksTools(server: McpServer): void {
  server.tool(
    'tasks_my_list',
    'List a user\'s tasks federated across contact tasks, project tasks, and personal (calendar) tasks -- everything assigned to them or created by them, normalized to a common shape. This is the primary "what do I need to do" surface for agents (FRIDAY/CLARA).',
    {
      user_id: z.string().uuid().describe('User UUID to list tasks for'),
      org_id: z.string().uuid().describe('Organization UUID (required for project/calendar task scoping)'),
      include_done: z.boolean().optional().describe('Include completed/cancelled tasks. Default false.'),
      limit: z.number().optional().describe('Max rows per source table, default 100'),
    },
    async ({ user_id, org_id, include_done, limit }) => {
      try {
        const cap = limit || 100;
        const [contactRows, projectRows, calendarRows] = await Promise.all([
          restGet('contact_tasks', {
            select: '*',
            filters: { or: `(assigned_to_user_id.eq.${user_id},created_by_user_id.eq.${user_id})` },
            order: 'due_date.asc',
            limit: cap,
          }) as Promise<RawContactTask[]>,
          restGet('project_tasks', {
            select: '*',
            filters: {
              org_id: `eq.${org_id}`,
              or: `(assigned_user_id.eq.${user_id},created_by.eq.${user_id})`,
            },
            order: 'due_date.asc',
            limit: cap,
          }) as Promise<RawProjectTask[]>,
          restGet('calendar_tasks', {
            select: '*',
            filters: { org_id: `eq.${org_id}`, user_id: `eq.${user_id}` },
            order: 'due_at_utc.asc',
            limit: cap,
          }) as Promise<RawCalendarTask[]>,
        ]);

        let tasks = [
          ...contactRows.map(normalizeContact),
          ...projectRows.map(normalizeProject),
          ...calendarRows.map(normalizeCalendar),
        ];

        if (!include_done) {
          tasks = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
        }

        return toolResult(tasks);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'tasks_update_status',
    'Update a task\'s status, routed to the correct underlying table (contact_tasks / project_tasks / calendar_tasks) by parent_type. Accepts normalized statuses: todo, in_progress, in_review (project tasks only), completed, cancelled (not valid for personal tasks).',
    {
      id: z.string().describe('Task UUID'),
      parent_type: z.enum(PARENT_TYPES),
      status: z.enum(['todo', 'in_progress', 'in_review', 'completed', 'cancelled']),
    },
    async ({ id, parent_type, status }) => {
      try {
        const table = TABLE_BY_PARENT[parent_type as ParentType];
        const rawStatus = denormalizeStatus(parent_type as ParentType, status);
        const body: Record<string, unknown> = { status: rawStatus, updated_at: new Date().toISOString() };
        if (rawStatus === 'completed') {
          body.completed_at = new Date().toISOString();
          if (parent_type === 'personal') body.completed = true;
        } else {
          body.completed_at = null;
          if (parent_type === 'personal') body.completed = false;
        }
        const data = await restPatch(table, { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'tasks_create_from_message',
    'Create a task from a team message or conversation message, stamping origin_type/origin_id so the task shows a "from message" chip in the UI. Mirrors the app\'s "Create task" hover action -- use this instead of contact_tasks_create/project_tasks_create when the task originates from a message an agent is processing.',
    {
      parent_type: z.enum(PARENT_TYPES),
      title: z.string(),
      description: z.string().optional(),
      due_date: z.string().optional().describe('ISO date/datetime; contact/calendar accept either, project_tasks wants a plain date (YYYY-MM-DD)'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigned_user_id: z.string().optional(),
      contact_id: z.string().optional().describe('Required when parent_type=contact'),
      project_id: z.string().optional().describe('Required when parent_type=project'),
      org_id: z.string().optional().describe('Required when parent_type=project or personal'),
      calendar_id: z.string().optional().describe('Required when parent_type=personal'),
      created_by: z.string().optional().describe('User UUID to attribute the task to (project_tasks.created_by / contact_tasks.created_by_user_id)'),
      origin_type: z.enum(['team_message', 'conversation_message']),
      origin_id: z.string().describe('UUID of the team_messages or messages row this task originates from'),
    },
    async (params) => {
      try {
        const { parent_type } = params;
        if (parent_type === 'contact') {
          if (!params.contact_id || !params.created_by) {
            throw new Error('contact_id and created_by are required for parent_type=contact');
          }
          const data = await restPost(
            'contact_tasks',
            {
              contact_id: params.contact_id,
              created_by_user_id: params.created_by,
              title: params.title,
              description: params.description ?? null,
              due_date: params.due_date ?? null,
              priority: params.priority === 'urgent' ? 'high' : params.priority ?? 'medium',
              assigned_to_user_id: params.assigned_user_id ?? null,
              origin_type: params.origin_type,
              origin_id: params.origin_id,
            },
            'return=representation',
          );
          return toolResult(data);
        }
        if (parent_type === 'project') {
          if (!params.project_id || !params.org_id || !params.created_by) {
            throw new Error('project_id, org_id, and created_by are required for parent_type=project');
          }
          const data = await restPost(
            'project_tasks',
            {
              org_id: params.org_id,
              project_id: params.project_id,
              title: params.title,
              description: params.description ?? null,
              due_date: params.due_date ?? null,
              priority: params.priority ?? 'medium',
              assigned_user_id: params.assigned_user_id ?? null,
              created_by: params.created_by,
              origin_type: params.origin_type,
              origin_id: params.origin_id,
            },
            'return=representation',
          );
          return toolResult(data);
        }
        // personal
        if (!params.calendar_id || !params.org_id) {
          throw new Error('calendar_id and org_id are required for parent_type=personal');
        }
        const dueUtc = params.due_date
          ? (params.due_date.includes('T') ? params.due_date : `${params.due_date}T09:00:00.000Z`)
          : new Date().toISOString();
        const data = await restPost(
          'calendar_tasks',
          {
            org_id: params.org_id,
            calendar_id: params.calendar_id,
            user_id: params.assigned_user_id ?? params.created_by,
            title: params.title,
            description: params.description ?? null,
            due_at_utc: dueUtc,
            priority: params.priority === 'urgent' ? 'high' : params.priority ?? 'medium',
            status: 'pending',
            completed: false,
            created_by: params.created_by ?? null,
            origin_type: params.origin_type,
            origin_id: params.origin_id,
          },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
