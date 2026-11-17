import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, MessageSquare, User as UserIcon, FolderKanban, Home } from 'lucide-react';
import type { UnifiedTask } from '../../services/tasksHub';
import { groupTasksByDueDate } from '../../services/tasksHub';

interface TaskListViewProps {
  tasks: UnifiedTask[];
  canManage: boolean;
  selectedTaskId: string | null;
  onSelect: (task: UnifiedTask) => void;
  onToggleComplete: (task: UnifiedTask) => void;
}

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

/** Rendered even when empty. Hiding empty sections made a list showing only "Done" look
 *  like the other buckets had failed to load — the Kanban view says "No tasks" per column,
 *  and this now matches that. */
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-3 mt-6 mb-2 first:mt-0">
      <h3 className={`text-xs font-semibold uppercase tracking-wide ${count === 0 ? 'text-hud-cream-mute' : 'text-hud-cream-dim'}`}>{label}</h3>
      <span className="text-xs text-hud-cream-mute">{count}</span>
      <div className="flex-1 h-px bg-hud-bg-card" />
    </div>
  );
}

function EmptySection() {
  return <p className="px-3 py-2 text-xs text-hud-cream-mute italic">No tasks</p>;
}

export function TaskListView({ tasks, canManage, selectedTaskId, onSelect, onToggleComplete }: TaskListViewProps) {
  const { overdue, today, upcoming, noDueDate, done } = groupTasksByDueDate(tasks);

  if (tasks.length === 0) {
    return (
      <div className="text-center py-16 text-hud-cream-mute text-sm">
        No tasks yet. Nothing assigned to you, and nothing you created.
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <SectionHeader label="Overdue" count={overdue.length} />
      {overdue.length === 0 && <EmptySection />}
      {overdue.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          canManage={canManage}
          isSelected={selectedTaskId === task.id}
          overdue
          onSelect={onSelect}
          onToggleComplete={onToggleComplete}
        />
      ))}

      <SectionHeader label="Today" count={today.length} />
      {today.length === 0 && <EmptySection />}
      {today.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          canManage={canManage}
          isSelected={selectedTaskId === task.id}
          onSelect={onSelect}
          onToggleComplete={onToggleComplete}
        />
      ))}

      <SectionHeader label="Upcoming" count={upcoming.length} />
      {upcoming.length === 0 && <EmptySection />}
      {upcoming.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          canManage={canManage}
          isSelected={selectedTaskId === task.id}
          onSelect={onSelect}
          onToggleComplete={onToggleComplete}
        />
      ))}

      <SectionHeader label="No Due Date" count={noDueDate.length} />
      {noDueDate.length === 0 && <EmptySection />}
      {noDueDate.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          canManage={canManage}
          isSelected={selectedTaskId === task.id}
          onSelect={onSelect}
          onToggleComplete={onToggleComplete}
        />
      ))}

      <SectionHeader label="Done" count={done.length} />
      {done.length === 0 && <EmptySection />}
      {done.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          canManage={canManage}
          isSelected={selectedTaskId === task.id}
          onSelect={onSelect}
          onToggleComplete={onToggleComplete}
        />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  canManage,
  isSelected,
  overdue,
  onSelect,
  onToggleComplete,
}: {
  task: UnifiedTask;
  canManage: boolean;
  isSelected: boolean;
  overdue?: boolean;
  onSelect: (task: UnifiedTask) => void;
  onToggleComplete: (task: UnifiedTask) => void;
}) {
  const ParentIcon = PARENT_ICON[task.parentType];
  const isDone = task.status === 'completed' || task.status === 'cancelled';

  return (
    <div
      onClick={() => onSelect(task)}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer group ${
        isSelected ? 'bg-hud-bg-elev/80 ring-1 ring-hud-gold/40' : 'hover:bg-hud-bg-card/50'
      }`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (canManage) onToggleComplete(task);
        }}
        className="shrink-0"
      >
        {task.status === 'completed' ? (
          <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
        ) : (
          <Circle className={`w-4 h-4 ${canManage ? 'text-hud-cream-mute hover:text-hud-emerald' : 'text-hud-cream-mute'}`} />
        )}
      </button>

      <div className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOTS[task.priority] ?? 'bg-hud-cream-mute'}`} />

      <span className={`flex-1 text-sm min-w-0 truncate ${isDone ? 'text-hud-cream-mute line-through' : 'text-white'}`}>
        {task.title}
      </span>

      {task.originType && (
        <span
          title="Created from a message"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-hud-gold/10 text-hud-gold-soft text-[10px] font-medium shrink-0"
        >
          <MessageSquare className="w-2.5 h-2.5" />
          from message
        </span>
      )}

      {task.parentHref ? (
        <Link
          to={task.parentHref}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-xs text-hud-cream-mute hover:text-hud-gold-soft w-28 truncate shrink-0"
          title={task.parentLabel ?? undefined}
        >
          <ParentIcon className="w-3 h-3 shrink-0" />
          <span className="truncate">{task.parentLabel ?? '--'}</span>
        </Link>
      ) : (
        <span className="flex items-center gap-1 text-xs text-hud-cream-mute w-28 truncate shrink-0">
          <ParentIcon className="w-3 h-3 shrink-0" />
          Personal
        </span>
      )}

      {task.assignedUser ? (
        <span className="text-xs text-hud-cream-mute w-24 truncate text-right shrink-0">{task.assignedUser.name}</span>
      ) : (
        <span className="w-24 shrink-0" />
      )}

      {task.dueDateOnly ? (
        <span className={`text-xs w-20 text-right shrink-0 ${overdue ? 'text-hud-plum' : 'text-hud-cream-mute'}`}>
          {new Date(task.dueDateOnly).toLocaleDateString()}
        </span>
      ) : (
        <span className="w-20 shrink-0" />
      )}
    </div>
  );
}
