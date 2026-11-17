import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, List, LayoutGrid, Loader2, AlertCircle, CheckSquare } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  getMyTasks,
  updateTaskStatus,
  updateUnifiedTaskFields,
  deleteUnifiedTask,
  type UnifiedTask,
  type UnifiedTaskStatus,
} from '../../services/tasksHub';
import { getUsers } from '../../services/users';
import type { User } from '../../types';
import { PageHeader, EmptyState } from '../../components/layouts';
import { TaskListView } from '../../components/tasks/TaskListView';
import { TaskKanbanView } from '../../components/tasks/TaskKanbanView';
import { TaskDetailPanel } from '../../components/tasks/TaskDetailPanel';
import { CreateTaskModal } from '../../components/tasks/CreateTaskModal';
import { reportBackgroundError } from '../../lib/errors';

type ViewMode = 'list' | 'kanban';

interface TasksPageProps {
  /** Rendered as a tab inside another module (Calendars): no page header, no outer frame. */
  embedded?: boolean;
}

export function TasksPage({ embedded = false }: TasksPageProps) {
  const { user: currentUser, hasPermission } = useAuth();
  const [tasks, setTasks] = useState<UnifiedTask[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  // ?taskId=<id> (notification deep links) opens that task's panel on load.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => searchParams.get('taskId'));
  const closeTask = useCallback(() => {
    setSelectedTaskId(null);
    if (searchParams.has('taskId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('taskId');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission('tasks.manage');
  const orgId = currentUser?.organization_id;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTasks = useCallback(async () => {
    if (!currentUser || !orgId) return;
    try {
      setError(null);
      const data = await getMyTasks(currentUser.id, orgId);
      setTasks(data);
    } catch (err) {
      console.error('Failed to load tasks:', err);
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [currentUser, orgId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (!orgId) return;
    getUsers(orgId).then(setUsers).catch(reportBackgroundError('TasksPage.getUsers'));
  }, [orgId]);

  // Realtime: live refresh across all three task tables (A2 spec). RLS on
  // each table still governs what's actually visible after refetch -- this
  // subscription only decides when to refetch, debounced to avoid thrashing
  // on rapid successive writes.
  useEffect(() => {
    if (!orgId) return;

    const debouncedReload = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => loadTasks(), 400);
    };

    const channel = supabase
      .channel(`tasks-hub:${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contact_tasks' }, debouncedReload)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_tasks', filter: `org_id=eq.${orgId}` },
        debouncedReload
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'calendar_tasks', filter: `org_id=eq.${orgId}` },
        debouncedReload
      )
      .subscribe();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      channel.unsubscribe();
    };
  }, [orgId, loadTasks]);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  async function handleToggleComplete(task: UnifiedTask) {
    if (!currentUser) return;
    const next: UnifiedTaskStatus = task.status === 'completed' ? 'todo' : 'completed';
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
    try {
      await updateTaskStatus(task, next, currentUser);
    } catch (err) {
      console.error(err);
      loadTasks();
    }
  }

  async function handleKanbanStatusChange(task: UnifiedTask, status: UnifiedTaskStatus) {
    if (!currentUser) return;
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status } : t)));
    try {
      await updateTaskStatus(task, status, currentUser);
    } catch (err) {
      console.error(err);
      loadTasks();
    }
  }

  async function handleSaveTask(updates: {
    title: string;
    description: string | null;
    status: UnifiedTaskStatus;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    dueDate: string | null;
    assignedUserId: string | null;
  }) {
    if (!currentUser || !selectedTask) return;
    setSaving(true);
    try {
      const dueDate =
        selectedTask.parentType === 'personal' && updates.dueDate
          ? new Date(`${updates.dueDate}T09:00`).toISOString()
          : updates.dueDate;

      await updateUnifiedTaskFields(
        selectedTask,
        {
          title: updates.title,
          description: updates.description,
          dueDate,
          priority: updates.priority,
          assignedUserId: updates.assignedUserId,
        },
        currentUser
      );
      if (updates.status !== selectedTask.status) {
        await updateTaskStatus(selectedTask, updates.status, currentUser);
      }
      await loadTasks();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTask() {
    if (!currentUser || !selectedTask) return;
    try {
      await deleteUnifiedTask(selectedTask, currentUser);
      setSelectedTaskId(null);
      await loadTasks();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to delete task');
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full py-24">
        <Loader2 className="w-8 h-8 text-hud-gold animate-spin" />
      </div>
    );
  }

  const viewToggle = (
    <div className="flex items-center gap-1 bg-hud-bg-card border border-hud-bg-elev rounded-lg p-1">
      <button
        onClick={() => setViewMode('list')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
          viewMode === 'list' ? 'bg-hud-gold-deep text-white' : 'text-hud-cream-dim hover:text-white'
        }`}
      >
        <List className="w-3.5 h-3.5" />
        List
      </button>
      <button
        onClick={() => setViewMode('kanban')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
          viewMode === 'kanban' ? 'bg-hud-gold-deep text-white' : 'text-hud-cream-dim hover:text-white'
        }`}
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        Kanban
      </button>
    </div>
  );

  return (
    <div className={`h-full flex flex-col ${embedded ? 'p-4' : 'p-6'}`}>
      {embedded ? (
        <div className="flex items-center justify-between gap-3 mb-4">
          {viewToggle}
          {canManage && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all flex items-center gap-2 font-medium text-sm shadow-lg shadow-hud-gold/25"
            >
              <Plus className="w-4 h-4" />
              New Task
            </button>
          )}
        </div>
      ) : (
        <PageHeader
          title="Tasks"
          subtitle="Everything assigned to you or created by you, across contacts, projects, and your calendar"
          icon={CheckSquare}
          primaryAction={
            canManage
              ? {
                  label: 'New Task',
                  icon: Plus,
                  onClick: () => setShowCreateModal(true),
                }
              : undefined
          }
        >
          {viewToggle}
        </PageHeader>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-hud-plum shrink-0" />
          <p className="text-sm text-hud-plum/40">{error}</p>
        </div>
      )}

      <div
        className={`flex-1 flex overflow-hidden ${
          embedded ? '' : 'bg-hud-bg-mid/40 border border-hud-bg-card rounded-xl'
        }`}
      >
        <div className={`flex-1 overflow-y-auto p-4 ${selectedTask ? 'hidden md:block' : ''}`}>
          {tasks.length === 0 ? (
            <EmptyState
              icon={CheckSquare}
              title="No tasks"
              description="Nothing assigned to you, and nothing you created yet."
              primaryAction={
                canManage
                  ? { label: 'New Task', onClick: () => setShowCreateModal(true) }
                  : undefined
              }
            />
          ) : viewMode === 'list' ? (
            <TaskListView
              tasks={tasks}
              canManage={canManage}
              selectedTaskId={selectedTaskId}
              onSelect={(task) => setSelectedTaskId(task.id)}
              onToggleComplete={handleToggleComplete}
            />
          ) : (
            <TaskKanbanView
              tasks={tasks}
              canManage={canManage}
              onSelect={(task) => setSelectedTaskId(task.id)}
              onStatusChange={handleKanbanStatusChange}
            />
          )}
        </div>

        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            users={users}
            saving={saving}
            canManage={canManage}
            onSave={handleSaveTask}
            onDelete={handleDeleteTask}
            onClose={closeTask}
          />
        )}
      </div>

      {showCreateModal && (
        <CreateTaskModal
          users={users}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => loadTasks()}
        />
      )}
    </div>
  );
}
