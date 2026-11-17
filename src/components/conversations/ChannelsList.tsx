import { Users, Hash, RefreshCw, Plus, MessageCircle } from 'lucide-react';
import { ChannelWithDetails } from '../../services/teamMessaging';
import { formatDistanceToNow } from '../../utils/dateUtils';

interface ChannelsListProps {
  channels: ChannelWithDetails[];
  selectedChannelId: string | null;
  loading: boolean;
  refreshing: boolean;
  onSelectChannel: (channel: ChannelWithDetails) => void;
  onRefresh: () => void;
  onNewMessage: () => void;
  onCreateGroup: () => void;
  canCreateGroup: boolean;
}

export function ChannelsList({
  channels,
  selectedChannelId,
  loading,
  refreshing,
  onSelectChannel,
  onRefresh,
  onNewMessage,
  onCreateGroup,
  canCreateGroup,
}: ChannelsListProps) {
  const getChannelDisplay = (channel: ChannelWithDetails) => {
    if (channel.type === 'direct') {
      const otherMember = channel.members?.find(m => m.user_id !== channel.created_by);
      return {
        name: otherMember?.name || 'Unknown User',
        avatar: otherMember?.avatar_url,
        icon: null,
      };
    }

    return {
      name: channel.name || 'Unnamed Group',
      avatar: channel.avatar_url,
      icon: <Hash className="w-4 h-4" />,
    };
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-6 h-6 text-hud-gold animate-spin mx-auto mb-2" />
          <p className="text-sm text-hud-cream-dim">Loading channels...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="p-3 border-b border-hud-bg-elev space-y-2">
        <button
          onClick={onNewMessage}
          className="w-full px-3 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg transition-colors flex items-center justify-center gap-2 text-sm font-medium"
        >
          <MessageCircle size={16} />
          New Message
        </button>
        {canCreateGroup && (
          <button
            onClick={onCreateGroup}
            className="w-full px-3 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-white rounded-lg transition-colors flex items-center justify-center gap-2 text-sm font-medium"
          >
            <Plus size={16} />
            Create Group
          </button>
        )}
      </div>

      <div className="flex items-center justify-between p-3 border-b border-hud-bg-elev">
        <h3 className="text-sm font-medium text-white">Messages</h3>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="p-1 rounded hover:bg-hud-bg-elev text-hud-cream-dim hover:text-white transition-colors disabled:opacity-50"
          title="Refresh channels"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {channels.length === 0 ? (
          <div className="p-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-hud-bg-card flex items-center justify-center mx-auto mb-3">
              <MessageCircle className="w-6 h-6 text-hud-cream-mute" />
            </div>
            <p className="text-sm text-hud-cream-dim mb-1">No conversations yet</p>
            <p className="text-xs text-hud-cream-mute">
              Click "New Message" to start chatting
            </p>
          </div>
        ) : (
          <div className="divide-y divide-hud-bg-elev">
            {channels.map((channel) => {
              const display = getChannelDisplay(channel);
              const isSelected = channel.id === selectedChannelId;

              return (
                <button
                  key={channel.id}
                  onClick={() => onSelectChannel(channel)}
                  className={`w-full p-3 hover:bg-hud-bg-elev/50 transition-colors text-left ${
                    isSelected ? 'bg-hud-bg-elev/70' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="relative flex-shrink-0">
                      {display.avatar ? (
                        <img
                          src={display.avatar}
                          alt={display.name}
                          className="w-10 h-10 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-hud-gold to-blue-600 flex items-center justify-center">
                          {display.icon || (
                            <span className="text-white text-sm font-medium">
                              {display.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                      )}
                      {channel.type === 'group' && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-hud-bg-card flex items-center justify-center">
                          <Users className="w-2.5 h-2.5 text-hud-cream-dim" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <h4 className="text-sm font-medium text-white truncate">
                          {display.name}
                        </h4>
                        {channel.last_message && (
                          <span className="text-xs text-hud-cream-mute flex-shrink-0 ml-2">
                            {formatDistanceToNow(new Date(channel.last_message.created_at))}
                          </span>
                        )}
                      </div>
                      {channel.last_message && (
                        <p className="text-xs text-hud-cream-dim truncate">
                          {channel.last_message.is_deleted
                            ? 'Message deleted'
                            : channel.last_message.content}
                        </p>
                      )}
                      {channel.type === 'group' && (
                        <p className="text-xs text-hud-cream-mute mt-1">
                          {channel.member_count} member{channel.member_count !== 1 ? 's' : ''}
                        </p>
                      )}
                    </div>

                    {channel.unread_count > 0 && (
                      <div className="flex-shrink-0 mt-1">
                        <div className="px-2 py-0.5 rounded-full bg-hud-gold-deep text-white text-xs font-medium min-w-[20px] text-center">
                          {channel.unread_count > 99 ? '99+' : channel.unread_count}
                        </div>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
