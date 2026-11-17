import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Calendar as CalendarIcon,
  Clock,
  Loader2,
  AlertCircle,
  Video,
  Phone,
  MapPin,
  XCircle,
  Check,
  ArrowLeft,
} from 'lucide-react';
import { formatDateLong } from '../../utils/formatters';

interface AppointmentInfo {
  id: string;
  status: string;
  start_at_utc: string;
  end_at_utc: string;
  visitor_timezone: string;
  google_meet_link: string | null;
  calendar: { id: string; name: string; slug: string };
  appointment_type: {
    id: string;
    name: string;
    duration_minutes: number;
    location_type: string;
  };
}

type Step = 'confirm' | 'done';

export default function CancelAppointmentPage() {
  const { token } = useParams<{ token: string }>();

  const [appointment, setAppointment] = useState<AppointmentInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('confirm');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [alreadyCanceled, setAlreadyCanceled] = useState(false);

  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/booking-api`;

  useEffect(() => {
    loadAppointment();
  }, [token]);

  const loadAppointment = async () => {
    if (!token) return;
    try {
      setIsLoading(true);
      const response = await fetch(
        `${apiUrl}/appointment?cancel_token=${encodeURIComponent(token)}`
      );
      const data = await response.json();
      if (data.error) throw new Error(data.error);

      const appt = data.appointment as AppointmentInfo;
      setAppointment(appt);

      if (appt.status === 'canceled') {
        setAlreadyCanceled(true);
        setStep('done');
      } else if (new Date(appt.start_at_utc) < new Date()) {
        throw new Error(
          'This appointment has already passed and cannot be canceled.'
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'This cancel link is invalid or has expired.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!token) return;
    try {
      setIsSubmitting(true);
      const response = await fetch(`${apiUrl}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, reason: reason.trim() || undefined }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setIsSubmitting(false);
    }
  };

  const tz = appointment?.visitor_timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  const formatTime = (isoString: string) =>
    new Date(isoString).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    });

  const getLocationIcon = () => {
    switch (appointment?.appointment_type.location_type) {
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

  if (isLoading) {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (error || !appointment) {
    return (
      <div className="min-h-dvh bg-hud-bg-deep flex flex-col items-center justify-center p-4">
        <AlertCircle className="w-12 h-12 text-hud-plum mb-4" />
        <h1 className="text-xl font-semibold text-white mb-2">
          Cannot Cancel
        </h1>
        <p className="text-hud-cream-dim text-center max-w-md">
          {error || 'This cancel link is invalid or has expired.'}
        </p>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="min-h-dvh bg-hud-bg-deep py-12 px-4">
        <div className="max-w-md mx-auto">
          <div className="bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8 text-center">
            <div
              className={`w-16 h-16 rounded-full ${
                alreadyCanceled ? 'bg-hud-bg-card' : 'bg-green-500/20'
              } flex items-center justify-center mx-auto mb-6`}
            >
              {alreadyCanceled ? (
                <XCircle className="w-8 h-8 text-hud-cream-dim" />
              ) : (
                <Check className="w-8 h-8 text-green-400" />
              )}
            </div>
            <h1 className="text-2xl font-semibold text-white mb-2">
              {alreadyCanceled
                ? 'Already Canceled'
                : 'Appointment Canceled'}
            </h1>
            <p className="text-hud-cream-dim mb-6">
              {alreadyCanceled
                ? `This ${appointment.appointment_type.name} was already canceled.`
                : `Your ${appointment.appointment_type.name} has been canceled.`}
            </p>

            <div className="bg-hud-bg-card rounded-lg p-4 mb-6 text-left">
              <div className="flex items-center gap-3 mb-3">
                <CalendarIcon className="w-5 h-5 text-hud-cream-mute" />
                <div>
                  <p className="text-hud-cream-soft font-medium">
                    {formatDateLong(appointment.start_at_utc, { weekday: true, timeZone: tz })}
                  </p>
                  <p className="text-sm text-hud-cream-mute">
                    {formatTime(appointment.start_at_utc)} -{' '}
                    {formatTime(appointment.end_at_utc)}
                  </p>
                </div>
              </div>
            </div>

            <Link
              to={`/book/${appointment.calendar.slug}`}
              className="inline-flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white hover:from-hud-gold-deep hover:to-hud-teal transition-colors"
            >
              Book a new time
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-hud-bg-deep py-12 px-4">
      <div className="max-w-md mx-auto">
        <div className="bg-hud-bg-mid rounded-2xl border border-hud-bg-card p-8">
          <p className="text-xs font-medium text-hud-plum uppercase tracking-wider mb-2">
            Cancel appointment
          </p>
          <h1 className="text-2xl font-semibold text-white mb-1">
            {appointment.appointment_type.name}
          </h1>
          <div className="flex items-center gap-4 mt-3 text-sm text-hud-cream-dim">
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              {appointment.appointment_type.duration_minutes} min
            </span>
            <span className="flex items-center gap-1.5">
              {getLocationIcon()}
              {appointment.appointment_type.location_type}
            </span>
          </div>

          <div className="bg-hud-bg-card rounded-lg p-4 my-6">
            <div className="flex items-center gap-3">
              <CalendarIcon className="w-5 h-5 text-hud-gold-soft" />
              <div>
                <p className="text-white font-medium">
                  {formatDateLong(appointment.start_at_utc, { weekday: true, timeZone: tz })}
                </p>
                <p className="text-sm text-hud-cream-dim">
                  {formatTime(appointment.start_at_utc)} -{' '}
                  {formatTime(appointment.end_at_utc)}
                </p>
              </div>
            </div>
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
              Reason (optional)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Let us know why you're canceling..."
              className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-mute focus:outline-none focus:ring-2 focus:ring-hud-plum resize-none"
            />
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={handleCancel}
              disabled={isSubmitting}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-hud-plum text-white font-medium hover:bg-hud-plum disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                'Cancel appointment'
              )}
            </button>
            <Link
              to={`/book/${appointment.calendar.slug}`}
              className="w-full inline-flex items-center justify-center gap-1 px-4 py-2 text-hud-cream-dim hover:text-white text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Keep my appointment
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
