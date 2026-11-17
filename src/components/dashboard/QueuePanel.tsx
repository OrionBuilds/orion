import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, MessageSquare, ClipboardList, Bell, Mail, Smartphone } from 'lucide-react';
import { ConversationQueueItem } from './ConversationQueueItem';
import { TaskQueueItem } from './TaskQueueItem';
import type { AssignedConversation, TaskDue, FlaggedEmail } from '../../services/dashboard';

type QueueTab = 'conversations' | 'tasks' | 'followups';

interface QueuePanelProps {
  conversations: AssignedConversation[];
  tasks: TaskDue[];
  followUps: FlaggedEmail[];
  onConversationClick: (conversation: AssignedConversation) => void;
  onTaskClick: (task: TaskDue) => void;
  onFollowUpClick: (item: FlaggedEmail) => void;
  isLoading?: boolean;
}

const tabs: { value: QueueTab; label: string; icon: typeof MessageSquare }[] = [
  { value: 'conversations', label: 'Conversations', icon: MessageSquare },
  { value: 'tasks', label: 'Tasks', icon: ClipboardList },
  { value: 'followups', label: 'Follow-ups', icon: Bell },
];

const viewAllLinks: Record<QueueTab, string> = {
  conversations: '/conversations',
  tasks: '/contacts',
  followups: '/conversations',
};

function formatWhen(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function QueuePanel({
  conversations,
  tasks,
  followUps,
  onConversationClick,
  onTaskClick,
  onFollowUpClick,
  isLoading,
}: QueuePanelProps) {
  const [activeTab, setActiveTab] = useState<QueueTab>('conversations');

  return (
    <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev">
      <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev">
        <h3 className="text-sm font-semibold text-white">My Queue</h3>
        <Link
          to={viewAllLinks[activeTab]}
          className="flex items-center gap-1 text-xs font-medium text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
        >
          View all
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="flex border-b border-hud-bg-elev">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const count =
            tab.value === 'conversations'
              ? conversations.length
              : tab.value === 'tasks'
              ? tasks.length
              : followUps.length;

          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.value
                  ? 'border-hud-gold-soft text-white'
                  : 'border-transparent text-hud-cream-dim hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
              {count > 0 && (
                <span className="px-1.5 py-0.5 bg-hud-bg-elev text-xs rounded">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="p-3 max-h-[400px] overflow-y-auto">
        {isLoading ? (
          <LoadingSkeleton />
        ) : activeTab === 'conversations' ? (
          conversations.length === 0 ? (
            <EmptyState message="No recent conversations" />
          ) : (
            <div className="space-y-1">
              {conversations.map((conversation) => (
                <div key={conversation.id} className="relative">
                  <ConversationQueueItem
                    conversation={conversation}
                    onClick={() => onConversationClick(conversation)}
                  />
                  {(conversation.channel === 'sms' || conversation.channel === 'email') && (
                    <span className="absolute top-2.5 right-2.5 flex items-center gap-1 px-1.5 py-0.5 bg-hud-bg-elev rounded text-[10px] font-medium text-hud-cream-dim uppercase pointer-events-none">
                      {conversation.channel === 'email' ? (
                        <Mail className="h-3 w-3" />
                      ) : (
                        <Smartphone className="h-3 w-3" />
                      )}
                      {conversation.channel}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )
        ) : activeTab === 'tasks' ? (
          tasks.length === 0 ? (
            <EmptyState message="No pending tasks" />
          ) : (
            <div className="space-y-1">
              {tasks.map((task) => (
                <TaskQueueItem key={task.id} task={task} onClick={() => onTaskClick(task)} />
              ))}
            </div>
          )
        ) : followUps.length === 0 ? (
          <EmptyState message="No emails need your attention" />
        ) : (
          <div className="space-y-1">
            {followUps.map((item) => (
              <button
                key={item.id}
                onClick={() => onFollowUpClick(item)}
                className="w-full flex items-start gap-3 p-3 rounded-lg hover:bg-hud-bg-elev/50 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-hud-gold/10 shrink-0">
                  <Mail className="h-4 w-4 text-hud-gold-soft" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{item.title}</p>
                  <p className="text-xs text-hud-cream-mute truncate mt-0.5">
                    {item.metadata?.from ? `${item.metadata.from} · ` : ''}
                    {item.body || 'Flagged by Clara'}
                  </p>
                </div>
                <span className="text-xs text-hud-cream-mute shrink-0">
                  {formatWhen(item.created_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm text-hud-cream-mute">{message}</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 p-3">
          <div className="h-10 w-10 bg-hud-bg-elev rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 bg-hud-bg-elev rounded" />
            <div className="h-3 w-1/2 bg-hud-bg-elev rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
