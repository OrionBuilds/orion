import { Link } from 'react-router-dom';
import { MessageSquare, User as UserIcon, FolderKanban, Home } from 'lucide-react';
import type { UnifiedTask, UnifiedTaskStatus } from '../../services/tasksHub';

interface TaskKanbanViewProps {
  tasks: UnifiedTask[];
  canManage: boolean;
  onSelect: (task: UnifiedTask) => void;
  onStatusChange: (task: UnifiedTask, status: UnifiedTaskStatus) => void;
}

const COLUMNS: { status: UnifiedTaskStatus; label: string; color: string }[] = [
  { status: 'todo', label: 'To Do', color: 'border-hud-cream-mute' },
  { status: 'in_progress', label: 'In Progress', color: 'border-hud-gold' },
  { status: 'in_review', label: 'In Review', color: 'border-hud-rust' },
  { status: 'completed', label: 'Completed', color: 'border-hud-emerald' },
];

const PRIORITY_DOTS: Record<string, string> = {
  low: 'bg-hud-cream-mute',
  medium: 'bg-blue-500',
  high: 'bg-hud-rust',
  urgent: 'bg-hud-plum',
};

const PARENT_ICON: Record<UnifiedTask['parentType'], typeof UserIcon> = {
  contact: UserIcon,
  project: FolderKanban,
  personal: Home,
};

export function TaskKanbanView({ tasks, canManage, onSelect, onStatusChange }: TaskKanbanViewProps) {
  const active = tasks.filter((t) => t.status !== 'cancelled');

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 h-full overflow-x-auto pb-2">
      {COLUMNS.map((col) => {
        const colTasks = active.filter((t) => t.status === col.status);
        return (
          <div key={col.status} className={`flex flex-col min-w-[240px] bg-hud-bg-mid/60 rounded-xl border-t-2 ${col.color}`}>
            <div className="px-3 py-2.5 flex items-center justify-between border-b border-hud-bg-card">
              <span className="text-sm font-medium text-white">{col.label}</span>
              <span className="text-xs text-hud-cream-mute">{colTasks.length}</span>
            </div>
            <div
              className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[120px]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const taskId = e.dataTransfer.getData('text/task-id');
                const task = tasks.find((t) => t.id === taskId);
                if (task && canManage && task.status !== col.status) {
                  onStatusChange(task, col.status);
                }
              }}
            >
              {colTasks.map((task) => {
                const ParentIcon = PARENT_ICON[task.parentType];
                return (
                  <div
                    key={task.id}
                    draggable={canManage}
                    onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
                    onClick={() => onSelect(task)}
                    className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-3 cursor-pointer hover:border-hud-cream-mute transition-colors space-y-2"
                  >
                    <div className="flex items-start gap-2">
                      <div className={`w-2 h-2 rounded-full shrink-0 mt-1 ${PRIORITY_DOTS[task.priority] ?? 'bg-hud-cream-mute'}`} />
                      <p className="text-sm text-white leading-snug flex-1 min-w-0">{task.title}</p>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-hud-cream-mute">
                      {task.parentHref ? (
                        <Link
                          to={task.parentHref}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1 hover:text-hud-gold-soft truncate"
                        >
                          <ParentIcon className="w-3 h-3 shrink-0" />
                          <span className="truncate">{task.parentLabel ?? '--'}</span>
                        </Link>
                      ) : (
                        <span className="flex items-center gap-1 truncate">
                          <ParentIcon className="w-3 h-3 shrink-0" />
                          Personal
                        </span>
                      )}
                      {task.dueDateOnly && <span className="shrink-0">{new Date(task.dueDateOnly).toLocaleDateString()}</span>}
                    </div>
                    <div className="flex items-center justify-between">
                      {task.originType ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-hud-gold/10 text-hud-gold-soft text-[10px] font-medium">
                          <MessageSquare className="w-2.5 h-2.5" />
                          message
                        </span>
                      ) : (
                        <span />
                      )}
                      {task.assignedUser && (
                        <span className="text-[10px] text-hud-cream-mute truncate max-w-[100px]">{task.assignedUser.name}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {colTasks.length === 0 && (
                <div className="text-center py-6 text-xs text-hud-cream-mute">No tasks</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
