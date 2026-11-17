import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Calendar as CalendarIcon, CheckSquare, List, Settings } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { UnifiedCalendarView, AppointmentListView } from '../../components/calendars/views';
import { TasksPage } from './TasksPage';

type CalendarTab = 'calendar' | 'list' | 'tasks';

const tabClass = (active: boolean) =>
  `flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
    active
      ? 'bg-hud-gold text-hud-bg-deep'
      : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white'
  }`;

export function Calendars() {
  const navigate = useNavigate();
  const { hasPermission, isFeatureEnabled } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Tasks used to be its own module (/tasks); it keeps its own permission and flag.
  const canViewTasks = hasPermission('tasks.view') && isFeatureEnabled('tasks');
  const initialAppointmentId = searchParams.get('appointmentId') || undefined;
  const requestedTab = searchParams.get('tab');
  const initialTab: CalendarTab = initialAppointmentId
    ? 'list'
    : requestedTab === 'list' || (requestedTab === 'tasks' && canViewTasks)
      ? requestedTab
      : 'calendar';
  const [activeTab, setActiveTab] = useState<CalendarTab>(initialTab);

  const handleTabChange = (tab: CalendarTab) => {
    setActiveTab(tab);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('tab', tab);
    setSearchParams(newParams, { replace: true });
  };

  const handleSettingsClick = () => {
    navigate('/settings/calendars');
  };

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem-var(--safe-top)-var(--bottom-nav))]">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-2xl font-semibold text-white">Calendars</h1>
        <div className="flex items-center gap-2 overflow-x-auto max-w-full pb-1 -mb-1">
          <button onClick={() => handleTabChange('calendar')} className={tabClass(activeTab === 'calendar')}>
            <CalendarIcon className="w-4 h-4" />
            Calendar View
          </button>
          <button onClick={() => handleTabChange('list')} className={tabClass(activeTab === 'list')}>
            <List className="w-4 h-4" />
            Appointment List View
          </button>
          {canViewTasks && (
            <button onClick={() => handleTabChange('tasks')} className={tabClass(activeTab === 'tasks')}>
              <CheckSquare className="w-4 h-4" />
              Tasks
            </button>
          )}
          <button onClick={handleSettingsClick} className={tabClass(false)}>
            <Settings className="w-4 h-4" />
            Calendar Settings
          </button>
        </div>
      </div>

      <div className="flex-1 bg-hud-bg-mid rounded-xl border border-hud-bg-card overflow-hidden">
        {activeTab === 'calendar' && <UnifiedCalendarView />}
        {activeTab === 'list' && <AppointmentListView initialAppointmentId={initialAppointmentId} />}
        {activeTab === 'tasks' && <TasksPage embedded />}
      </div>
    </div>
  );
}
