import { useMemo } from 'react';
import { Clock, Video, MapPin, ExternalLink, Calendar as CalendarIcon } from 'lucide-react';
import type { GoogleCalendarEvent } from '../../../types';
import { formatTimeRange } from '../../../utils/calendarViewUtils';

interface GoogleEventBlockProps {
  event: GoogleCalendarEvent;
  onClick: () => void;
  compact?: boolean;
  style?: React.CSSProperties;
}

export function GoogleEventBlock({ event, onClick, compact = false, style }: GoogleEventBlockProps) {
  const isFree = event.transparency === 'transparent';

  const timeDisplay = useMemo(
    () => formatTimeRange(event.start_time, event.end_time),
    [event.start_time, event.end_time]
  );

  const hasVideoLink = !!(event.hangout_link || event.conference_data);
  const isOutlook = event.provider === 'microsoft';
  const providerLabel = isOutlook ? 'Outlook' : 'Google';
  // Outlook is amber, Google stays teal, so the two mirrors can be told apart at a glance.
  const tone = isOutlook
    ? { bg: 'bg-hud-rust/20', bgFree: 'bg-hud-rust/10', border: 'border-l-hud-rust', borderFree: 'border-l-hud-rust/50', text: 'text-hud-rust', badge: 'O' }
    : { bg: 'bg-hud-teal/20', bgFree: 'bg-hud-teal/10', border: 'border-l-hud-teal', borderFree: 'border-l-hud-teal/50', text: 'text-hud-teal', badge: 'G' };

  if (compact) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        style={style}
        title={`${providerLabel}: ${event.summary || '(No title)'}`}
        className={`w-full text-left px-2 py-1 rounded text-xs truncate border-l-2 hover:opacity-80 transition-opacity ${
          isFree
            ? `${tone.bgFree} ${tone.borderFree} text-hud-cream-dim border-dashed`
            : `${tone.bg} ${tone.border} text-hud-cream`
        }`}
      >
        <span className={`inline-block w-3 text-center text-[9px] font-bold leading-none mr-1 ${tone.text}`}>{tone.badge}</span>
        <span className="font-medium">{event.summary || '(No title)'}</span>
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={style}
      title={providerLabel}
      className={`absolute left-1 right-1 px-2 py-1 rounded-md border-l-4 hover:opacity-90 transition-opacity overflow-hidden text-left ${
        isFree
          ? `${tone.bgFree} ${tone.borderFree} border-dashed`
          : `${tone.bg} ${tone.border}`
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium truncate ${isFree ? 'text-hud-cream-dim' : 'text-hud-cream'}`}>
            {event.summary || '(No title)'}
          </p>
          {!event.all_day && (
            <p className="text-xs text-hud-cream-dim truncate flex items-center gap-1">
              <Clock className="w-3 h-3 flex-shrink-0" />
              {timeDisplay}
            </p>
          )}
          {event.location && (
            <p className="text-xs text-hud-cream-mute truncate flex items-center gap-1 mt-0.5">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              {event.location}
            </p>
          )}
          {!event.location && hasVideoLink && (
            <p className="text-xs text-hud-cream-mute truncate flex items-center gap-1 mt-0.5">
              <Video className="w-3 h-3 flex-shrink-0" />
              Google Meet
            </p>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-1">
          {event.html_link && (
            <ExternalLink className="w-3 h-3 text-hud-teal/60" />
          )}
          <div className={`w-5 h-5 rounded-full ${tone.bg} flex items-center justify-center`}>
            <CalendarIcon className={`w-3 h-3 ${tone.text}`} />
          </div>
        </div>
      </div>
    </button>
  );
}
