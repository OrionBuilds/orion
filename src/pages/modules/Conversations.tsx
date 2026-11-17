import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useDevice } from '../../contexts/DeviceContext';
import { ConversationList } from '../../components/conversations/ConversationList';
import { MessageThread } from '../../components/conversations/MessageThread';
import { ContactPanel } from '../../components/conversations/ContactPanel';
import { ConversationFilters } from '../../components/conversations/ConversationFilters';
import { TeamMessagingTab } from '../../components/conversations/TeamMessagingTab';
import { NewConversationModal } from '../../components/conversations/NewConversationModal';
import { PendingDraftsSection } from '../../components/conversations/PendingDraftsSection';
import { PinnedAgentsList } from '../../components/conversations/PinnedAgentsList';
import { AgentThreadPane } from '../../components/conversations/AgentThreadPane';
import { getPinnedAgentThreads, matchPinnedAgent, type PinnedAgentThread } from '../../services/agentThreads';
import { supabase } from '../../lib/supabase';
import { ConversationErrorBoundary } from '../../components/ConversationErrorBoundary';
import { getConversations, getConversationById, markConversationAsRead, findOrCreateConversation } from '../../services/conversations';
import type { Conversation, ConversationFilters as FilterType } from '../../types';
import { MessageSquare, Filter, Users, Contact as ContactIcon, Plus, ArrowLeft, Search, X } from 'lucide-react';

type ConversationTabType = 'customers' | 'team-messaging';

