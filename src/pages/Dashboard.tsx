import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Users,
  Target,
  Calendar,
  RefreshCw,
  UserPlus,
  Send,
  CalendarPlus,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboardData } from '../hooks/useDashboardData';
import { useUserDashboardAnalytics } from '../hooks/useUserDashboardAnalytics';
import { getGreeting, markFlaggedEmailRead, type DateRange } from '../services/dashboard';
import { usePermission } from '../hooks/usePermission';
import {
  StatCard,
  QuickActionButton,
  QueuePanel,
  AppointmentsList,
  CreateContactDrawer,
  ComposeMessageDrawer,
  CreateOpportunityDrawer,
  BookAppointmentDrawer,
  AIReportInsights,
} from '../components/dashboard';
import { TimeRangeSelector, ExportButton } from '../components/analytics';
import { SystemDashboard } from './SystemDashboard';
import { MyDay } from '../components/dashboard/MyDay';
import { EnableNotificationsCard } from '../components/dashboard/EnableNotificationsCard';
import { formatWholeCurrency } from '../utils/formatters';

export function Dashboard() {
  const { user, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = searchParams.get('mode');
  const [refreshing, setRefreshing] = useState(false);
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [composeMessageOpen, setComposeMessageOpen] = useState(false);
  const [createOpportunityOpen, setCreateOpportunityOpen] = useState(false);
  const [bookAppointmentOpen, setBookAppointmentOpen] = useState(false);

  const {
    data: analytics,
    loading: analyticsLoading,
    timeRange,
    startDate,
    endDate,
    setTimeRange,
    refetch: refetchAnalytics,
    exportToPDF,
  } = useUserDashboardAnalytics();

  const dateRange: DateRange = (() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endDate = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString();
    if (timeRange === 'custom' && startDate && endDate) {
      return { label: 'Custom', startDate, endDate };
    }
    const days = timeRange === '7d' ? 7 : timeRange === '90d' ? 90 : 30;
    return {
      label: `Last ${days} Days`,
      startDate: new Date(today.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
      endDate,
    };
  })();

  const {
    stats,
    conversations,
    tasks,
    followUps,
    appointments,
    googleConnected,
    loading,
    refetch,
  } = useDashboardData(dateRange);

  const canCreateContact = usePermission('contacts.create');
  const canSendMessage = usePermission('conversations.send');
  const canCreateOpportunity = usePermission('opportunities.create');
  const canCreateAppointment = usePermission('appointments.create');

  if (isSuperAdmin && mode === 'system') {
    return <SystemDashboard />;
  }

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([refetch(), refetchAnalytics()]);
    setTimeout(() => setRefreshing(false), 500);
  }

  function handleDrawerSuccess() {
    refetch();
    refetchAnalytics();
  }

  function formatNextAppointment(): string | undefined {
    if (!stats?.nextAppointmentTime) return undefined;
    const date = new Date(stats.nextAppointmentTime);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isTomorrow =
      date.toDateString() === new Date(now.getTime() + 86400000).toDateString();

    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return `Next: Today ${time}`;
    if (isTomorrow) return `Next: Tomorrow ${time}`;
    return `Next: ${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  const isLoading = loading.stats || analyticsLoading;

  return (
    <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6">
      <EnableNotificationsCard />
      {/* My day replaces the phone-only NeedsYouStrip: approvals, unread, calendar and Clara are all in it. */}
      <MyDay />
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-white">
            {getGreeting()}, {user?.name?.split(' ')[0]}
          </h1>
          <p className="text-hud-cream-dim mt-1 text-sm">Here's what's happening today.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isSuperAdmin && (
            <div className="flex items-center bg-hud-bg-card border border-hud-bg-elev rounded-lg p-1">
              <button className="px-3 py-1.5 text-sm text-white bg-hud-bg-elev rounded touch-manipulation">
                User
              </button>
              <button
                onClick={() => setSearchParams({ mode: 'system' })}
                className="px-3 py-1.5 text-sm text-hud-cream-dim hover:text-white transition-colors rounded touch-manipulation"
              >
                System
              </button>
            </div>
          )}
          <TimeRangeSelector
            value={timeRange}
            onChange={setTimeRange}
            startDate={startDate}
            endDate={endDate}
          />
          <ExportButton onExport={exportToPDF} disabled={!analytics} />
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white hover:bg-hud-bg-elev transition-colors disabled:opacity-50 touch-manipulation"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          title="Total Contacts"
          value={analytics?.contacts.total ?? stats?.totalContacts ?? '--'}
          delta={analytics?.contacts.newInPeriod.deltaPercent}
          deltaType={
            analytics?.contacts.newInPeriod.trend === 'up'
              ? 'positive'
              : analytics?.contacts.newInPeriod.trend === 'down'
              ? 'negative'
              : 'neutral'
          }
          sublabel={
            analytics?.contacts.newInPeriod
              ? `+${analytics.contacts.newInPeriod.current} new this period`
              : undefined
          }
          icon={Users}
          accentColor="cyan"
          onClick={() => navigate('/contacts')}
          isLoading={isLoading}
        />
        <StatCard
          title="Open Opportunities"
          value={analytics?.opportunities.open ?? stats?.activeOpportunities ?? '--'}
          delta={analytics?.opportunities.winRate.deltaPercent}
          deltaType={
            analytics?.opportunities.winRate.trend === 'up'
              ? 'positive'
              : analytics?.opportunities.winRate.trend === 'down'
              ? 'negative'
              : 'neutral'
          }
          sublabel={
            analytics?.opportunities.pipelineValue
              ? `${formatWholeCurrency(analytics.opportunities.pipelineValue.current)} pipeline`
              : undefined
          }
          icon={Target}
          accentColor="amber"
          onClick={() => navigate('/opportunities')}
          isLoading={isLoading}
        />
        <StatCard
          title="Upcoming Appointments"
          value={analytics?.appointments.upcoming ?? stats?.upcomingAppointments ?? '--'}
          delta={analytics?.appointments.completedInPeriod.deltaPercent}
          deltaType={
            analytics?.appointments.completedInPeriod.trend === 'up'
              ? 'positive'
              : analytics?.appointments.completedInPeriod.trend === 'down'
              ? 'negative'
              : 'neutral'
          }
          sublabel={formatNextAppointment()}
          icon={Calendar}
          accentColor="rose"
          onClick={() => navigate('/calendars')}
          isLoading={isLoading}
        />
      </div>

      <div>
        <h2 className="text-sm font-medium text-hud-cream-dim mb-3">Quick Actions</h2>
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-3 sm:justify-center">
          <QuickActionButton
            icon={UserPlus}
            label="Add Contact"
            onClick={() => setCreateContactOpen(true)}
            disabled={!canCreateContact}
            iconColor="text-hud-gold-soft"
          />
          <QuickActionButton
            icon={Send}
            label="New Message"
            onClick={() => setComposeMessageOpen(true)}
            disabled={!canSendMessage}
            iconColor="text-hud-teal"
          />
          <QuickActionButton
            icon={Target}
            label="Create Opportunity"
            onClick={() => setCreateOpportunityOpen(true)}
            disabled={!canCreateOpportunity}
            iconColor="text-hud-rust"
          />
          <QuickActionButton
            icon={CalendarPlus}
            label="Book Appointment"
            onClick={() => setBookAppointmentOpen(true)}
            disabled={!canCreateAppointment}
            iconColor="text-rose-400"
          />
        </div>
      </div>

      <AIReportInsights />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <QueuePanel
          conversations={conversations}
          tasks={tasks}
          followUps={followUps}
          onConversationClick={(conv) => navigate(`/conversations?id=${conv.id}`)}
          onTaskClick={(task) => navigate(`/contacts/${task.contact_id}`)}
          onFollowUpClick={(item) => {
            markFlaggedEmailRead(item.id).finally(() => refetch());
            if (item.link) {
              window.open(item.link, '_blank', 'noopener,noreferrer');
            } else {
              navigate('/conversations');
            }
          }}
          isLoading={loading.conversations || loading.tasks || loading.followUps}
        />
        <AppointmentsList appointments={appointments} googleConnected={googleConnected} isLoading={loading.appointments} />
      </div>

      <CreateContactDrawer
        open={createContactOpen}
        onClose={() => setCreateContactOpen(false)}
        onSuccess={handleDrawerSuccess}
      />
      <ComposeMessageDrawer
        open={composeMessageOpen}
        onClose={() => setComposeMessageOpen(false)}
        onSuccess={handleDrawerSuccess}
      />
      <CreateOpportunityDrawer
        open={createOpportunityOpen}
        onClose={() => setCreateOpportunityOpen(false)}
        onSuccess={handleDrawerSuccess}
      />
      <BookAppointmentDrawer
        open={bookAppointmentOpen}
        onClose={() => setBookAppointmentOpen(false)}
        onSuccess={handleDrawerSuccess}
      />
    </div>
  );
}
