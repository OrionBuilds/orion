import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Settings,
  Calendar as CalendarIcon,
} from 'lucide-react';
import type { CalendarViewType } from '../../../utils/calendarViewUtils';
import { getDateRangeLabel, addDays, addWeeks, addMonths } from '../../../utils/calendarViewUtils';

interface CalendarToolbarProps {
  date: Date;
  viewType: CalendarViewType;
  onDateChange: (date: Date) => void;
  onViewTypeChange: (viewType: CalendarViewType) => void;
  onNewAppointment: () => void;
  onSettingsClick: () => void;
  calendarName?: string;
}

export function CalendarToolbar({
  date,
  viewType,
  onDateChange,
  onViewTypeChange,
  onNewAppointment,
  onSettingsClick,
  calendarName,
}: CalendarToolbarProps) {
  const dateLabel = getDateRangeLabel(date, viewType);

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
    }
  };

  const goToToday = () => {
    onDateChange(new Date());
  };

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-hud-bg-card">
      <div className="flex items-center gap-4">
        {calendarName && (
          <div className="flex items-center gap-2 pr-4 border-r border-hud-bg-elev">
            <CalendarIcon className="w-5 h-5 text-hud-gold-soft" />
            <span className="font-medium text-white">{calendarName}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={navigatePrevious}
            className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            aria-label="Previous"
          >
            <ChevronLeft className="w-5 h-5 text-hud-cream-dim" />
          </button>
          <button
            onClick={navigateNext}
            className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            aria-label="Next"
          >
            <ChevronRight className="w-5 h-5 text-hud-cream-dim" />
          </button>
          <button
            onClick={goToToday}
            className="px-3 py-1.5 text-sm font-medium text-hud-cream-soft hover:text-white hover:bg-hud-bg-card rounded-lg transition-colors"
          >
            Today
          </button>
        </div>

        <h2 className="text-lg font-medium text-white min-w-[200px]">{dateLabel}</h2>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center bg-hud-bg-card rounded-lg border border-hud-bg-elev p-1">
          {(['day', 'week', 'month'] as const).map((view) => (
            <button
              key={view}
              onClick={() => onViewTypeChange(view)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors capitalize ${
                viewType === view
                  ? 'bg-hud-bg-elev text-white'
                  : 'text-hud-cream-dim hover:text-white'
              }`}
            >
              {view}
            </button>
          ))}
        </div>

        <button
          onClick={onSettingsClick}
          className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
          aria-label="Calendar settings"
        >
          <Settings className="w-5 h-5 text-hud-cream-dim" />
        </button>

        <button
          onClick={onNewAppointment}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Appointment
        </button>
      </div>
    </div>
  );
}
