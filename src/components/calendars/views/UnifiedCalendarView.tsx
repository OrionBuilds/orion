import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDevice } from '../../../contexts/DeviceContext';
import { PhoneDateStrip } from './PhoneDateStrip';
import { AgendaDayView } from './AgendaDayView';
import { AgendaListView } from './AgendaListView';
import { addDays, addWeeks, addMonths } from '../../../utils/calendarViewUtils';
import { localDayKey, parseLocalDay, syncedEventsNote } from '../../../utils/agenda';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Calendar as CalendarIcon, Plus } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { supabase } from '../../../lib/supabase';
import { getVisibleAppointments, updateAppointment, cancelAppointment } from '../../../services/appointments';
import { getBlockedSlots } from '../../../services/blockedSlots';
import { getCalendarEvents } from '../../../services/calendarEvents';
import { getCalendarTasks } from '../../../services/calendarTasks';
import { getCalendars } from '../../../services/calendars';
import { getUsers } from '../../../services/users';
import { getDepartments } from '../../../services/departments';
import {
  getGoogleCalendarEvents,
  getAllOrgGoogleCalendarEvents,
  getTeamGoogleCalendarEvents,
  triggerIncrementalSync,
  hasGoogleCalendarConnection,
  countUpcomingMirrorEvents,
} from '../../../services/googleCalendarEvents';
import { mergeDisplayItems } from '../../../utils/calendarDisplayItems';
import type {
  Appointment, BlockedSlot, Calendar, User, Department,
  CalendarViewFilter, AppointmentStatus, GoogleCalendarEvent,
  CalendarDisplayItem, CalendarEvent, CalendarTask,
} from '../../../types';
import type { CalendarViewType } from '../../../utils/calendarViewUtils';
import { getDateRangeForView } from '../../../utils/calendarViewUtils';
import { getGoogleErrorMessage } from '../../../utils/googleAuthErrors';
import { DayView } from './DayView';
import { WeekView } from './WeekView';
import { MonthView } from './MonthView';
import { UnifiedCalendarToolbar } from './UnifiedCalendarToolbar';
import { ManageViewPanel } from './ManageViewPanel';
import { AppointmentDetailsModal } from './AppointmentDetailsModal';
import { GoogleEventDetailModal } from './GoogleEventDetailModal';
import { NewAppointmentModal } from './NewAppointmentModal';
import { EditAppointmentModal } from './EditAppointmentModal';
import { NewEventModal } from './NewEventModal';
import { NewTaskModal } from './NewTaskModal';
import { EventDetailModal } from './EventDetailModal';
import { TaskDetailModal } from './TaskDetailModal';
import { CreateCalendarModal } from '../CreateCalendarModal';

