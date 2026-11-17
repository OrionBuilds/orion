import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Calendar as CalendarIcon,
  Clock,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  Video,
  Phone,
  MapPin,
  Check,
  Download,
  ArrowLeft,
  Mail,
  ArrowRight,
} from 'lucide-react';
import { TimezoneSelect } from '../../components/booking/TimezoneSelect';
import {
  buildIcs,
  googleCalendarUrl,
  outlookCalendarUrl,
  type CalendarInviteEvent,
} from '../../../supabase/functions/_shared/calendar-invite';

/** "YYYY-MM-DD" of an instant in the given timezone (slots are grouped by the visitor's day). */
function dateKeyInZone(value: string | Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(value)
    );
  } catch {
    return new Date(value).toISOString().slice(0, 10);
  }
}

/** "YYYY-MM-DD" of a calendar cell (a local Date built from year/month/day). */
function cellDateKey(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

function monthKey(month: Date): string {
  return `${month.getFullYear()}-${month.getMonth()}`;
}

interface CollectiveMember {
  name: string;
  initials: string;
}

interface HostInfo {
  name: string;
  initials: string;
}

interface CalendarInfo {
  id: string;
  name: string;
  slug: string;
  type?: 'user' | 'team';
  is_collective?: boolean;
  collective_members?: CollectiveMember[];
  host?: HostInfo;
}

interface AppointmentTypeInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  location_type: string;
  location_value?: {
    phone_number?: string;
    address?: string;
    custom_link?: string;
    instructions?: string;
  } | null;
  questions: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[];
  }>;
  booking_window_days: number;
}

interface AvailabilitySlot {
  start: string;
  end: string;
  eligible_user_ids: string[];
}

interface BookingResult {
  id: string;
  start_at_utc: string;
  end_at_utc: string;
  reschedule_token: string;
  cancel_token: string;
  google_meet_link: string | null;
  visitor_timezone?: string;
  /** Assigned host; older booking-api deploys don't return it. */
  organizer?: { name: string | null; email: string } | null;
}

