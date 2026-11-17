import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ChannelsList } from './ChannelsList';
import { InternalMessageThread } from './InternalMessageThread';
import { DirectMessageModal } from './DirectMessageModal';
import { CreateGroupModal } from './CreateGroupModal';
import { CreateTaskModal } from '../tasks/CreateTaskModal';
import {
  getUserChannels,
  getChannelMessages,
  sendMessage,
  markChannelAsRead,
  findOrCreateDirectChannel,
  subscribeToChannelMessages,
  subscribeToChannels,
  type ChannelWithDetails,
  type TeamMessage,
  type TeamAttachment,
} from '../../services/teamMessaging';
import { MessageSquare, Loader2 } from 'lucide-react';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../contexts/ToastContext';

interface TeamMessagingTabProps {
  /** Deep link (?tab=team-messaging&channel=<id>): open this channel once the list loads. */
  initialChannelId?: string | null;
  /** Agent DMs live in the pinned agent threads; a deep link to one is handed over to them. */
  onOpenAgentThread?: (agentUserId: string) => void;
}

export function TeamMessagingTab({ initialChannelId, onOpenAgentThread }: TeamMessagingTabProps = {}) {
  const { user } = useAuth();
  const canManageTeamMessaging = usePermission('team_messaging.manage');
  const canManageTasks = usePermission('tasks.manage');
  const { showToast } = useToast();
  const [taskPrefillMessage, setTaskPrefillMessage] = useState<TeamMessage | null>(null);

  const [channels, setChannels] = useState<ChannelWithDetails[]>([]);
  const [allChannels, setAllChannels] = useState<ChannelWithDetails[]>([]);
  const deepLinkHandled = useRef<string | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsRefreshing, setChannelsRefreshing] = useState(false);

  const [selectedChannel, setSelectedChannel] = useState<ChannelWithDetails | null>(null);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesRefreshing, setMessagesRefreshing] = useState(false);

  const [showDirectMessageModal, setShowDirectMessageModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);

  const loadChannels = useCallback(async (showRefreshing = false) => {
    try {
      if (showRefreshing) {
        setChannelsRefreshing(true);
      } else {
        setChannelsLoading(true);
      }

      const data = await getUserChannels();
      setAllChannels(data);
      // Pinned agent threads have their own place at the top of Conversations.
      setChannels(data.filter((c) => !c.agent_user_id));
    } catch (error) {
      console.error('Failed to load channels:', error);
    } finally {
      setChannelsLoading(false);
      setChannelsRefreshing(false);
    }
  }, []);

  const loadMessages = useCallback(
    async (channel: ChannelWithDetails, showRefreshing = false) => {
      try {
        if (showRefreshing) {
          setMessagesRefreshing(true);
        } else {
          setMessagesLoading(true);
        }

        const data = await getChannelMessages(channel.id);
        setMessages(data);

        await markChannelAsRead(channel.id);

        setChannels((prev) =>
          prev.map((c) =>
            c.id === channel.id ? { ...c, unread_count: 0 } : c
          )
        );
      } catch (error) {
        console.error('Failed to load messages:', error);
      } finally {
        setMessagesLoading(false);
        setMessagesRefreshing(false);
      }
    },
    []
  );

  const handleSelectChannel = useCallback(
    (channel: ChannelWithDetails) => {
      setSelectedChannel(channel);
      loadMessages(channel);
    },
    [loadMessages]
  );

  const handleSendMessage = useCallback(
    async (content: string, attachments?: TeamAttachment[]) => {
      if (!selectedChannel) return;

      await sendMessage(selectedChannel.id, content, undefined, attachments);
    },
    [selectedChannel]
  );

  const handleRefreshChannels = useCallback(() => {
    loadChannels(true);
  }, [loadChannels]);

  const handleRefreshMessages = useCallback(() => {
    if (selectedChannel) {
      loadMessages(selectedChannel, true);
    }
  }, [selectedChannel, loadMessages]);

  const handleNewMessage = useCallback(() => {
    setShowDirectMessageModal(true);
  }, []);

  const handleCreateGroup = useCallback(() => {
    setShowCreateGroupModal(true);
  }, []);

  const handleCreateTask = useCallback((message: TeamMessage) => {
    setTaskPrefillMessage(message);
  }, []);

  const handleSelectUser = useCallback(
    async (userId: string) => {
      try {
        const channel = await findOrCreateDirectChannel(userId);
        await loadChannels();

        const channelWithDetails = await getUserChannels();
        const foundChannel = channelWithDetails.find((c) => c.id === channel.id);
        if (foundChannel) {
          handleSelectChannel(foundChannel);
        }
      } catch (error) {
        console.error('Failed to create direct channel:', error);
        alert('Failed to start conversation. Please try again.');
      }
    },
    [loadChannels, handleSelectChannel]
  );

  const handleGroupCreated = useCallback(
    async (channelId: string) => {
      await loadChannels();

      const channelWithDetails = await getUserChannels();
      const foundChannel = channelWithDetails.find((c) => c.id === channelId);
      if (foundChannel) {
        handleSelectChannel(foundChannel);
      }
    },
    [loadChannels, handleSelectChannel]
  );

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (!initialChannelId || channelsLoading || deepLinkHandled.current === initialChannelId) return;
    const target = allChannels.find((c) => c.id === initialChannelId);
    if (!target) return;
    deepLinkHandled.current = initialChannelId;
    if (target.agent_user_id && onOpenAgentThread) {
      onOpenAgentThread(target.agent_user_id);
    } else {
      handleSelectChannel(target);
    }
  }, [initialChannelId, channelsLoading, allChannels, onOpenAgentThread, handleSelectChannel]);

  useEffect(() => {
    if (!user?.id) return;

    const unsubscribeChannels = subscribeToChannels(
      user.id,
      (event, channelId) => {
        if (event === 'new' || event === 'update') {
          loadChannels(true);
        } else if (event === 'delete') {
          setChannels((prev) => prev.filter((c) => c.id !== channelId));
          if (selectedChannel?.id === channelId) {
            setSelectedChannel(null);
            setMessages([]);
          }
        }
      }
    );

    return () => unsubscribeChannels();
  }, [user?.id, selectedChannel, loadChannels]);

  useEffect(() => {
    if (!selectedChannel) return;

    const unsubscribeMessages = subscribeToChannelMessages(
      selectedChannel.id,
      (newMessage) => {
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === newMessage.id);
          if (exists) return prev;
          return [...prev, newMessage];
        });

        if (newMessage.sender_id !== user?.id) {
          markChannelAsRead(selectedChannel.id);
          const senderName = (newMessage as any).sender?.name || 'Someone';
          showToast('message', `New message from ${senderName}`, newMessage.content?.slice(0, 80));
        }

        setChannels((prev) =>
          prev.map((c) => {
            if (c.id === selectedChannel.id) {
              return {
                ...c,
                last_message: newMessage,
                unread_count: newMessage.sender_id === user?.id ? 0 : c.unread_count,
              };
            }
            return c;
          })
        );
      }
    );

    return () => unsubscribeMessages();
  }, [selectedChannel, user?.id]);

  if (channelsLoading && !channelsRefreshing) {
    return (
      <div className="flex-1 flex items-center justify-center bg-hud-bg-mid">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-hud-gold animate-spin mx-auto mb-4" />
          <p className="text-hud-cream-dim">Loading team messaging...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 flex bg-hud-bg-mid">
        <div className="w-72 border-r border-hud-bg-elev flex flex-col bg-hud-bg-card">
          <ChannelsList
            channels={channels}
            selectedChannelId={selectedChannel?.id || null}
            loading={channelsLoading}
            refreshing={channelsRefreshing}
            onSelectChannel={handleSelectChannel}
            onRefresh={handleRefreshChannels}
            onNewMessage={handleNewMessage}
            onCreateGroup={handleCreateGroup}
            canCreateGroup={canManageTeamMessaging}
          />
        </div>

        <div className="flex-1 flex flex-col">
          {selectedChannel ? (
            <InternalMessageThread
              channel={selectedChannel}
              messages={messages}
              loading={messagesLoading}
              refreshing={messagesRefreshing}
              onSendMessage={handleSendMessage}
              onRefresh={handleRefreshMessages}
              onCreateTask={canManageTasks ? handleCreateTask : undefined}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-hud-bg-card flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="w-8 h-8 text-hud-cream-mute" />
                </div>
                <h3 className="text-lg font-medium text-white mb-1">
                  Select a conversation
                </h3>
                <p className="text-hud-cream-dim">
                  Choose a conversation to view messages
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <DirectMessageModal
        isOpen={showDirectMessageModal}
        onClose={() => setShowDirectMessageModal(false)}
        onSelectUser={handleSelectUser}
      />

      <CreateGroupModal
        isOpen={showCreateGroupModal}
        onClose={() => setShowCreateGroupModal(false)}
        onGroupCreated={handleGroupCreated}
      />

      {taskPrefillMessage && (
        <CreateTaskModal
          prefill={{
            title: taskPrefillMessage.content?.slice(0, 120),
            description: taskPrefillMessage.content,
            originType: 'team_message',
            originId: taskPrefillMessage.id,
          }}
          onClose={() => setTaskPrefillMessage(null)}
          onCreated={() => setTaskPrefillMessage(null)}
        />
      )}
    </>
  );
}
