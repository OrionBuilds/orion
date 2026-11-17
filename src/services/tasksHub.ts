import { supabase } from '../lib/supabase';
import type { User, TaskOriginType, ProjectTaskStatus, ProjectTask } from '../types';
import * as contactTasksSvc from './contactTasks';
import * as projectTasksSvc from './projectTasks';
import * as calendarTasksSvc from './calendarTasks';

/**
 * A2: Standalone /tasks page -- federated read layer over contact_tasks,
 * project_tasks, and calendar_tasks.
 *
 * Decision (from the plan): federate, don't unify. contact_tasks (no org_id,
 * assigned_to_user_id, status pending|in_progress|completed|cancelled,
 * due_date timestamptz) and project_tasks (org_id, assigned_user_id, status
 * todo|in_progress|in_review|completed|cancelled, due_date DATE) diverge on
 * schema and RLS shape; calendar_tasks (org_id, user_id, status
 * pending|in_progress|completed, due_at_utc timestamptz) is the personal-task
 * table already used by the calendar module. All writes route through the
 * EXISTING per-table services (contactTasks.ts / projectTasks.ts /
 * calendarTasks.ts) so timeline events, project activity log entries, audit
 * logs, and assignment notifications keep firing exactly as they do today --
 * this module never writes to the tables directly.
 */

export type UnifiedTaskParentType = 'contact' | 'project' | 'personal';

// Normalized status union across all three raw enums. 'pending' (contact_tasks
// / calendar_tasks) normalizes to 'todo'; 'in_review' only exists on
// project_tasks and is preserved as its own bucket rather than collapsed into
// 'in_progress' so the kanban view can show it faithfully.
export type UnifiedTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'completed' | 'cancelled';

export interface UnifiedTask {
  id: string;
  parentType: UnifiedTaskParentType;
  title: string;
  description: string | null;
  status: UnifiedTaskStatus;
  rawStatus: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  /** ISO date or datetime string, whichever the underlying table stores. */
  dueDate: string | null;
  /** YYYY-MM-DD, derived from dueDate, for Overdue/Today/Upcoming grouping. */
  dueDateOnly: string | null;
  completedAt: string | null;
  assignedUserId: string | null;
  assignedUser: { id: string; name: string; avatar_url?: string | null } | null;
  createdByUserId: string | null;
  createdAt: string;
  originType: TaskOriginType | null;
  originId: string | null;
  /** contact_id / project_id / calendar_id -- the parent record this task lives under. */
  parentId: string;
  parentLabel: string | null;
  parentHref: string | null;
  contactId: string | null;
  opportunityId: string | null;
  projectId: string | null;
  calendarId: string | null;
  orgId: string | null;
}

function dueDateOnly(raw: string | null): string | null {
  if (!raw) return null;
  return raw.split('T')[0];
}

function normalizeContactStatus(raw: string): UnifiedTaskStatus {
  if (raw === 'pending') return 'todo';
  if (raw === 'cancelled') return 'cancelled';
  if (raw === 'completed') return 'completed';
  return 'in_progress';
}

function normalizeProjectStatus(raw: string): UnifiedTaskStatus {
  if (raw === 'todo' || raw === 'in_progress' || raw === 'in_review' || raw === 'completed' || raw === 'cancelled') {
    return raw;
  }
  return 'todo';
}

function normalizeCalendarStatus(raw: string): UnifiedTaskStatus {
  if (raw === 'pending') return 'todo';
  if (raw === 'completed') return 'completed';
  return 'in_progress';
}

/** Map a normalized status back to the raw value the target table's CHECK constraint accepts. */
function denormalizeStatus(parentType: UnifiedTaskParentType, status: UnifiedTaskStatus): string {
  if (parentType === 'project') return status; // project_tasks has all 5 values natively
  if (status === 'todo') return 'pending';
  if (status === 'in_review') return 'in_progress'; // contact_tasks/calendar_tasks have no in_review bucket
  if (status === 'cancelled' && parentType === 'personal') {
    // calendar_tasks_status_check has no 'cancelled' value -- the kanban/list UI must not
    // offer this transition for personal tasks; this is a defensive backstop, not the
    // primary guard.
    throw new Error('Personal tasks cannot be cancelled -- mark completed or delete instead.');
  }
  return status; // in_progress | completed | cancelled (contact_tasks only)
}

type ContactTaskRow = {
  id: string;
  contact_id: string;
  opportunity_id: string | null;
  assigned_to_user_id: string | null;
  created_by_user_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: 'low' | 'medium' | 'high';
  status: string;
  completed_at: string | null;
  created_at: string;
  origin_type: TaskOriginType | null;
  origin_id: string | null;
  assigned_to: { id: string; name: string; avatar_url: string | null } | null;
  contact: { id: string; first_name: string; last_name: string } | null;
};

