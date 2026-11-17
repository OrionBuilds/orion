import { useState, useRef, useEffect } from 'react';
import { MessageCircle, ChevronLeft, ChevronRight, UserPlus, CheckCircle, XCircle, Trash2, Eye, EyeOff, CheckSquare, Square, X } from 'lucide-react';
import { ChannelIcon } from './ChannelIcon';
import { useAuth } from '../../contexts/AuthContext';
import type { Conversation, MessageChannel } from '../../types';
import { getInitials, getAvatarColor } from '../../utils/formatters';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  loading: boolean;
  onSelect: (conversation: Conversation) => void;
  totalCount: number;
  page: number;
  onPageChange: (page: number) => void;
  onRefresh?: () => void;
  onBulkAction?: (action: BulkAction, ids: string[]) => Promise<void>;
}

export type BulkAction = 'mark_read' | 'mark_unread' | 'close' | 'reopen' | 'delete';

const PAGE_SIZE = 50;

export function ConversationList({
  conversations,
  selectedId,
  loading,
  onSelect,
  totalCount,
  page,
  onPageChange,
  onBulkAction,
}: ConversationListProps) {
  const { hasPermission } = useAuth();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState(false);
  const [processingBulk, setProcessingBulk] = useState(false);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const canManage = hasPermission('conversations.manage');
  const canDelete = hasPermission('conversations.delete');

  const toggleSelectAll = () => {
    if (selectedIds.size === conversations.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(conversations.map((c) => c.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkAction = async (action: BulkAction) => {
    if (!onBulkAction || selectedIds.size === 0) return;
    try {
      setProcessingBulk(true);
      await onBulkAction(action, Array.from(selectedIds));
      setSelectedIds(new Set());
      setBulkMode(false);
    } catch (error) {
      console.error('Bulk action failed:', error);
    } finally {
      setProcessingBulk(false);
    }
  };

  const exitBulkMode = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
  };

  if (loading && conversations.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="p-4 border-b border-hud-bg-elev animate-pulse">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-hud-bg-elev rounded-full" />
              <div className="flex-1">
                <div className="h-4 bg-hud-bg-elev rounded w-32 mb-2" />
                <div className="h-3 bg-hud-cream-mute rounded w-48" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <MessageCircle className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
          <p className="text-hud-cream-dim text-sm">No conversations found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {canManage && (
        <div className="p-2 border-b border-hud-bg-elev flex items-center justify-between">
          {bulkMode ? (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleSelectAll}
                  className="p-1 hover:bg-hud-bg-elev rounded transition-colors"
                >
                  {selectedIds.size === conversations.length ? (
                    <CheckSquare size={18} className="text-hud-gold-soft" />
                  ) : (
                    <Square size={18} className="text-hud-cream-dim" />
                  )}
                </button>
                <span className="text-sm text-hud-cream-soft">
                  {selectedIds.size} selected
                </span>
              </div>
              <button
                onClick={exitBulkMode}
                className="p-1 hover:bg-hud-bg-elev rounded transition-colors"
              >
                <X size={18} className="text-hud-cream-dim" />
              </button>
            </>
          ) : (
            <button
              onClick={() => setBulkMode(true)}
              className="text-xs text-hud-cream-dim hover:text-hud-cream-soft transition-colors"
            >
              Select multiple
            </button>
          )}
        </div>
      )}

      {bulkMode && selectedIds.size > 0 && (
        <div className="p-2 border-b border-hud-bg-elev bg-hud-bg-card/80 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-hud-cream-dim">Actions:</span>
          <button
            onClick={() => handleBulkAction('mark_read')}
            disabled={processingBulk}
            className="px-2 py-1 text-xs bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-hud-cream-soft rounded transition-colors"
          >
            Mark read
          </button>
          <button
            onClick={() => handleBulkAction('mark_unread')}
            disabled={processingBulk}
            className="px-2 py-1 text-xs bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-hud-cream-soft rounded transition-colors"
          >
            Mark unread
          </button>
          <button
            onClick={() => handleBulkAction('close')}
            disabled={processingBulk}
            className="px-2 py-1 text-xs bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-hud-cream-soft rounded transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => handleBulkAction('reopen')}
            disabled={processingBulk}
            className="px-2 py-1 text-xs bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-hud-cream-soft rounded transition-colors"
          >
            Reopen
          </button>
          {canDelete && (
            <button
              onClick={() => handleBulkAction('delete')}
              disabled={processingBulk}
              className="px-2 py-1 text-xs bg-hud-plum/20 hover:bg-hud-plum/30 disabled:opacity-50 text-hud-plum rounded transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {conversations.map((conversation) => (
          <ConversationListItem
            key={conversation.id}
            conversation={conversation}
            isSelected={conversation.id === selectedId}
            onClick={() => bulkMode ? toggleSelectOne(conversation.id) : onSelect(conversation)}
            bulkMode={bulkMode}
            isChecked={selectedIds.has(conversation.id)}
            onToggleSelect={() => toggleSelectOne(conversation.id)}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="p-3 border-t border-hud-bg-elev flex items-center justify-between text-sm">
          <span className="text-hud-cream-dim">
            {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page === 1}
              className="p-1 rounded hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed text-hud-cream-dim"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page === totalPages}
              className="p-1 rounded hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed text-hud-cream-dim"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ConversationListItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onClick: () => void;
  bulkMode?: boolean;
  isChecked?: boolean;
  onToggleSelect?: () => void;
}

function ConversationListItem({ conversation, isSelected, onClick, bulkMode, isChecked, onToggleSelect }: ConversationListItemProps) {
  const { hasPermission } = useAuth();
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const contact = conversation.contact;
  const contactName = contact
    ? `${contact.first_name} ${contact.last_name}`.trim()
    : 'Unknown';

  const hasMessages = !!conversation.last_message;
  const lastMessagePreview = hasMessages
    ? (previewText(conversation.last_message?.body) || conversation.last_message?.subject || 'No preview available')
    : (conversation.unread_count > 0 ? `${conversation.unread_count} unread message${conversation.unread_count > 1 ? 's' : ''}` : 'No messages yet');
  const truncatedPreview = lastMessagePreview.length > 50
    ? lastMessagePreview.substring(0, 50) + '...'
    : lastMessagePreview;

  const hasUnread = conversation.unread_count > 0;
  const canManage = hasPermission('conversations.manage');
  const canDelete = hasPermission('conversations.delete');

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowContextMenu(false);
      }
    }
    if (showContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showContextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  return (
    <>
      <button
        onClick={onClick}
        onContextMenu={bulkMode ? undefined : handleContextMenu}
        className={`w-full p-4 text-left border-b border-hud-bg-elev hover:bg-hud-bg-elev transition-colors ${
          isSelected && !bulkMode ? 'bg-hud-bg-elev border-l-4 border-l-hud-gold' : 'border-l-4 border-l-transparent'
        } ${isChecked ? 'bg-hud-gold/10' : ''}`}
      >
        <div className="flex items-start gap-3">
          {bulkMode && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect?.();
              }}
              className="mt-1 p-0.5"
            >
              {isChecked ? (
                <CheckSquare size={18} className="text-hud-gold-soft" />
              ) : (
                <Square size={18} className="text-hud-cream-mute" />
              )}
            </button>
          )}
          <div className="relative">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-medium ${
              getAvatarColor(contactName)
            }`}>
              {getInitials(contactName)}
            </div>
            {conversation.assigned_user && !bulkMode && (
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-hud-cream-mute border-2 border-hud-bg-card flex items-center justify-center">
                {conversation.assigned_user.avatar_url ? (
                  <img
                    src={conversation.assigned_user.avatar_url}
                    alt=""
                    className="w-4 h-4 rounded-full"
                  />
                ) : (
                  <span className="text-[8px] font-medium text-hud-cream-soft">
                    {getInitials(conversation.assigned_user.name)}
                  </span>
                )}
              </div>
            )}
            {hasUnread && !bulkMode && (
              <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-hud-gold border-2 border-hud-bg-card" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`truncate ${hasUnread ? 'font-semibold text-white' : 'text-hud-cream-soft'}`}>
                  {contactName}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-hud-cream-mute whitespace-nowrap">
                  {formatRelativeTime(conversation.last_message_at)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {hasMessages ? (
                <ChannelIcon
                  channel={conversation.last_message?.channel as MessageChannel}
                  size="sm"
                />
              ) : (
                <MessageCircle className="w-3.5 h-3.5 text-hud-cream-mute" />
              )}
              <p className={`text-sm truncate flex-1 ${hasUnread ? 'text-hud-cream-soft font-medium' : hasMessages ? 'text-hud-cream-dim' : 'text-hud-cream-mute italic'}`}>
                {truncatedPreview}
              </p>
            </div>

            <div className="flex items-center justify-between mt-1.5">
              <StatusBadge status={conversation.status} />
              {hasUnread && (
                <span className="px-1.5 py-0.5 rounded-full bg-hud-gold/20 text-hud-gold-soft text-xs font-medium">
                  {conversation.unread_count > 9 ? '9+' : conversation.unread_count}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>

      {showContextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-hud-bg-card border border-hud-cream-mute rounded-lg shadow-xl py-1 min-w-[180px]"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
        >
          {canManage && (
            <>
              <ContextMenuItem
                icon={UserPlus}
                label="Assign to..."
                onClick={() => setShowContextMenu(false)}
              />
              <ContextMenuItem
                icon={hasUnread ? EyeOff : Eye}
                label={hasUnread ? 'Mark as read' : 'Mark as unread'}
                onClick={() => setShowContextMenu(false)}
              />
              {conversation.status === 'open' ? (
                <ContextMenuItem
                  icon={XCircle}
                  label="Close conversation"
                  onClick={() => setShowContextMenu(false)}
                />
              ) : (
                <ContextMenuItem
                  icon={CheckCircle}
                  label="Reopen conversation"
                  onClick={() => setShowContextMenu(false)}
                />
              )}
            </>
          )}
          {canDelete && (
            <>
              <div className="border-t border-hud-bg-elev my-1" />
              <ContextMenuItem
                icon={Trash2}
                label="Delete"
                onClick={() => setShowContextMenu(false)}
                danger
              />
            </>
          )}
        </div>
      )}
    </>
  );
}

interface ContextMenuItemProps {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function ContextMenuItem({ icon: Icon, label, onClick, danger }: ContextMenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-hud-bg-elev transition-colors ${
        danger ? 'text-hud-plum hover:text-hud-plum/40' : 'text-hud-cream-soft'
      }`}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors = {
    open: 'bg-hud-emerald/20 text-hud-emerald',
    pending: 'bg-hud-rust/20 text-hud-rust',
    closed: 'bg-hud-cream-mute text-hud-cream-dim',
  };

  return (
    <span className={`px-2 py-0.5 text-xs rounded-full capitalize ${colors[status as keyof typeof colors] || colors.open}`}>
      {status}
    </span>
  );
}
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Email bodies are stored as HTML; the list showed the raw tags ("<p>Hey Dave,</p>"). DOMParser doesn't run scripts. */
function previewText(body: string | null | undefined): string {
  if (!body) return '';
  if (!/<[a-z!/]/i.test(body)) return body;
  // A space at block boundaries so "<p>Hi,</p><p>Thanks" reads "Hi, Thanks".
  const spaced = body.replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, ' $&');
  const text = new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}
