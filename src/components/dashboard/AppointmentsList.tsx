import { Link } from 'react-router-dom';
import { Calendar, ChevronRight } from 'lucide-react';
import { Badge } from './Badge';
import type { DashboardAppointment } from '../../services/dashboard';

interface AppointmentsListProps {
  appointments: DashboardAppointment[];
  googleConnected?: boolean;
  onViewAll?: () => void;
  isLoading?: boolean;
}

function formatAppointmentTime(
  dateString: string,
  allDay?: boolean
): { date: string; time: string } {
  const date = new Date(dateString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = allDay
    ? 'All day'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let dateStr = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  if (isToday) dateStr = 'Today';
  else if (isTomorrow) dateStr = 'Tomorrow';

  return { date: dateStr, time: timeStr };
}

const statusVariants = {
  scheduled: 'neutral',
  confirmed: 'success',
  tentative: 'warning',
  in_progress: 'info',
} as const;

const rowClasses =
  'flex items-center gap-3 p-3 rounded-lg hover:bg-hud-bg-elev/50 transition-colors';

function AppointmentRow({ appointment }: { appointment: DashboardAppointment }) {
  const { date, time } = formatAppointmentTime(appointment.start_at_utc, appointment.allDay);

  const body = (
    <>
      <div className="p-2 rounded-lg bg-hud-gold/10">
        <Calendar className="h-4 w-4 text-hud-gold-soft" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">{appointment.title}</span>
          <Badge
            variant={
              statusVariants[appointment.status as keyof typeof statusVariants] || 'neutral'
            }
          >
            {appointment.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {appointment.source === 'google' && (
            <>
              <span className="text-[11px] font-medium text-hud-cream-dim">Google</span>
              <span className="text-hud-cream-mute">·</span>
            </>
          )}
          {appointment.subtitle && (
            <span className="text-xs text-hud-cream-mute truncate">{appointment.subtitle}</span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-medium text-white">{time}</p>
        <p className="text-xs text-hud-cream-mute">{date}</p>
      </div>
    </>
  );

  // Prefer the CRM detail view; otherwise open the Google event; otherwise the calendar.
  if (appointment.appointmentId) {
    return (
      <Link to={`/calendars?tab=list&appointmentId=${appointment.appointmentId}`} className={rowClasses}>
        {body}
      </Link>
    );
  }
  if (appointment.htmlLink) {
    return (
      <a href={appointment.htmlLink} target="_blank" rel="noopener noreferrer" className={rowClasses}>
        {body}
      </a>
    );
  }
  return (
    <Link to="/calendars" className={rowClasses}>
      {body}
    </Link>
  );
}

export function AppointmentsList({ appointments, googleConnected, isLoading }: AppointmentsListProps) {
  return (
    <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev">
      <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev">
        <h3 className="text-sm font-semibold text-white">Upcoming Appointments</h3>
        <Link
          to="/calendars"
          className="flex items-center gap-1 text-xs font-medium text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
        >
          View all
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="p-3">
        {isLoading ? (
          <LoadingSkeleton />
        ) : appointments.length === 0 ? (
          <EmptyState googleConnected={googleConnected} />
        ) : (
          <div className="space-y-1">
            {appointments.map((appointment) => (
              <AppointmentRow key={`${appointment.source}-${appointment.id}`} appointment={appointment} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ googleConnected }: { googleConnected?: boolean }) {
  if (!googleConnected) {
    return (
      <div className="py-8 text-center">
        <Calendar className="h-10 w-10 text-hud-cream-mute mx-auto mb-3" />
        <p className="text-sm text-hud-cream-mute mb-1">No upcoming appointments</p>
        <p className="text-xs text-hud-cream-mute mb-3">
          Connect your Google Calendar to see your real schedule here.
        </p>
        <Link
          to="/settings/calendars"
          className="inline-flex items-center gap-1 text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
        >
          Connect Google Calendar
          <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="py-8 text-center">
      <Calendar className="h-10 w-10 text-hud-cream-mute mx-auto mb-3" />
      <p className="text-sm text-hud-cream-mute mb-3">No upcoming appointments</p>
      <Link
        to="/calendars"
        className="inline-flex items-center gap-1 text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
      >
        View Calendars
        <ChevronRight className="h-4 w-4" />
      </Link>
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
          <div className="space-y-2 text-right">
            <div className="h-4 w-12 bg-hud-bg-elev rounded ml-auto" />
            <div className="h-3 w-16 bg-hud-bg-elev rounded ml-auto" />
          </div>
        </div>
      ))}
    </div>
  );
}