export function BookingPage() {
  const { calendarSlug, typeSlug } = useParams<{
    calendarSlug: string;
    typeSlug: string;
  }>();
  const [searchParams] = useSearchParams();
  const isEmbed = searchParams.get('embed') === '1';
  const tzParam = searchParams.get('tz');

  const [calendarInfo, setCalendarInfo] = useState<CalendarInfo | null>(null);
  const [appointmentType, setAppointmentType] = useState<AppointmentTypeInfo | null>(null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  // Availability takes seconds (cold edge function); until it resolves the page must not claim
  // "no times open". availabilityError = the fetch failed (as opposed to returning zero slots).
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [step, setStep] = useState<'date' | 'form' | 'confirmation'>('date');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bookingResult, setBookingResult] = useState<BookingResult | null>(null);

  const [formData, setFormData] = useState<Record<string, string>>({
    name: '',
    email: '',
    phone: '',
  });
  const [visitorTimezone, setVisitorTimezone] = useState(
    tzParam || Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  const [hour12, setHour12] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('bookingTimeFormat');
    if (stored === '12') return true;
    if (stored === '24') return false;
    return true;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('bookingTimeFormat', hour12 ? '12' : '24');
    }
  }, [hour12]);

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isEmbed) return;

    const postHeight = () => {
      const height = rootRef.current?.scrollHeight ?? document.body.scrollHeight;
      window.parent?.postMessage(
        { type: 'booking-widget:height', height },
        '*'
      );
    };

    postHeight();
    const observer = new ResizeObserver(() => postHeight());
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener('resize', postHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', postHeight);
    };
  }, [isEmbed, step, selectedDate, slots, bookingResult]);

  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/booking-api`;

  // Availability per "<month>|<timezone>": in-flight/settled requests, plus resolved slot lists
  // so revisiting a month (or the prefetched next month) renders without a loading state.
  const slotRequests = useRef(new Map<string, Promise<AvailabilitySlot[]>>());
  const slotResults = useRef(new Map<string, AvailabilitySlot[]>());

  const fetchSlots = (
    month: Date,
    timezone: string,
    ids: { calendarId: string; typeId: string } | null
  ): Promise<AvailabilitySlot[]> => {
    const key = `${monthKey(month)}|${timezone}`;
    const existing = slotRequests.current.get(key);
    if (existing) return existing;
    const startDate = new Date(month.getFullYear(), month.getMonth(), 1).toISOString();
    const endDate = new Date(month.getFullYear(), month.getMonth() + 1, 0).toISOString();
    // By slug before /calendar has answered (runs in parallel with it); by id afterwards.
    const target = ids
      ? `calendar_id=${ids.calendarId}&type_id=${ids.typeId}`
      : `calendar_slug=${encodeURIComponent(calendarSlug ?? '')}&type_slug=${encodeURIComponent(typeSlug ?? '')}`;
    const request = fetch(
      `${apiUrl}/availability?${target}&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&timezone=${encodeURIComponent(timezone)}`
    ).then(async (response) => {
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || `Availability failed (${response.status})`);
      const list = (data.slots || []) as AvailabilitySlot[];
      slotResults.current.set(key, list);
      return list;
    });
    slotRequests.current.set(key, request);
    // A failed request is forgotten so the next call retries (e.g. by id after a slug miss).
    request.catch(() => {
      if (slotRequests.current.get(key) === request) slotRequests.current.delete(key);
    });
    return request;
  };

  useEffect(() => {
    loadCalendarInfo();
  }, [calendarSlug, typeSlug]);

  useEffect(() => {
    if (!calendarInfo || !appointmentType) return;
    const ids = { calendarId: calendarInfo.id, typeId: appointmentType.id };
    const month = currentMonth;
    const timezone = visitorTimezone;
    const cached = slotResults.current.get(`${monthKey(month)}|${timezone}`);
    let cancelled = false;

    const prefetchNextMonth = () =>
      fetchSlots(new Date(month.getFullYear(), month.getMonth() + 1, 1), timezone, ids).catch(() => undefined);

    if (cached) {
      setSlots(cached);
      setAvailabilityError(false);
      setAvailabilityLoading(false);
      prefetchNextMonth();
      return;
    }

    setAvailabilityLoading(true);
    setAvailabilityError(false);
    fetchSlots(month, timezone, ids)
      // The parallel by-slug request can fail against an older booking-api; retry by id.
      .catch(() => fetchSlots(month, timezone, ids))
      .then((list) => {
        if (cancelled) return;
        setSlots(list);
        setAvailabilityLoading(false);
        prefetchNextMonth();
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load availability:', err);
        setSlots([]);
        setAvailabilityError(true);
        setAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [calendarInfo, appointmentType, currentMonth, visitorTimezone]);

  const loadCalendarInfo = async () => {
    try {
      setIsLoading(true);
      // Start this month's availability now instead of after /calendar answers (~0.8 s saved).
      fetchSlots(currentMonth, visitorTimezone, null).catch(() => undefined);
      const response = await fetch(
        `${apiUrl}/calendar?calendar_slug=${calendarSlug}&type_slug=${typeSlug}`
      );
      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      setCalendarInfo(data.calendar);
      setAppointmentType(data.appointment_type);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load booking page');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitBooking = async () => {
    if (!calendarInfo || !appointmentType || !selectedSlot) return;

    try {
      setIsSubmitting(true);
      const response = await fetch(`${apiUrl}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendar_id: calendarInfo.id,
          appointment_type_id: appointmentType.id,
          start_utc: selectedSlot.start,
          end_utc: selectedSlot.end,
          visitor_timezone: visitorTimezone,
          answers: formData,
        }),
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error);
      }

      setBookingResult(data.appointment);
      setStep('confirmation');

      if (isEmbed) {
        window.parent?.postMessage(
          { type: 'booking-widget:booked', appointment: data.appointment },
          '*'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to book appointment');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Slots grouped by their day in the visitor's timezone, so changing the timezone moves slots to
  // the right day as well as relabelling their times.
  const slotsByDay = useMemo(() => {
    const map = new Map<string, AvailabilitySlot[]>();
    for (const slot of slots) {
      const key = dateKeyInZone(slot.start, visitorTimezone);
      const list = map.get(key) || [];
      list.push(slot);
      map.set(key, list);
    }
    return map;
  }, [slots, visitorTimezone]);

  const todayKey = dateKeyInZone(new Date(), visitorTimezone);

  const getSlotsForDate = (date: Date) => slotsByDay.get(cellDateKey(date)) || [];

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: (Date | null)[] = [];

    for (let i = 0; i < firstDay.getDay(); i++) {
      days.push(null);
    }

    for (let d = 1; d <= lastDay.getDate(); d++) {
      days.push(new Date(year, month, d));
    }

    return days;
  };

  const isDateAvailable = (date: Date) => slotsByDay.has(cellDateKey(date));

  const getLocationIcon = () => {
    switch (appointmentType?.location_type) {
      case 'google_meet':
      case 'zoom':
        return <Video className="w-4 h-4" />;
      case 'phone':
        return <Phone className="w-4 h-4" />;
      case 'in_person':
        return <MapPin className="w-4 h-4" />;
      default:
        return null;
    }
  };

  const getLocationText = () => {
    switch (appointmentType?.location_type) {
      case 'google_meet':
        return 'Google Meet video call';
      case 'zoom':
        return 'Zoom video call';
      case 'phone':
        return 'Phone call';
      case 'in_person':
        return 'In-person meeting';
      default:
        return '';
    }
  };

  const formatSlotTime = (isoString: string) => {
    return new Date(isoString).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12,
      timeZone: visitorTimezone,
    });
  };

  // Earliest open day (in the visitor's timezone), as a local Date for the calendar grid.
  const nextAvailableDate = useMemo(() => {
    const keys = [...slotsByDay.keys()].filter((k) => k >= todayKey).sort();
    if (!keys.length) return null;
    const [y, m, d] = keys[0].split('-').map(Number);
    return new Date(y, m - 1, d);
  }, [slotsByDay, todayKey]);

  const hasAnyAvailability = slots.length > 0;

  /** The booked meeting as a calendar event: real times, meet link, host, self-service links. */
  const inviteEvent = useMemo((): CalendarInviteEvent | null => {
    if (!bookingResult || !appointmentType) return null;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const meet = bookingResult.google_meet_link;
    const loc = appointmentType.location_value;
    const location =
      meet ||
      (appointmentType.location_type === 'in_person' && loc?.address) ||
      (appointmentType.location_type === 'phone' && loc?.phone_number) ||
      ((appointmentType.location_type === 'custom' || appointmentType.location_type === 'zoom') && loc?.custom_link) ||
      null;
    const hostName = bookingResult.organizer?.name || calendarInfo?.host?.name;
    return {
      uid: `${bookingResult.id}@orion.invalid`,
      title: hostName ? `${appointmentType.name} with ${hostName}` : appointmentType.name,
      start: bookingResult.start_at_utc,
      end: bookingResult.end_at_utc,
      url: meet,
      location,
      description: [
        meet ? `Join Google Meet: ${meet}` : '',
        loc?.instructions || '',
        `Reschedule: ${origin}/appointments/reschedule/${bookingResult.reschedule_token}`,
        `Cancel: ${origin}/appointments/cancel/${bookingResult.cancel_token}`,
      ]
        .filter(Boolean)
        .join('\n'),
      organizer: bookingResult.organizer ?? null,
    };
  }, [bookingResult, appointmentType, calendarInfo]);

  const downloadIcs = () => {
    if (!inviteEvent) return;
    const blob = new Blob([buildIcs(inviteEvent)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${appointmentType?.slug || 'appointment'}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const outerClass = isEmbed
    ? 'bg-hud-bg-deep p-4'
    : 'min-h-dvh bg-hud-bg-deep py-12 px-4';

  if (isLoading) {
    return (
      <div ref={rootRef} className={outerClass}>
        <div className="max-w-4xl mx-auto">
          <div className="bg-hud-bg-mid rounded-2xl border border-hud-bg-card overflow-hidden">
            <div className="p-6 border-b border-hud-bg-card space-y-3">
              <div className="h-7 w-2/3 rounded bg-hud-bg-card animate-pulse" />
              <div className="h-4 w-1/2 rounded bg-hud-bg-card animate-pulse" />
              <div className="flex gap-3 pt-2">
                <div className="h-4 w-20 rounded bg-hud-bg-card animate-pulse" />
                <div className="h-4 w-28 rounded bg-hud-bg-card animate-pulse" />
              </div>
            </div>
            <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-hud-bg-card">
              <div className="p-6 space-y-3">
                <div className="h-5 w-32 rounded bg-hud-bg-card animate-pulse" />
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: 35 }).map((_, i) => (
                    <div
                      key={i}
                      className="aspect-square rounded-lg bg-hud-bg-card/60 animate-pulse"
                    />
                  ))}
                </div>
              </div>
              <div className="p-6 space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-10 rounded-lg bg-hud-bg-card animate-pulse"
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !calendarInfo || !appointmentType) {
    return (
      <div
        ref={rootRef}
        className={
          isEmbed
            ? 'bg-hud-bg-deep flex flex-col items-center justify-center p-8'
            : 'min-h-dvh bg-hud-bg-deep flex flex-col items-center justify-center p-4'
        }
      >
        <AlertCircle className="w-12 h-12 text-hud-plum mb-4" />
        <h1 className="text-xl font-semibold text-white mb-2">Booking Unavailable</h1>
        <p className="text-hud-cream-dim">{error || 'This booking page is not available'}</p>
      </div>
    );
  }

  if (step === 'confirmation' && bookingResult) {
    return (
      <div ref={rootRef} className={outerClass}>
        <div className="max-w-md mx-auto">
          <div className="bg-hud-bg-mid rounded-2xl border border-hud-bg-card overflow-hidden">
            <div className="bg-gradient-to-br from-hud-emerald/15 via-hud-emerald/5 to-transparent border-b border-hud-emerald/20 px-8 pt-8 pb-6 text-center">
              <div className="w-14 h-14 rounded-full bg-hud-emerald flex items-center justify-center mx-auto mb-4 shadow-lg shadow-hud-emerald/30">
                <Check className="w-7 h-7 text-white" strokeWidth={3} />
              </div>
              <h1 className="text-2xl font-semibold text-white mb-1">
                You're booked
              </h1>
              <p className="text-sm text-hud-cream-dim">
                {appointmentType.name}
                {calendarInfo.host ? ` with ${calendarInfo.host.name}` : ''}
              </p>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-hud-bg-card/60 rounded-lg p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <CalendarIcon className="w-5 h-5 text-hud-gold-soft mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs uppercase tracking-wider text-hud-cream-mute mb-0.5">
                      When
                    </p>
                    <p className="text-white font-medium">
                      {new Date(bookingResult.start_at_utc).toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                        timeZone: visitorTimezone,
                      })}
                    </p>
                    <p className="text-sm text-hud-cream-dim">
                      {formatSlotTime(bookingResult.start_at_utc)} -{' '}
                      {formatSlotTime(bookingResult.end_at_utc)} ({appointmentType.duration_minutes}{' '}
                      min)
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  {getLocationIcon() ? (
                    <div className="w-5 h-5 mt-0.5 shrink-0 text-hud-gold-soft">{getLocationIcon()}</div>
                  ) : (
                    <MapPin className="w-5 h-5 text-hud-gold-soft mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wider text-hud-cream-mute mb-0.5">
                      Where
                    </p>
                    {bookingResult.google_meet_link ? (
                      <>
                        <p className="text-hud-cream-soft">Google Meet video call</p>
                        <a
                          href={bookingResult.google_meet_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-hud-gold-soft hover:text-hud-gold-soft underline break-all"
                        >
                          {bookingResult.google_meet_link.replace(/^https?:\/\//, '')}
                        </a>
                      </>
                    ) : (
                      <p className="text-hud-cream-soft">{getLocationText() || 'Details will follow'}</p>
                    )}
                  </div>
                </div>

                {calendarInfo.host && (
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-[9px] font-bold text-white mt-0.5 shrink-0">
                      {calendarInfo.host.initials}
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wider text-hud-cream-mute mb-0.5">
                        With
                      </p>
                      <p className="text-hud-cream-soft">{calendarInfo.host.name}</p>
                    </div>
                  </div>
                )}
              </div>

              {inviteEvent && (
                <div>
                  <p className="text-xs uppercase tracking-wider text-hud-cream-mute mb-2">
                    Add to calendar
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: 'Google', href: googleCalendarUrl(inviteEvent) },
                      { label: 'Outlook.com', href: outlookCalendarUrl(inviteEvent, 'live') },
                      { label: 'Office 365', href: outlookCalendarUrl(inviteEvent, 'office') },
                    ].map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-hud-bg-card text-white text-sm hover:bg-hud-bg-elev transition-colors"
                      >
                        <CalendarIcon className="w-4 h-4 text-hud-cream-dim" />
                        {link.label}
                      </a>
                    ))}
                    <button
                      type="button"
                      onClick={downloadIcs}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-hud-bg-card text-white text-sm hover:bg-hud-bg-elev transition-colors"
                    >
                      <CalendarIcon className="w-4 h-4 text-hud-cream-dim" />
                      Apple
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={downloadIcs}
                    className="mt-2 inline-flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg border border-hud-bg-elev text-hud-cream-soft text-sm hover:bg-hud-bg-card hover:text-white transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    Download invite (.ics)
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <a
                  href={`/appointments/reschedule/${bookingResult.reschedule_token}`}
                  target={isEmbed ? '_blank' : undefined}
                  rel={isEmbed ? 'noopener noreferrer' : undefined}
                  className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-hud-bg-elev text-hud-cream-soft hover:bg-hud-bg-card hover:text-white transition-colors text-sm"
                >
                  Reschedule
                </a>
                <a
                  href={`/appointments/cancel/${bookingResult.cancel_token}`}
                  target={isEmbed ? '_blank' : undefined}
                  rel={isEmbed ? 'noopener noreferrer' : undefined}
                  className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-hud-bg-elev text-hud-cream-soft hover:bg-hud-plum/10 hover:text-hud-plum/40 hover:border-hud-plum/30 transition-colors text-sm"
                >
                  Cancel
                </a>
              </div>

              <div className="flex items-start gap-2 text-xs text-hud-cream-mute pt-1">
                <Mail className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  We've sent a confirmation to{' '}
                  <span className="text-hud-cream-soft">{formData.email}</span> with a
                  calendar invite and your reschedule and cancel links.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={outerClass}>
      <div className="max-w-4xl mx-auto">
        <div className="bg-hud-bg-mid rounded-2xl border border-hud-bg-card overflow-hidden">
          <div className="p-6 border-b border-hud-bg-card">
            {calendarInfo.host && (
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-xs font-bold text-white">
                  {calendarInfo.host.initials}
                </div>
                <span className="text-sm text-hud-cream-dim">
                  Meeting with{' '}
                  <span className="text-hud-cream-soft font-medium">
                    {calendarInfo.host.name}
                  </span>
                </span>
              </div>
            )}
            <h1 className="text-2xl font-semibold text-white">{appointmentType.name}</h1>
            {appointmentType.description && (
              <p className="text-hud-cream-dim mt-1">{appointmentType.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-4 text-sm text-hud-cream-dim">
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4" />
                {appointmentType.duration_minutes} min
              </span>
              <span className="flex items-center gap-1.5">
                {getLocationIcon()}
                {getLocationText()}
              </span>
            </div>
            {calendarInfo.is_collective && calendarInfo.collective_members && calendarInfo.collective_members.length > 0 && (
              <div className="mt-4 pt-4 border-t border-hud-bg-card">
                <p className="text-xs font-medium text-hud-cream-mute uppercase tracking-wider mb-3">Meeting with</p>
                <div className="flex flex-wrap gap-3">
                  {calendarInfo.collective_members.map((member, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-xs font-bold text-white">
                        {member.initials}
                      </div>
                      <span className="text-sm text-hud-cream-soft">{member.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {step === 'date' && (
            <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-hud-bg-card">
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-medium text-white">
                    {currentMonth.toLocaleDateString('en-US', {
                      month: 'long',
                      year: 'numeric',
                    })}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        setCurrentMonth(
                          new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
                        )
                      }
                      className="p-1 rounded hover:bg-hud-bg-card transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5 text-hud-cream-dim" />
                    </button>
                    <button
                      onClick={() =>
                        setCurrentMonth(
                          new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
                        )
                      }
                      className="p-1 rounded hover:bg-hud-bg-card transition-colors"
                    >
                      <ChevronRight className="w-5 h-5 text-hud-cream-dim" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-7 gap-1 text-center mb-2">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                    <div key={day} className="text-xs font-medium text-hud-cream-mute py-2">
                      {day}
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-1" aria-busy={availabilityLoading}>
                  {getDaysInMonth(currentMonth).map((day, i) => {
                    if (!day) {
                      return <div key={i} />;
                    }

                    const isPast = cellDateKey(day) < todayKey;
                    if (availabilityLoading) {
                      return (
                        <div
                          key={i}
                          className={`aspect-square rounded-lg flex items-center justify-center text-sm ${
                            isPast ? 'text-hud-cream-mute' : 'bg-hud-bg-card/60 animate-pulse text-hud-cream-dim'
                          }`}
                        >
                          {day.getDate()}
                        </div>
                      );
                    }

                    const isAvailable = isDateAvailable(day);
                    const isSelected =
                      selectedDate?.toDateString() === day.toDateString();

                    return (
                      <button
                        key={i}
                        onClick={() => isAvailable && !isPast && setSelectedDate(day)}
                        disabled={!isAvailable || isPast}
                        className={`aspect-square rounded-lg text-sm font-medium transition-colors ${
                          isSelected
                            ? 'bg-hud-gold text-hud-bg-deep'
                            : isAvailable && !isPast
                            ? 'hover:bg-hud-bg-card text-white'
                            : 'text-hud-cream-mute cursor-not-allowed'
                        }`}
                      >
                        {day.getDate()}
                      </button>
                    );
                  })}
                </div>

                {availabilityLoading && (
                  <div className="mt-4 flex items-center gap-2 text-xs text-hud-cream-dim" role="status">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading available times…
                  </div>
                )}

                {!availabilityLoading && availabilityError && (
                  <div className="mt-4 p-3 rounded-lg bg-hud-rust/10 border border-hud-rust/30 text-hud-rust/40 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>Couldn't load available times. Refresh the page to try again.</span>
                  </div>
                )}

                {/* Only after the fetch has answered with zero slots. */}
                {!availabilityLoading && !availabilityError && !hasAnyAvailability && nextAvailableDate === null && (
                  <div className="mt-4 p-3 rounded-lg bg-hud-rust/10 border border-hud-rust/30 text-hud-rust/40 text-xs flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      No times open this month. Try the next month or a
                      different timezone.
                    </span>
                  </div>
                )}

                {!availabilityLoading && nextAvailableDate &&
                  (nextAvailableDate.getMonth() !== currentMonth.getMonth() ||
                    nextAvailableDate.getFullYear() !== currentMonth.getFullYear()) && (
                    <button
                      type="button"
                      onClick={() =>
                        setCurrentMonth(
                          new Date(
                            nextAvailableDate.getFullYear(),
                            nextAvailableDate.getMonth(),
                            1
                          )
                        )
                      }
                      className="mt-4 w-full inline-flex items-center justify-between px-3 py-2 rounded-lg bg-hud-gold/10 border border-hud-gold/30 text-hud-gold-soft text-sm hover:bg-hud-gold/15 transition-colors"
                    >
                      <span>
                        Next available:{' '}
                        {nextAvailableDate.toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}

                <div className="mt-4">
                  <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
                    Timezone
                  </label>
                  <TimezoneSelect
                    value={visitorTimezone}
                    onChange={setVisitorTimezone}
                  />
                </div>
              </div>

              <div className="p-6">
                {availabilityLoading ? (
                  <div className="space-y-2" role="status" aria-label="Loading available times">
                    <div className="flex items-center gap-2 text-sm text-hud-cream-dim mb-4">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading available times…
                    </div>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="h-11 rounded-lg bg-hud-bg-card animate-pulse" />
                    ))}
                  </div>
                ) : selectedDate ? (
                  <>
                    <div className="flex items-center justify-between mb-4 gap-3">
                      <h3 className="text-lg font-medium text-white truncate">
                        {selectedDate.toLocaleDateString('en-US', {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </h3>
                      <div className="flex bg-hud-bg-card rounded-lg p-0.5 text-xs shrink-0">
                        <button
                          type="button"
                          onClick={() => setHour12(true)}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                            hour12
                              ? 'bg-hud-bg-elev text-white'
                              : 'text-hud-cream-dim hover:text-white'
                          }`}
                        >
                          12h
                        </button>
                        <button
                          type="button"
                          onClick={() => setHour12(false)}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                            !hour12
                              ? 'bg-hud-bg-elev text-white'
                              : 'text-hud-cream-dim hover:text-white'
                          }`}
                        >
                          24h
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2 md:max-h-80 overflow-y-auto">
                      {getSlotsForDate(selectedDate).map((slot) => (
                        <button
                          key={slot.start}
                          onClick={() => {
                            setSelectedSlot(slot);
                            setStep('form');
                          }}
                          className={`w-full px-4 py-3 rounded-lg border text-left transition-colors ${
                            selectedSlot?.start === slot.start
                              ? 'bg-hud-gold/20 border-hud-gold text-hud-gold-soft'
                              : 'bg-hud-bg-card border-hud-bg-elev text-white hover:border-hud-cream-mute'
                          }`}
                        >
                          {formatSlotTime(slot.start)}
                        </button>
                      ))}
                      {getSlotsForDate(selectedDate).length === 0 && (
                        <p className="text-sm text-hud-cream-mute py-6 text-center">
                          No open times on this day in this timezone. Pick another date.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center py-12">
                    <CalendarIcon className="w-12 h-12 text-hud-cream-mute mb-4" />
                    <p className="text-hud-cream-dim">Select a date to see available times</p>
                    {nextAvailableDate && (
                      <p className="text-sm text-hud-cream-mute mt-2">
                        Earliest opening:{' '}
                        {nextAvailableDate.toLocaleDateString('en-US', {
                          weekday: 'long',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 'form' && selectedSlot && (
            <div className="p-6">
              <button
                onClick={() => setStep('date')}
                className="inline-flex items-center gap-1 text-hud-cream-dim hover:text-white mb-6"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              <div className="bg-hud-bg-card rounded-lg p-4 mb-6">
                <p className="text-white font-medium">
                  {selectedDate?.toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}
                </p>
                <p className="text-hud-cream-dim">
                  {formatSlotTime(selectedSlot.start)} - {formatSlotTime(selectedSlot.end)}
                </p>
              </div>

              <div className="space-y-4">
                {appointmentType.questions.map((q) => (
                  <div key={q.id}>
                    <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
                      {q.label} {q.required && '*'}
                    </label>
                    {q.type === 'textarea' ? (
                      <textarea
                        value={formData[q.id] || ''}
                        onChange={(e) =>
                          setFormData({ ...formData, [q.id]: e.target.value })
                        }
                        rows={3}
                        className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
                      />
                    ) : q.type === 'select' ? (
                      <select
                        value={formData[q.id] || ''}
                        onChange={(e) =>
                          setFormData({ ...formData, [q.id]: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                      >
                        <option value="">Select...</option>
                        {q.options?.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : q.type === 'checkbox' ? (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData[q.id] === 'true'}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              [q.id]: e.target.checked ? 'true' : 'false',
                            })
                          }
                          className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                        />
                        <span className="text-hud-cream-soft">{q.label}</span>
                      </label>
                    ) : (
                      <input
                        type={q.id === 'email' ? 'email' : q.id === 'phone' ? 'tel' : 'text'}
                        value={formData[q.id] || ''}
                        onChange={(e) =>
                          setFormData({ ...formData, [q.id]: e.target.value })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-gold"
                      />
                    )}
                  </div>
                ))}
              </div>

              <button
                onClick={handleSubmitBooking}
                disabled={
                  isSubmitting ||
                  !formData.name ||
                  !formData.email ||
                  appointmentType.questions.some((q) => q.required && !formData[q.id])
                }
                className="w-full mt-6 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  'Confirm Booking'
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