export function Conversations() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, hasPermission } = useAuth();
  // Single-pane (list, then thread) only on phones. A tablet shows list + thread side by side, with the contact panel in landscape.
  const { device, orientation } = useDevice();
  const isMobile = device === 'phone';
  const showSidePanel = !isMobile && !(device === 'tablet' && orientation === 'portrait');

  const tabParam = searchParams.get('tab') as ConversationTabType | null;
  const [activeTab, setActiveTab] = useState<ConversationTabType>(tabParam === 'team-messaging' ? 'team-messaging' : 'customers');
  const legacyIdParam = searchParams.get('id');
  const agentParam = searchParams.get('agent');
  const channelParam = searchParams.get('channel');

  // Pinned agent threads (org setting). Clara takes instructions only from people allowed to use
  // the assistant, so her thread is hidden from everyone else.
  const [pinnedAgents, setPinnedAgents] = useState<PinnedAgentThread[]>([]);
  const canUseClara = hasPermission('personal_assistant.view');
  useEffect(() => {
    let cancelled = false;
    getPinnedAgentThreads()
      .then((list) => { if (!cancelled) setPinnedAgents(list.filter((a) => a.mode !== 'clara' || canUseClara)); })
      .catch((e) => console.error('Failed to load pinned agents:', e));
    return () => { cancelled = true; };
  }, [user?.id, user?.organization?.id, canUseClara]);
  const selectedAgent = conversationId ? null : matchPinnedAgent(pinnedAgents, agentParam);

  // Deep links: /conversations?id=<conversation> (notifications, dashboard, assignment links)
  // opens that thread; ?tab=team-messaging&channel=<agent DM> opens the pinned agent thread.
  useEffect(() => {
    if (legacyIdParam && !conversationId) navigate(`/conversations/${legacyIdParam}`, { replace: true });
  }, [legacyIdParam, conversationId, navigate]);
  useEffect(() => {
    setActiveTab(tabParam === 'team-messaging' ? 'team-messaging' : 'customers');
  }, [tabParam]);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);

  const [filters, setFilters] = useState<FilterType>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showContactPanel, setShowContactPanel] = useState(true);
  const [showNewConversationModal, setShowNewConversationModal] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const mobileShowThread = isMobile && (!!conversationId || !!selectedAgent);

  const handleTabChange = (tab: ConversationTabType) => {
    setActiveTab(tab);
    if (tab === 'team-messaging') {
      setSearchParams({ tab: 'team-messaging' });
    } else {
      setSearchParams({});
    }
  };

  const openAgentThread = useCallback((agent: Pick<PinnedAgentThread, 'agent_user_id'>) => {
    navigate(`/conversations?agent=${agent.agent_user_id}`);
  }, [navigate]);

  const loadConversations = useCallback(async (silent = false) => {
    if (!user?.organization_id) return;

    try {
      if (!silent) setLoading(true);
      const { data, count } = await getConversations(user.organization_id, filters, page);
      setConversations(data);
      setTotalCount(count);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [user?.organization_id, filters, page]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Realtime: any conversation change in the org (new inbound, status, assignment, unread)
  // refreshes the list in place, debounced.
  const silentReloadRef = React.useRef(loadConversations);
  silentReloadRef.current = loadConversations;
  useEffect(() => {
    if (!user?.organization_id) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`conversations-list-${user.organization_id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations', filter: `organization_id=eq.${user.organization_id}` },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => silentReloadRef.current(true), 400);
        },
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [user?.organization_id]);

  useEffect(() => {
    async function loadSelectedConversation() {
      if (conversationId) {
        try {
          const conv = await getConversationById(conversationId);
          setSelectedConversation(conv);
          if (conv && conv.unread_count > 0) {
            await markConversationAsRead(conversationId);
            loadConversations(true);
          }
        } catch (error) {
          console.error('Failed to load conversation:', error);
        }
      } else {
        setSelectedConversation(null);
      }
    }
    loadSelectedConversation();
  }, [conversationId, loadConversations]);

  const handleSelectConversation = (conv: Conversation) => {
    navigate(`/conversations/${conv.id}`);
  };

  const handleMobileBack = () => {
    navigate('/conversations');
  };

  const handleFilterChange = (newFilters: FilterType) => {
    setFilters(newFilters);
    setPage(1);
  };

  const handleQuickFilter = (type: 'all' | 'unread' | 'mine' | 'agents') => {
    switch (type) {
      case 'agents':
        setFilters({ agentActivity: true });
        break;
      case 'all':
        setFilters({});
        break;
      case 'unread':
        setFilters({ unreadOnly: true });
        break;
      case 'mine':
        setFilters({ assignedUserId: user?.id });
        break;
    }
    setPage(1);
  };

  const activeFilterCount = Object.keys(filters).filter(
    (key) => filters[key as keyof FilterType] !== undefined && filters[key as keyof FilterType] !== null
  ).length;

  const handleCreateConversation = async (contactId: string) => {
    if (!user?.organization_id) return;

    try {
      setCreatingConversation(true);
      const conversation = await findOrCreateConversation(
        user.organization_id,
        contactId,
        user.department_id
      );

      await loadConversations();
      navigate(`/conversations/${conversation.id}`);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    } finally {
      setCreatingConversation(false);
    }
  };

  const listPanel = (
    <div className={`${isMobile ? 'flex-1 min-w-0' : 'w-96 flex-shrink-0'} border-r border-hud-bg-elev flex flex-col bg-hud-bg-card min-h-0 ${isMobile && mobileShowThread ? 'hidden' : 'flex'}`}>
      <div className="p-4 border-b border-hud-bg-elev flex-shrink-0 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Conversations</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowNewConversationModal(true)}
              className="p-2 rounded-lg hover:bg-hud-gold/20 text-hud-gold-soft transition-colors touch-manipulation"
              title="New conversation"
            >
              <Plus size={18} />
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-2 rounded-lg transition-colors touch-manipulation ${
                showFilters || activeFilterCount > 0
                  ? 'bg-hud-gold/20 text-hud-gold-soft'
                  : 'hover:bg-hud-bg-elev text-hud-cream-dim'
              }`}
            >
              <Filter size={18} />
              {activeFilterCount > 0 && (
                <span className="ml-1 text-xs font-medium">{activeFilterCount}</span>
              )}
            </button>
          </div>
        </div>

        <div className="flex gap-1 overflow-x-auto">
          <button
            onClick={() => handleQuickFilter('all')}
            className={`flex-1 whitespace-nowrap px-3 py-1.5 text-sm rounded-lg transition-colors touch-manipulation ${
              Object.keys(filters).length === 0
                ? 'bg-hud-cream-mute text-white'
                : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
            }`}
          >
            All
          </button>
          <button
            onClick={() => handleQuickFilter('unread')}
            className={`flex-1 whitespace-nowrap px-3 py-1.5 text-sm rounded-lg transition-colors touch-manipulation ${
              filters.unreadOnly
                ? 'bg-hud-cream-mute text-white'
                : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
            }`}
          >
            Unread
          </button>
          <button
            onClick={() => handleQuickFilter('mine')}
            className={`flex-1 whitespace-nowrap px-3 py-1.5 text-sm rounded-lg transition-colors touch-manipulation ${
              filters.assignedUserId === user?.id
                ? 'bg-hud-cream-mute text-white'
                : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
            }`}
          >
            Mine
          </button>
          <button
            onClick={() => handleQuickFilter('agents')}
            title="Agent activity: read-only mirrors of the agents' own SMS lines"
            className={`flex-1 whitespace-nowrap px-3 py-1.5 text-sm rounded-lg transition-colors touch-manipulation ${
              filters.agentActivity
                ? 'bg-hud-cream-mute text-white'
                : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
            }`}
          >
            Agent activity
          </button>
        </div>

        <div className="relative mt-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-mute" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              const val = e.target.value;
              setSearchQuery(val);
              if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
              searchTimeoutRef.current = setTimeout(() => {
                handleFilterChange({ ...filters, search: val || undefined });
              }, 300);
            }}
            placeholder="Search contacts..."
            className="w-full pl-9 pr-8 py-2 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-1 focus:ring-hud-gold focus:border-hud-gold transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery('');
                handleFilterChange({ ...filters, search: undefined });
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-hud-bg-elev rounded text-hud-cream-dim hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <PinnedAgentsList
        agents={pinnedAgents}
        selectedAgentId={selectedAgent?.agent_user_id ?? null}
        onSelect={openAgentThread}
      />

      <PendingDraftsSection
        selectedConversationId={conversationId}
        onSelectConversation={(id) => navigate(`/conversations/${id}`)}
      />

      {showFilters && (
        <ConversationFilters
          filters={filters}
          onChange={handleFilterChange}
          onClose={() => setShowFilters(false)}
        />
      )}

      <ConversationList
        conversations={conversations}
        selectedId={conversationId}
        loading={loading}
        onSelect={handleSelectConversation}
        totalCount={totalCount}
        page={page}
        onPageChange={setPage}
      />
    </div>
  );

  const threadPanel = (
    <ConversationErrorBoundary
      key={`thread-${selectedAgent ? `agent-${selectedAgent.agent_user_id}` : selectedConversation?.id}`}
      onRetry={() => loadConversations()}
    >
      <div className={`flex-1 flex flex-col bg-hud-bg-mid min-h-0 min-w-0 ${isMobile && !mobileShowThread ? 'hidden' : 'flex'}`}>
        {isMobile && mobileShowThread && (
          <div className="flex items-center gap-3 px-4 py-3 border-b border-hud-bg-elev bg-hud-bg-card flex-shrink-0">
            <button
              onClick={handleMobileBack}
              className="p-1.5 rounded-lg text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev transition-colors touch-manipulation"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <span className="text-sm font-medium text-white truncate">
              {selectedAgent ? selectedAgent.name : ((selectedConversation?.contact
                ? `${selectedConversation.contact.first_name || ''} ${selectedConversation.contact.last_name || ''}`.trim()
                : '') || 'Conversation')}
            </span>
          </div>
        )}
        {selectedAgent ? (
          <AgentThreadPane key={selectedAgent.agent_user_id} agent={selectedAgent} />
        ) : selectedConversation ? (
          <MessageThread
            conversation={selectedConversation}
            onConversationUpdate={loadConversations}
            onToggleContactPanel={() => setShowContactPanel(!showContactPanel)}
            showContactPanel={showContactPanel}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-full bg-hud-bg-card flex items-center justify-center mx-auto mb-4">
                <MessageSquare className="w-8 h-8 text-hud-cream-mute" />
              </div>
              <h3 className="text-lg font-medium text-white mb-1">
                Select a conversation
              </h3>
              <p className="text-hud-cream-dim">
                Choose a conversation from the list to view messages
              </p>
            </div>
          </div>
        )}
      </div>
    </ConversationErrorBoundary>
  );

  return (
    <div className="-m-3 sm:-m-4 md:-m-6 h-[calc(100dvh-64px-var(--safe-top)-var(--bottom-nav))] flex flex-col bg-hud-bg-mid relative isolate overflow-hidden">
      <div className="border-b border-hud-bg-elev bg-hud-bg-card px-4 flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleTabChange('customers')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors touch-manipulation ${
              activeTab === 'customers'
                ? 'border-hud-gold text-hud-gold-soft'
                : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft'
            }`}
          >
            <ContactIcon size={18} />
            <span>Customers</span>
          </button>
          <button
            onClick={() => handleTabChange('team-messaging')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors touch-manipulation ${
              activeTab === 'team-messaging'
                ? 'border-hud-gold text-hud-gold-soft'
                : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft'
            }`}
          >
            <Users size={18} />
            <span>Team</span>
          </button>
        </div>
      </div>

      {activeTab === 'team-messaging' ? (
        <TeamMessagingTab
          initialChannelId={channelParam}
          onOpenAgentThread={(agentUserId) => openAgentThread({ agent_user_id: agentUserId })}
        />
      ) : (
        <div className="flex-1 flex min-h-0 min-w-0">
          {listPanel}

          {!isMobile && threadPanel}
          {isMobile && threadPanel}

          {!selectedAgent && selectedConversation && showContactPanel && showSidePanel && (
            <ConversationErrorBoundary
              key={`contact-${selectedConversation?.id}`}
            >
              <div className="w-80 border-l border-hud-bg-elev bg-hud-bg-card overflow-hidden">
                <ContactPanel
                  conversation={selectedConversation}
                  onClose={() => setShowContactPanel(false)}
                />
              </div>
            </ConversationErrorBoundary>
          )}
        </div>
      )}

      {showNewConversationModal && (
        <NewConversationModal
          onClose={() => setShowNewConversationModal(false)}
          onSelectContact={handleCreateConversation}
        />
      )}
    </div>
  );
}
