import { useState, useRef, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  SlidersHorizontal,
  ChevronDown,
  RefreshCw,
  Loader2,
  CalendarDays,
  CheckSquare,
  Calendar,
} from 'lucide-react';
import type { CalendarViewType } from '../../../utils/calendarViewUtils';
import { AGENDA_VIEW_DAYS, addDays, addWeeks, addMonths, getDateRangeLabel } from '../../../utils/calendarViewUtils';
import { agendaRangeLabel } from '../../../utils/agenda';

interface UnifiedCalendarToolbarProps {
  date: Date;
  viewType: CalendarViewType;
  onDateChange: (date: Date) => void;
  onViewTypeChange: (viewType: CalendarViewType) => void;
  onNewAppointment: () => void;
  onNewEvent?: () => void;
  onNewTask?: () => void;
  onManageViewToggle: () => void;
  isManageViewOpen: boolean;
  hasGoogleConnection?: boolean;
  isSyncing?: boolean;
  onSyncGoogle?: () => void;
}

const VIEW_TYPE_LABELS: Record<CalendarViewType, string> = {
  agenda: 'Agenda',
  day: 'Day View',
  week: 'Week View',
  month: 'Month View',
};

export function UnifiedCalendarToolbar({
  date,
  viewType,
  onDateChange,
  onViewTypeChange,
  onNewAppointment,
  onNewEvent,
  onNewTask,
  onManageViewToggle,
  isManageViewOpen,
  hasGoogleConnection = false,
  isSyncing = false,
  onSyncGoogle,
}: UnifiedCalendarToolbarProps) {
  const [isViewDropdownOpen, setIsViewDropdownOpen] = useState(false);
  const [isNewDropdownOpen, setIsNewDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const newDropdownRef = useRef<HTMLDivElement>(null);

  const monthYearLabel = viewType === 'agenda'
    ? getDateRangeLabel(date, 'agenda')
    : date.toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });

  // Phones have ~85px for the title once Today, the arrows and the view picker are in: use the short form.
  const phoneLabel = viewType === 'agenda'
    ? agendaRangeLabel(date)
    : viewType === 'day'
      ? date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsViewDropdownOpen(false);
      }
      if (newDropdownRef.current && !newDropdownRef.current.contains(event.target as Node)) {
        setIsNewDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const navigatePrevious = () => {
    switch (viewType) {
      case 'day':
        onDateChange(addDays(date, -1));
        break;
      case 'week':
        onDateChange(addWeeks(date, -1));
        break;
      case 'month':
        onDateChange(addMonths(date, -1));
        break;
      case 'agenda':
        onDateChange(addDays(date, -AGENDA_VIEW_DAYS));
        break;
    }
  };

  const navigateNext = () => {
    switch (viewType) {
      case 'day':
        onDateChange(addDays(date, 1));
        break;
      case 'week':
        onDateChange(addWeeks(date, 1));
        break;
      case 'month':
        onDateChange(addMonths(date, 1));
        break;
      case 'agenda':
        onDateChange(addDays(date, AGENDA_VIEW_DAYS));
        break;
    }
  };

  const goToToday = () => {
    onDateChange(new Date());
  };

  const handleViewTypeSelect = (type: CalendarViewType) => {
    onViewTypeChange(type);
    setIsViewDropdownOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 sm:px-4 py-3 border-b border-hud-bg-card">
      <div className="flex items-center gap-1.5 sm:gap-3 w-full sm:w-auto">
        <button
          onClick={goToToday}
          className="px-2.5 sm:px-4 py-1.5 text-sm font-medium text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-card hover:text-white transition-colors"
        >
          Today
        </button>

        <div className="flex items-center flex-1 sm:flex-none justify-center min-w-0">
          <button
            onClick={navigatePrevious}
            className="px-1 py-2 sm:p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            aria-label="Previous"
          >
            <ChevronLeft className="w-5 h-5 text-hud-cream-dim" />
          </button>

          <span className="min-w-0 flex-1 sm:flex-none sm:min-w-[180px] truncate text-center text-sm sm:text-lg font-medium text-white">
            <span className="sm:hidden">{phoneLabel}</span>
            <span className="hidden sm:inline">{monthYearLabel}</span>
          </span>

          <button
            onClick={navigateNext}
            className="px-1 py-2 sm:p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            aria-label="Next"
          >
            <ChevronRight className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsViewDropdownOpen(!isViewDropdownOpen)}
            className="flex items-center gap-1 sm:gap-2 px-2.5 sm:px-3 py-1.5 text-sm font-medium text-hud-cream-soft bg-hud-bg-card border border-hud-bg-elev rounded-lg hover:bg-hud-bg-elev transition-colors"
          >
            {VIEW_TYPE_LABELS[viewType]}
            <ChevronDown className="w-4 h-4" />
          </button>

          {isViewDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-36 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-20">
              {(['agenda', 'day', 'week', 'month'] as CalendarViewType[]).map((type) => (
                <button
                  key={type}
                  onClick={() => handleViewTypeSelect(type)}
                  className={`w-full px-3 py-2 text-sm text-left transition-colors first:rounded-t-lg last:rounded-b-lg ${
                    viewType === type
                      ? 'bg-hud-gold/20 text-hud-gold-soft'
                      : 'text-hud-cream-soft hover:bg-hud-bg-elev'
                  }`}
                >
                  {VIEW_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto justify-end">
        {hasGoogleConnection && onSyncGoogle && (
          <button
            onClick={onSyncGoogle}
            disabled={isSyncing}
            aria-label="Sync calendars"
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-hud-cream-soft border border-hud-cream-mute rounded-lg hover:bg-hud-bg-card hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSyncing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sync'}</span>
          </button>
        )}

        <button
          onClick={onManageViewToggle}
          aria-label="Manage view"
          className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
            isManageViewOpen
              ? 'bg-hud-gold/20 text-hud-gold-soft border-hud-gold/50'
              : 'text-hud-cream-soft border-hud-cream-mute hover:bg-hud-bg-card hover:text-white'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" />
          <span className="hidden sm:inline">Manage View</span>
        </button>

        <div className="relative" ref={newDropdownRef}>
          <button
            onClick={() => setIsNewDropdownOpen(!isNewDropdownOpen)}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white text-sm font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors"
          >
            <Plus className="w-4 h-4" />
            New
            <ChevronDown className="w-3.5 h-3.5" />
          </button>

          {isNewDropdownOpen && (
            <div className="absolute top-full right-0 mt-1 w-44 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-20 py-1">
              <button
                onClick={() => { setIsNewDropdownOpen(false); onNewAppointment(); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
              >
                <Calendar className="w-4 h-4 text-hud-gold-soft" />
                Appointment
              </button>
              {onNewEvent && (
                <button
                  onClick={() => { setIsNewDropdownOpen(false); onNewEvent(); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                >
                  <CalendarDays className="w-4 h-4 text-blue-400" />
                  Event
                </button>
              )}
              {onNewTask && (
                <button
                  onClick={() => { setIsNewDropdownOpen(false); onNewTask(); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                >
                  <CheckSquare className="w-4 h-4 text-hud-rust" />
                  Task
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
