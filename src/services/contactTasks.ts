import { supabase } from '../lib/supabase';
import type { ContactTask, User } from '../types';
import { addTimelineEvent } from './contactTimeline';
import { logError } from '../lib/errors';

export interface CreateTaskData {
  title: string;
  description?: string | null;
  due_date?: string | null;
  priority?: 'low' | 'medium' | 'high';
  assigned_to_user_id?: string | null;
  opportunity_id?: string | null;
  origin_type?: 'team_message' | 'conversation_message' | null;
  origin_id?: string | null;
}

export interface UpdateTaskData extends Partial<CreateTaskData> {
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export async function getContactTasks(contactId: string): Promise<ContactTask[]> {
  const { data, error } = await supabase
    .from('contact_tasks')
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .eq('contact_id', contactId)
    .order('status')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function getOpportunityTasks(opportunityId: string): Promise<ContactTask[]> {
  const { data, error } = await supabase
    .from('contact_tasks')
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .eq('opportunity_id', opportunityId)
    .order('status')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function getTaskById(id: string): Promise<ContactTask | null> {
  const { data, error } = await supabase
    .from('contact_tasks')
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function createTask(
  contactId: string,
  taskData: CreateTaskData,
  currentUser: User
): Promise<ContactTask> {
  const { data, error } = await supabase
    .from('contact_tasks')
    .insert({
      contact_id: contactId,
      created_by_user_id: currentUser.id,
      ...taskData,
    })
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .single();

  if (error) throw error;

  await addTimelineEvent(contactId, currentUser.id, 'task_created', {
    task_id: data.id,
    task_title: taskData.title,
  });

  return data;
}

export async function updateTask(
  id: string,
  updates: UpdateTaskData,
  currentUser: User
): Promise<ContactTask> {
  const { data: before } = await supabase
    .from('contact_tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  const updateData: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  if (updates.status === 'completed' && before?.status !== 'completed') {
    updateData.completed_at = new Date().toISOString();
  } else if (updates.status && updates.status !== 'completed') {
    updateData.completed_at = null;
  }

  const { data, error } = await supabase
    .from('contact_tasks')
    .update(updateData)
    .eq('id', id)
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .single();

  if (error) throw error;

  if (before) {
    if (updates.status === 'completed' && before.status !== 'completed') {
      await addTimelineEvent(before.contact_id, currentUser.id, 'task_completed', {
        task_id: id,
        task_title: data.title,
      });
    } else {
      await addTimelineEvent(before.contact_id, currentUser.id, 'task_updated', {
        task_id: id,
        task_title: data.title,
      });
    }

    // Re-assignment toast + email now come from the DB task_assigned emitter via
    // notification-dispatcher (migration 20261030220000), so nothing to do here.
  }

  return data;
}

export async function deleteTask(id: string, currentUser: User): Promise<void> {
  const { data: task } = await supabase
    .from('contact_tasks')
    .select('contact_id, title')
    .eq('id', id)
    .maybeSingle();

  const { error } = await supabase.from('contact_tasks').delete().eq('id', id);

  if (error) throw error;

  if (task) {
    await addTimelineEvent(task.contact_id, currentUser.id, 'task_deleted', {
      task_id: id,
      task_title: task.title,
    });
  }
}

export async function completeTask(id: string, currentUser: User): Promise<ContactTask> {
  return updateTask(id, { status: 'completed' }, currentUser);
}

export async function getOverdueTasks(userId: string): Promise<ContactTask[]> {
  const { data, error } = await supabase
    .from('contact_tasks')
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .or(`assigned_to_user_id.eq.${userId},created_by_user_id.eq.${userId}`)
    .not('status', 'in', '("completed","cancelled")')
    .lt('due_date', new Date().toISOString())
    .order('due_date');

  if (error) throw error;
  return data || [];
}

export async function getUpcomingTasks(userId: string, days: number = 7): Promise<ContactTask[]> {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);

  const { data, error } = await supabase
    .from('contact_tasks')
    .select(`
      *,
      assigned_to:users!contact_tasks_assigned_to_user_id_fkey(id, name, avatar_url),
      created_by:users!contact_tasks_created_by_user_id_fkey(id, name, avatar_url)
    `)
    .or(`assigned_to_user_id.eq.${userId},created_by_user_id.eq.${userId}`)
    .not('status', 'in', '("completed","cancelled")')
    .gte('due_date', new Date().toISOString())
    .lte('due_date', futureDate.toISOString())
    .order('due_date');

  if (error) throw error;
  return data || [];
}

export function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'high':
      return 'text-hud-plum bg-hud-plum/10';
    case 'medium':
      return 'text-hud-rust bg-hud-rust/10';
    case 'low':
      return 'text-hud-emerald bg-hud-emerald/10';
    default:
      return 'text-hud-cream-dim bg-hud-cream-mute/10';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'text-hud-emerald bg-hud-emerald/10';
    case 'in_progress':
      return 'text-hud-gold-soft bg-hud-gold/10';
    case 'cancelled':
      return 'text-hud-cream-dim bg-hud-cream-mute/10';
    default:
      return 'text-hud-rust bg-hud-rust/10';
  }
}