type ProjectTaskRow = {
  id: string;
  org_id: string;
  project_id: string;
  assigned_user_id: string | null;
  created_by: string;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  origin_type: TaskOriginType | null;
  origin_id: string | null;
  assigned_user: { id: string; name: string; avatar_url: string | null } | null;
  project: { id: string; name: string } | null;
};

type CalendarTaskRow = {
  id: string;
  org_id: string;
  calendar_id: string;
  user_id: string;
  created_by: string | null;
  title: string;
  description: string | null;
  due_at_utc: string;
  priority: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  origin_type: TaskOriginType | null;
  origin_id: string | null;
  user: { id: string; name: string; avatar_url: string | null } | null;
};

function fromContactRow(row: ContactTaskRow): UnifiedTask {
  const label = row.contact ? `${row.contact.first_name} ${row.contact.last_name}`.trim() : null;
  return {
    id: row.id,
    parentType: 'contact',
    title: row.title,
    description: row.description,
    status: normalizeContactStatus(row.status),
    rawStatus: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    dueDateOnly: dueDateOnly(row.due_date),
    completedAt: row.completed_at,
    assignedUserId: row.assigned_to_user_id,
    assignedUser: row.assigned_to,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    originType: row.origin_type,
    originId: row.origin_id,
    parentId: row.contact_id,
    parentLabel: label,
    parentHref: `/contacts/${row.contact_id}`,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    projectId: null,
    calendarId: null,
    orgId: null,
  };
}

function fromProjectRow(row: ProjectTaskRow): UnifiedTask {
  return {
    id: row.id,
    parentType: 'project',
    title: row.title,
    description: row.description,
    status: normalizeProjectStatus(row.status),
    rawStatus: row.status,
    priority: (row.priority as UnifiedTask['priority']) || 'medium',
    dueDate: row.due_date,
    dueDateOnly: dueDateOnly(row.due_date),
    completedAt: row.completed_at,
    assignedUserId: row.assigned_user_id,
    assignedUser: row.assigned_user,
    createdByUserId: row.created_by,
    createdAt: row.created_at,
    originType: row.origin_type,
    originId: row.origin_id,
    parentId: row.project_id,
    parentLabel: row.project?.name ?? null,
    parentHref: `/projects/${row.project_id}`,
    contactId: null,
    opportunityId: null,
    projectId: row.project_id,
    calendarId: null,
    orgId: row.org_id,
  };
}

function fromCalendarRow(row: CalendarTaskRow): UnifiedTask {
  return {
    id: row.id,
    parentType: 'personal',
    title: row.title,
    description: row.description,
    status: normalizeCalendarStatus(row.status),
    rawStatus: row.status,
    priority: (row.priority as UnifiedTask['priority']) || 'medium',
    dueDate: row.due_at_utc,
    dueDateOnly: dueDateOnly(row.due_at_utc),
    completedAt: row.completed_at,
    assignedUserId: row.user_id,
    assignedUser: row.user,
    createdByUserId: row.created_by,
    createdAt: row.created_at,
    originType: row.origin_type,
    originId: row.origin_id,
    parentId: row.calendar_id,
    parentLabel: 'Personal',
    parentHref: null,
    contactId: null,
    opportunityId: null,
    projectId: null,
    calendarId: row.calendar_id,
    orgId: row.org_id,
  };
}

const CONTACT_TASK_SELECT = `
  id, contact_id, opportunity_id, assigned_to_user_id, created_by_user_id, title,
  description, due_date, priority, status, completed_at, created_at, origin_type, origin_id,
  assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
  contact:contacts(id, first_name, last_name)
`;

const PROJECT_TASK_SELECT = `
  id, org_id, project_id, assigned_user_id, created_by, title, description, due_date,
  priority, status, completed_at, created_at, origin_type, origin_id,
  assigned_user:users!project_tasks_assigned_user_id_fkey(id, name, avatar_url),
  project:projects(id, name)
`;

const CALENDAR_TASK_SELECT = `
  id, org_id, calendar_id, user_id, created_by, title, description, due_at_utc,
  priority, status, completed_at, created_at, origin_type, origin_id,
  user:users!calendar_tasks_user_id_fkey(id, name, avatar_url)
`;

/**
 * "My tasks": everything assigned to or created by userId, across all three
 * task tables, normalized into UnifiedTask shape. contact_tasks has no
 * org_id -- org scoping for that source is enforced by its own RLS (joins
 * through contacts.organization_id), so no explicit org filter is applied
 * there; project_tasks/calendar_tasks are filtered by org_id directly.
 */
