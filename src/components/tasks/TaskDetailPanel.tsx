import { useState, useEffect } from 'react';
import { X, Loader2, Save, Trash2, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { resolveOriginHref, type UnifiedTask, type UnifiedTaskStatus } from '../../services/tasksHub';
import type { User } from '../../types';

const STATUS_OPTIONS: { value: UnifiedTaskStatus; label: string }[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

interface TaskDetailPanelProps {
  task: UnifiedTask;
  users: User[];
  saving: boolean;
  canManage: boolean;
  onSave: (updates: {
    title: string;
    description: string | null;
    status: UnifiedTaskStatus;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    dueDate: string | null;
    assignedUserId: string | null;
  }) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TaskDetailPanel({ task, users, saving, canManage, onSave, onDelete, onClose }: TaskDetailPanelProps) {
  const [form, setForm] = useState({
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDateOnly ?? '',
    assignedUserId: task.assignedUserId ?? '',
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [originHref, setOriginHref] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      title: task.title,
      description: task.description ?? '',
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDateOnly ?? '',
      assignedUserId: task.assignedUserId ?? '',
    });
    setConfirmDelete(false);
    setOriginHref(null);
    if (task.originType && task.originId) {
      resolveOriginHref(task.originType, task.originId)
        .then(setOriginHref)
        .catch(() => setOriginHref(null));
    }
  }, [task.id, task.originType, task.originId]);

  const statusOptions = task.parentType === 'personal'
    ? STATUS_OPTIONS.filter((o) => o.value !== 'cancelled' && o.value !== 'in_review')
    : task.parentType === 'contact'
      ? STATUS_OPTIONS.filter((o) => o.value !== 'in_review')
      : STATUS_OPTIONS;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSave({
      title: form.title.trim(),
      description: form.description || null,
      status: form.status,
      priority: form.priority,
      dueDate: form.dueDate || null,
      assignedUserId: form.assignedUserId || null,
    });
  }

  return (
    <div className="w-full md:w-[420px] border-l border-hud-bg-elev/60 flex flex-col bg-hud-bg-mid/40 shrink-0">
      <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev/60">
        <h3 className="text-sm font-semibold text-white">Task Details</h3>
        <button onClick={onClose} className="p-1 text-hud-cream-dim hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
        {task.parentHref && (
          <Link
            to={task.parentHref}
            className="inline-flex items-center gap-1.5 text-xs text-hud-gold-soft hover:text-hud-gold-soft"
          >
            View {task.parentType === 'contact' ? 'contact' : 'project'}: {task.parentLabel}
          </Link>
        )}

        {task.originType && (
          <div className="flex items-center gap-1.5 text-xs text-hud-cream-dim bg-hud-bg-card/60 border border-hud-bg-elev rounded-lg px-3 py-2">
            <MessageSquare className="w-3.5 h-3.5 text-hud-gold-soft shrink-0" />
            <span className="flex-1">
              Created from a {task.originType === 'team_message' ? 'team message' : 'conversation message'}
            </span>
            {originHref && (
              <Link to={originHref} className="text-hud-gold-soft hover:text-hud-gold-soft font-medium shrink-0">
                View
              </Link>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wide">Title</label>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            disabled={!canManage}
            className="w-full bg-hud-bg-card border border-hud-bg-elev rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wide">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            disabled={!canManage}
            rows={3}
            placeholder="Add a description..."
            className="w-full bg-hud-bg-card border border-hud-bg-elev rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60 placeholder-hud-cream-dim"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wide">Status</label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as UnifiedTaskStatus })}
              disabled={!canManage}
              className="w-full bg-hud-bg-card border border-hud-bg-elev rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
            >
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wide">Priority</label>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value as typeof form.priority })}
              disabled={!canManage}
              className="w-full bg-hud-bg-card border border-hud-bg-elev rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              {task.parentType === 'project' && <option value="urgent">Urgent</option>}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wide">Assigned To</label>
            <select
              value={form.assignedUserId}
              onChange={(e) => setForm({ ...form, assignedUserId: e.target.value })}
              disabled={!canManage || task.parentType === 'personal'}
              className="w-full bg-hud-bg-card border border-hud-bg-elev rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
            >
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-hud-cream-dim uppercase tracking-wide">Due Date</label>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              disabled={!canManage}
              className="w-full bg-hud-bg-card border border-hud-bg-elev rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold disabled:opacity-60"
            />
          </div>
        </div>

        <div className="pt-1 pb-2 border-t border-hud-bg-elev/60 space-y-1.5">
          <p className="text-[10px] text-hud-cream-mute uppercase tracking-wide font-medium">Created</p>
          <p className="text-xs text-hud-cream-mute">{new Date(task.createdAt).toLocaleString()}</p>
        </div>
      </form>

      {canManage && (
        <div className="px-5 py-4 border-t border-hud-bg-elev/60 flex items-center justify-between gap-3">
          {confirmDelete ? (
            <div className="flex items-center gap-2 w-full">
              <span className="text-xs text-hud-plum flex-1">Delete this task?</span>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 text-xs bg-hud-bg-elev text-hud-cream-soft rounded-lg hover:bg-hud-cream-mute"
              >
                Cancel
              </button>
              <button
                onClick={onDelete}
                className="px-3 py-1.5 text-xs bg-hud-plum text-white rounded-lg hover:bg-hud-plum"
              >
                Delete
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-hud-plum hover:text-hud-plum/40 hover:bg-hud-plum/10 rounded-lg transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
              <button
                onClick={handleSubmit}
                disabled={saving || !form.title.trim()}
                className="flex items-center gap-2 px-4 py-1.5 text-sm bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 transition-colors ml-auto"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save Changes
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