export function UnifiedCalendarView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user: currentUser, hasPermission } = useAuth();
  const { showToast } = useToast();
  const isPhone = useDevice().device === 'phone';

  // A phone starts on the agenda (the next two weeks as a list): a week or month grid is too cramped at ~400px.
  const requestedView = searchParams.get('view');
  const initialView: CalendarViewType =
    requestedView === 'day' || requestedView === 'week' || requestedView === 'month' || requestedView === 'agenda'
      ? requestedView
      : isPhone ? 'agenda' : 'month';
  // ?date= is a local day: `new Date('YYYY-MM-DD')` is UTC midnight, i.e. the evening before in the Americas.
  const initialDate = parseLocalDay(searchParams.get('date')) ?? new Date();
  const initialCalendarIds = searchParams.get('calendars')?.split(',').filter(Boolean) || [];

  const [isLoading, setIsLoading] = useState(true);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlot[]>([]);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarTasks, setCalendarTasks] = useState<CalendarTask[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isCreateCalendarOpen, setIsCreateCalendarOpen] = useState(false);
  const [hasGoogleConnection, setHasGoogleConnection] = useState(false);
  // Mirrored events from today onward at any distance (null = not known): the agenda's "nothing synced" note.
  const [mirrorUpcoming, setMirrorUpcoming] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showGoogleEvents, setShowGoogleEvents] = useState(true);

  const [viewType, setViewType] = useState<CalendarViewType>(initialView);
  const [currentDate, setCurrentDate] = useState<Date>(initialDate);
  const [isManageViewOpen, setIsManageViewOpen] = useState(false);

  const [viewFilter, setViewFilter] = useState<CalendarViewFilter>('all');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>(initialCalendarIds);

  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null);
  const [selectedGoogleEvent, setSelectedGoogleEvent] = useState<GoogleCalendarEvent | null>(null);
  const [selectedCalendarEvent, setSelectedCalendarEvent] = useState<CalendarEvent | null>(null);
  const [selectedCalendarTask, setSelectedCalendarTask] = useState<CalendarTask | null>(null);
  const [isNewAppointmentOpen, setIsNewAppointmentOpen] = useState(false);
  const [isNewEventOpen, setIsNewEventOpen] = useState(false);
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);

  const canEdit = hasPermission('appointments.edit');
  const canCreate = hasPermission('appointments.create');

  const isAdmin = currentUser?.role?.name === 'SuperAdmin' || currentUser?.role?.name === 'Admin';
  const isManager = currentUser?.role?.name === 'Manager';

  const dateRange = useMemo(
    () => getDateRangeForView(currentDate, viewType),
    [currentDate, viewType]
  );

  const handleSyncGoogle = useCallback(async () => {
    if (isSyncing || !hasGoogleConnection) return;
    setIsSyncing(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const result = await triggerIncrementalSync();
      console.log('Google Calendar sync result:', result);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.warn('Google sync timed out, data may still be loading');
      } else if (err instanceof TypeError && err.message === 'Failed to fetch') {
        console.warn('Google sync request failed (network or timeout)');
      } else {
        console.error('Google sync failed:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        const errInfo = getGoogleErrorMessage(errMsg, 'calendar');
        showToast('warning', errInfo.title, errInfo.description);
      }
    } finally {
      clearTimeout(timeout);
      setIsSyncing(false);
    }
  }, [isSyncing, hasGoogleConnection]);

  const loadInitialData = useCallback(async () => {
    if (!currentUser?.organization_id) return;

    try {
      setIsLoading(true);
      const [calendarsData, usersData, departmentsData, hasConnection] = await Promise.all([
        getCalendars(currentUser.organization_id),
        getUsers(),
        getDepartments(currentUser.organization_id),
        hasGoogleCalendarConnection(currentUser.id),
      ]);
      setCalendars(calendarsData);
      setUsers(usersData);
      setDepartments(departmentsData);
      setHasGoogleConnection(hasConnection);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.organization_id, currentUser?.id]);

  const loadCalendarData = useCallback(async () => {
    if (!currentUser?.organization_id) return;

    try {
      const filters = {
        calendarIds: selectedCalendarIds.length > 0 ? selectedCalendarIds : undefined,
        userIds: selectedUserIds.length > 0 ? selectedUserIds : undefined,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      };

      const googleFilters = {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        userIds: selectedUserIds.length > 0 ? selectedUserIds : undefined,
      };

      let googleEventsPromise: Promise<GoogleCalendarEvent[]>;
      if (isAdmin) {
        googleEventsPromise = getAllOrgGoogleCalendarEvents(
          currentUser.organization_id,
          googleFilters
        );
      } else if (isManager && currentUser.department_id) {
        const deptUsers = users
          .filter(u => u.department_id === currentUser.department_id)
          .map(u => u.id);
        const userIds = [...new Set([currentUser.id, ...deptUsers])];
        googleEventsPromise = getTeamGoogleCalendarEvents(
          currentUser.organization_id,
          selectedUserIds.length > 0 ? selectedUserIds : userIds,
          googleFilters
        );
      } else {
        googleEventsPromise = getGoogleCalendarEvents(
          currentUser.organization_id,
          currentUser.id,
          googleFilters
        );
      }

      const [appointmentsData, blockedSlotsData, googleEventsData, eventsData, tasksData] = await Promise.all([
        getVisibleAppointments(currentUser.organization_id, currentUser, filters),
        getBlockedSlots(currentUser.organization_id, filters),
        googleEventsPromise,
        getCalendarEvents(currentUser.organization_id, filters),
        getCalendarTasks(currentUser.organization_id, filters),
      ]);

      setAppointments(appointmentsData);
      setBlockedSlots(blockedSlotsData);
      setGoogleEvents(googleEventsData);
      setCalendarEvents(eventsData);
      setCalendarTasks(tasksData);
    } catch (err) {
      console.error('Failed to load calendar data:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      const errInfo = getGoogleErrorMessage(errMsg, 'calendar');
      showToast('warning', errInfo.title, errInfo.description);
    }
  }, [currentUser, dateRange, selectedCalendarIds, selectedUserIds, isAdmin, isManager, users]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  useEffect(() => {
    if (!isLoading) {
      loadCalendarData();
    }
  }, [loadCalendarData, isLoading]);

  useEffect(() => {
    if (isLoading || viewType !== 'agenda' || !hasGoogleConnection || !currentUser?.organization_id) return;
    let cancelled = false;
    countUpcomingMirrorEvents(currentUser.organization_id, isAdmin ? undefined : [currentUser.id])
      .then((n) => { if (!cancelled) setMirrorUpcoming(n); })
      .catch(() => { if (!cancelled) setMirrorUpcoming(null); });
    return () => { cancelled = true; };
    // googleEvents: recount after a sync or a realtime mirror change reloads the list.
  }, [isLoading, viewType, hasGoogleConnection, currentUser?.organization_id, currentUser?.id, isAdmin, googleEvents]);

  useEffect(() => {
    if (!isLoading && hasGoogleConnection) {
      handleSyncGoogle().then(() => {
        loadCalendarData();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGoogleConnection, isLoading]);

  const realtimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!currentUser?.organization_id || isLoading) return;

    const onMirrorChange = () => {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      realtimeDebounceRef.current = setTimeout(() => {
        loadCalendarData();
      }, 2000);
    };

    // Both calendar mirrors: Outlook (microsoft_calendar_events.organization_id) and Google
    // (google_calendar_events.org_id).
    const channel = supabase
      .channel('calendar-events-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'microsoft_calendar_events',
          filter: `organization_id=eq.${currentUser.organization_id}`,
        },
        onMirrorChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'google_calendar_events',
          filter: `org_id=eq.${currentUser.organization_id}`,
        },
        onMirrorChange
      )
      .subscribe();

    return () => {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.organization_id, isLoading]);


  useEffect(() => {
    const params = new URLSearchParams();
    params.set('view', viewType);
    params.set('date', localDayKey(currentDate));
    if (selectedCalendarIds.length > 0) {
      params.set('calendars', selectedCalendarIds.join(','));
    }
    setSearchParams(params, { replace: true });
  }, [viewType, currentDate, selectedCalendarIds, setSearchParams]);

  const displayItems: CalendarDisplayItem[] = useMemo(() => {
    const showAll = viewFilter === 'all';
    const filteredAppointments = showAll || viewFilter === 'appointments' ? appointments : [];
    const filteredBlocked = showAll || viewFilter === 'blocked_slots' ? blockedSlots : [];
    const filteredGoogle = showGoogleEvents && (showAll || viewFilter === 'google_events') ? googleEvents : [];
    const filteredEvents = showAll || viewFilter === 'events' ? calendarEvents : [];
    const filteredTasks = showAll || viewFilter === 'tasks' ? calendarTasks : [];

    return mergeDisplayItems(filteredAppointments, filteredGoogle, filteredBlocked, filteredEvents, filteredTasks);
  }, [appointments, blockedSlots, googleEvents, calendarEvents, calendarTasks, viewFilter, showGoogleEvents]);

  const handleDateChange = (date: Date) => setCurrentDate(date);

  // Swipe left/right on the grid to move a day / week / month (the agenda is a scrolling list: no swipe).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s0 = swipeStart.current;
    swipeStart.current = null;
    if (!s0 || !isPhone || viewType === 'agenda') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s0.x;
    const dy = t.clientY - s0.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const dir = dx < 0 ? 1 : -1;
    setCurrentDate((d) => (viewType === 'day' ? addDays(d, dir) : viewType === 'week' ? addWeeks(d, dir) : addMonths(d, dir)));
  };
  const handleViewTypeChange = (type: CalendarViewType) => setViewType(type);

  const handleDayClick = (date: Date) => {
    setCurrentDate(date);
    setViewType('day');
  };

  const handleDisplayItemClick = (item: CalendarDisplayItem) => {
    if (item.source === 'crm' && item.originalAppointment) {
      setSelectedAppointment(item.originalAppointment);
    } else if (item.source === 'google' && item.originalGoogleEvent) {
      setSelectedGoogleEvent(item.originalGoogleEvent);
    } else if (item.source === 'event' && item.originalCalendarEvent) {
      setSelectedCalendarEvent(item.originalCalendarEvent);
    } else if (item.source === 'task' && item.originalCalendarTask) {
      setSelectedCalendarTask(item.originalCalendarTask);
    }
  };

  const handleStatusChange = async (status: AppointmentStatus) => {
    if (!selectedAppointment || !currentUser) return;
    try {
      if (status === 'canceled') {
        await cancelAppointment(selectedAppointment.id, undefined, currentUser);
      } else {
        await updateAppointment(selectedAppointment.id, { status }, currentUser);
      }
      await loadCalendarData();
      setSelectedAppointment(null);
    } catch (err) {
      console.error('Failed to update appointment:', err);
    }
  };

  const handleNewAppointmentSuccess = async () => {
    setIsNewAppointmentOpen(false);
    await loadCalendarData();
  };

  const handleEditClick = () => {
    if (selectedAppointment) {
      setEditingAppointment(selectedAppointment);
      setSelectedAppointment(null);
      setIsEditModalOpen(true);
    }
  };

  const handleEditSuccess = async () => {
    setIsEditModalOpen(false);
    setEditingAppointment(null);
    await loadCalendarData();
  };

  const handleGoogleEventUpdated = async () => {
    setSelectedGoogleEvent(null);
    await loadCalendarData();
  };

  const handleCalendarEventUpdated = async () => {
    setSelectedCalendarEvent(null);
    await loadCalendarData();
  };

  const handleCalendarTaskUpdated = async () => {
    setSelectedCalendarTask(null);
    await loadCalendarData();
  };

  const handleNewEventSuccess = async () => {
    setIsNewEventOpen(false);
    await loadCalendarData();
  };

  const handleNewTaskSuccess = async () => {
    setIsNewTaskOpen(false);
    await loadCalendarData();
  };

  const handleCreateCalendarSuccess = () => {
    setIsCreateCalendarOpen(false);
    loadInitialData();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (calendars.length === 0 && !hasGoogleConnection) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-full px-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-hud-gold/20 to-hud-teal/20 flex items-center justify-center mb-6">
            <CalendarIcon className="w-8 h-8 text-hud-gold-soft" />
          </div>
          <h3 className="text-xl font-semibold text-white mb-2">No calendars set up yet</h3>
          <p className="text-hud-cream-dim text-sm text-center max-w-md mb-6">
            Create your first calendar to start scheduling appointments, managing availability, and booking time with contacts.
          </p>
          <button
            onClick={() => setIsCreateCalendarOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Calendar
          </button>
        </div>
        {isCreateCalendarOpen && (
          <CreateCalendarModal
            departments={departments}
            users={users}
            onClose={() => setIsCreateCalendarOpen(false)}
            onSuccess={handleCreateCalendarSuccess}
          />
        )}
      </>
    );
  }

  const selectedCalendar = calendars.length === 1 ? calendars[0] : calendars.find(c => selectedCalendarIds.includes(c.id));

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <UnifiedCalendarToolbar
          date={currentDate}
          viewType={viewType}
          onDateChange={handleDateChange}
          onViewTypeChange={handleViewTypeChange}
          onNewAppointment={() => {
            if (calendars.length === 0) {
              setIsCreateCalendarOpen(true);
            } else if (canCreate) {
              setIsNewAppointmentOpen(true);
            }
          }}
          onNewEvent={() => {
            if (calendars.length === 0) {
              setIsCreateCalendarOpen(true);
            } else {
              setIsNewEventOpen(true);
            }
          }}
          onNewTask={() => {
            if (calendars.length === 0) {
              setIsCreateCalendarOpen(true);
            } else {
              setIsNewTaskOpen(true);
            }
          }}
          onManageViewToggle={() => setIsManageViewOpen(!isManageViewOpen)}
          isManageViewOpen={isManageViewOpen}
          hasGoogleConnection={hasGoogleConnection}
          isSyncing={isSyncing}
          onSyncGoogle={async () => {
            await handleSyncGoogle();
            await loadCalendarData();
          }}
        />

        {isPhone && viewType === 'day' && <PhoneDateStrip date={currentDate} onSelect={handleDateChange} />}

        <div className="flex-1 overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {viewType === 'agenda' && (
            <AgendaListView
              startDate={currentDate}
              items={displayItems}
              onItemClick={handleDisplayItemClick}
              selfEmail={currentUser?.email}
              syncNote={
                showGoogleEvents && (viewFilter === 'all' || viewFilter === 'google_events')
                  ? syncedEventsNote({ connected: hasGoogleConnection, externalShown: googleEvents.length, mirrorUpcoming })
                  : null
              }
            />
          )}

          {viewType === 'day' && isPhone && (
            <AgendaDayView
              date={currentDate}
              items={displayItems}
              onItemClick={handleDisplayItemClick}
            />
          )}

          {viewType === 'day' && !isPhone && (
            <DayView
              date={currentDate}
              items={displayItems}
              onItemClick={handleDisplayItemClick}
            />
          )}

          {viewType === 'week' && (
            <div className="h-full overflow-x-auto">
              <div className="h-full min-w-[640px] md:min-w-0">
                <WeekView
                  date={currentDate}
                  items={displayItems}
                  onItemClick={handleDisplayItemClick}
                  onDayClick={handleDayClick}
                />
              </div>
            </div>
          )}

          {viewType === 'month' && (
            <MonthView
              date={currentDate}
              items={displayItems}
              onItemClick={handleDisplayItemClick}
              onDayClick={handleDayClick}
            />
          )}
        </div>
      </div>

      <ManageViewPanel
        isOpen={isManageViewOpen}
        onClose={() => setIsManageViewOpen(false)}
        viewFilter={viewFilter}
        onViewFilterChange={setViewFilter}
        users={users}
        calendars={calendars}
        selectedUserIds={selectedUserIds}
        selectedCalendarIds={selectedCalendarIds}
        onUserSelectionChange={setSelectedUserIds}
        onCalendarSelectionChange={setSelectedCalendarIds}
        showGoogleEvents={showGoogleEvents}
        onShowGoogleEventsChange={setShowGoogleEvents}
        hasGoogleConnection={hasGoogleConnection}
      />

      {selectedAppointment && (
        <AppointmentDetailsModal
          appointment={selectedAppointment}
          onClose={() => setSelectedAppointment(null)}
          onStatusChange={handleStatusChange}
          onEdit={handleEditClick}
          canEdit={canEdit}
        />
      )}

      {selectedGoogleEvent && (
        <GoogleEventDetailModal
          event={selectedGoogleEvent}
          onClose={() => setSelectedGoogleEvent(null)}
          onUpdated={handleGoogleEventUpdated}
          canEdit={canEdit}
        />
      )}

      {isNewAppointmentOpen && calendars.length > 0 && (
        <NewAppointmentModal
          calendar={selectedCalendar || calendars[0]}
          calendars={calendars}
          preselectedDate={currentDate}
          onClose={() => setIsNewAppointmentOpen(false)}
          onSuccess={handleNewAppointmentSuccess}
        />
      )}

      {isEditModalOpen && editingAppointment && calendars.length > 0 && (
        <EditAppointmentModal
          calendar={calendars.find(c => c.id === editingAppointment.calendar_id) || calendars[0]}
          appointment={editingAppointment}
          onClose={() => {
            setIsEditModalOpen(false);
            setEditingAppointment(null);
          }}
          onSuccess={handleEditSuccess}
        />
      )}

      {selectedCalendarEvent && (
        <EventDetailModal
          event={selectedCalendarEvent}
          onClose={() => setSelectedCalendarEvent(null)}
          onUpdated={handleCalendarEventUpdated}
        />
      )}

      {selectedCalendarTask && (
        <TaskDetailModal
          task={selectedCalendarTask}
          onClose={() => setSelectedCalendarTask(null)}
          onUpdated={handleCalendarTaskUpdated}
        />
      )}

      {isNewEventOpen && calendars.length > 0 && (
        <NewEventModal
          calendar={selectedCalendar || calendars[0]}
          calendars={calendars}
          preselectedDate={currentDate}
          onClose={() => setIsNewEventOpen(false)}
          onSuccess={handleNewEventSuccess}
        />
      )}

      {isNewTaskOpen && calendars.length > 0 && (
        <NewTaskModal
          calendar={selectedCalendar || calendars[0]}
          calendars={calendars}
          preselectedDate={currentDate}
          onClose={() => setIsNewTaskOpen(false)}
          onSuccess={handleNewTaskSuccess}
        />
      )}

      {isCreateCalendarOpen && (
        <CreateCalendarModal
          departments={departments}
          users={users}
          onClose={() => setIsCreateCalendarOpen(false)}
          onSuccess={handleCreateCalendarSuccess}
        />
      )}
    </div>
  );
}