export async function getMyTasks(userId: string, orgId: string): Promise<UnifiedTask[]> {
  const [contactRes, projectRes, calendarRes] = await Promise.all([
    supabase
      .from('contact_tasks')
      .select(CONTACT_TASK_SELECT)
      .or(`assigned_to_user_id.eq.${userId},created_by_user_id.eq.${userId}`)
      .order('due_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('project_tasks')
      .select(PROJECT_TASK_SELECT)
      .eq('org_id', orgId)
      .or(`assigned_user_id.eq.${userId},created_by.eq.${userId}`)
      .order('due_date', { ascending: true, nullsFirst: false }),
    supabase
      .from('calendar_tasks')
      .select(CALENDAR_TASK_SELECT)
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .order('due_at_utc', { ascending: true }),
  ]);

  if (contactRes.error) throw contactRes.error;
  if (projectRes.error) throw projectRes.error;
  if (calendarRes.error) throw calendarRes.error;

  const contactTasks = ((contactRes.data ?? []) as unknown as ContactTaskRow[]).map(fromContactRow);
  const projectTasks = ((projectRes.data ?? []) as unknown as ProjectTaskRow[]).map(fromProjectRow);
  const calendarTasks = ((calendarRes.data ?? []) as unknown as CalendarTaskRow[]).map(fromCalendarRow);

  return [...contactTasks, ...projectTasks, ...calendarTasks];
}

/**
 * Update a unified task's status by routing to the EXISTING per-table
 * service function -- this is what keeps contact_timeline entries, project
 * activity log entries, and assignment notifications firing for writes made
 * from the unified page, exactly as if the write had happened from the
 * per-record tab.
 */
export async function updateTaskStatus(
  task: UnifiedTask,
  status: UnifiedTaskStatus,
  currentUser: User
): Promise<void> {
  const raw = denormalizeStatus(task.parentType, status);

  if (task.parentType === 'contact') {
    await contactTasksSvc.updateTask(task.id, { status: raw as contactTasksSvc.UpdateTaskData['status'] }, currentUser);
    return;
  }
  if (task.parentType === 'project') {
    await projectTasksSvc.updateTask(task.id, { status: raw as ProjectTaskStatus }, currentUser.id);
    return;
  }
  await calendarTasksSvc.updateCalendarTask(task.id, { status: raw as calendarTasksSvc.UpdateCalendarTaskData['status'] }, currentUser);
}

export interface UnifiedTaskFieldUpdates {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignedUserId?: string | null;
}

/** Edit title/description/due date/priority/assignee, routed through the existing per-table service. */
export async function updateUnifiedTaskFields(
  task: UnifiedTask,
  updates: UnifiedTaskFieldUpdates,
  currentUser: User
): Promise<void> {
  if (task.parentType === 'contact') {
    await contactTasksSvc.updateTask(
      task.id,
      {
        title: updates.title,
        description: updates.description,
        due_date: updates.dueDate,
        priority: updates.priority === 'urgent' ? 'high' : updates.priority,
        assigned_to_user_id: updates.assignedUserId,
      },
      currentUser
    );
    return;
  }
  if (task.parentType === 'project') {
    await projectTasksSvc.updateTask(
      task.id,
      {
        title: updates.title,
        description: updates.description,
        due_date: updates.dueDate,
        priority: updates.priority,
        assigned_user_id: updates.assignedUserId,
      } as Partial<ProjectTask>,
      currentUser.id
    );
    return;
  }
  await calendarTasksSvc.updateCalendarTask(
    task.id,
    {
      title: updates.title,
      description: updates.description,
      due_at_utc: updates.dueDate ?? undefined,
      priority: updates.priority === 'urgent' ? 'high' : updates.priority,
    },
    currentUser
  );
}

export async function deleteUnifiedTask(task: UnifiedTask, currentUser: User): Promise<void> {
  if (task.parentType === 'contact') {
    await contactTasksSvc.deleteTask(task.id, currentUser);
    return;
  }
  if (task.parentType === 'project') {
    await projectTasksSvc.deleteTask(task.id);
    return;
  }
  await calendarTasksSvc.deleteCalendarTask(task.id, currentUser);
}

export interface CreateUnifiedTaskInput {
  parentType: UnifiedTaskParentType;
  title: string;
  description?: string | null;
  dueDate?: string | null;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignedUserId?: string | null;
  // parentType === 'contact'
  contactId?: string;
  // parentType === 'project'
  orgId?: string;
  projectId?: string;
  // parentType === 'personal'
  calendarId?: string;
  // provenance -- set by the "Create task from message" hover action
  originType?: TaskOriginType | null;
  originId?: string | null;
}

/**
 * Create a task under whichever parent the caller picked, routing through
 * the existing create function for that table (same timeline/notify side
 * effects as creating from the contact/project tab, or the calendar's New
 * Task modal). Used both by CreateTaskModal's manual "New Task" flow and by
 * the "Create task from message" hover action (with originType/originId set).
 */
export async function createUnifiedTask(
  input: CreateUnifiedTaskInput,
  currentUser: User
): Promise<UnifiedTask> {
  if (input.parentType === 'contact') {
    if (!input.contactId) throw new Error('contactId is required for a contact task');
    const created = await contactTasksSvc.createTask(
      input.contactId,
      {
        title: input.title,
        description: input.description ?? null,
        due_date: input.dueDate ?? null,
        priority: (input.priority === 'urgent' ? 'high' : input.priority) ?? 'medium',
        assigned_to_user_id: input.assignedUserId ?? null,
        origin_type: input.originType ?? null,
        origin_id: input.originId ?? null,
      },
      currentUser
    );
    return fromContactRow(created as unknown as ContactTaskRow);
  }

  if (input.parentType === 'project') {
    if (!input.projectId || !input.orgId) throw new Error('projectId/orgId are required for a project task');
    const created = await projectTasksSvc.createTask(
      {
        org_id: input.orgId,
        project_id: input.projectId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 'medium',
        due_date: input.dueDate ?? null,
        assigned_user_id: input.assignedUserId ?? null,
        created_by: currentUser.id,
        origin_type: input.originType ?? null,
        origin_id: input.originId ?? null,
      },
      currentUser.id
    );
    return fromProjectRow(created as unknown as ProjectTaskRow);
  }

  if (!input.calendarId || !input.orgId) throw new Error('calendarId/orgId are required for a personal task');
  const dueUtc = input.dueDate
    ? (input.dueDate.includes('T') ? input.dueDate : new Date(`${input.dueDate}T09:00`).toISOString())
    : new Date().toISOString();
  const created = await calendarTasksSvc.createCalendarTask(
    input.orgId,
    {
      calendar_id: input.calendarId,
      title: input.title,
      description: input.description ?? null,
      due_at_utc: dueUtc,
      priority: (input.priority === 'urgent' ? 'high' : input.priority) ?? 'medium',
      assigned_user_id: input.assignedUserId ?? undefined,
      origin_type: input.originType ?? null,
      origin_id: input.originId ?? null,
    },
    currentUser
  );
  return fromCalendarRow(created as unknown as CalendarTaskRow);
}

/**
 * Named per the plan's spec -- thin wrapper over createUnifiedTask requiring
 * originType/originId, for the "Create task" hover action on team/customer
 * messages. Task rows created this way carry a "from message" chip that
 * deep-links back to origin_id via originType.
 */
export async function createTaskFromMessage(
  input: CreateUnifiedTaskInput & { originType: TaskOriginType; originId: string },
  currentUser: User
): Promise<UnifiedTask> {
  return createUnifiedTask(input, currentUser);
}

/**
 * Personal (calendar_tasks) tasks require a NOT NULL calendar_id. Every user
 * gets a type='user' calendar owned by them (the calendar module's existing
 * convention); this resolves it for the "personal" parent option in
 * CreateTaskModal without the caller needing to know about calendars at all.
 */
export async function getPersonalCalendarId(orgId: string, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('calendars')
    .select('id')
    .eq('org_id', orgId)
    .eq('type', 'user')
    .eq('owner_user_id', userId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Resolve a task's origin (the team/conversation message it was created from)
 * to a deep link back to that thread. Called on-demand (e.g. when a task's
 * detail panel opens) rather than batched into getMyTasks, since only one
 * task's origin needs resolving at a time and most tasks have no origin at all.
 */
export async function resolveOriginHref(originType: TaskOriginType, originId: string): Promise<string | null> {
  if (originType === 'conversation_message') {
    const { data } = await supabase
      .from('messages')
      .select('conversation_id')
      .eq('id', originId)
      .maybeSingle();
    return data?.conversation_id ? `/conversations/${data.conversation_id}` : null;
  }
  // team_message -- team messaging tab has no per-channel deep link today, so
  // this lands on the tab; still strictly better than no link at all.
  return '/conversations?tab=team-messaging';
}

export function groupTasksByDueDate(tasks: UnifiedTask[]): {
  overdue: UnifiedTask[];
  today: UnifiedTask[];
  upcoming: UnifiedTask[];
  noDueDate: UnifiedTask[];
  done: UnifiedTask[];
} {
  const todayStr = new Date().toISOString().split('T')[0];
  const overdue: UnifiedTask[] = [];
  const today: UnifiedTask[] = [];
  const upcoming: UnifiedTask[] = [];
  const noDueDate: UnifiedTask[] = [];
  const done: UnifiedTask[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') {
      done.push(task);
      continue;
    }
    if (!task.dueDateOnly) {
      noDueDate.push(task);
    } else if (task.dueDateOnly < todayStr) {
      overdue.push(task);
    } else if (task.dueDateOnly === todayStr) {
      today.push(task);
    } else {
      upcoming.push(task);
    }
  }

  return { overdue, today, upcoming, noDueDate, done };
}
