import { Mail, Phone, Building2, MoreVertical } from 'lucide-react';
import type { Contact } from '../../types';
import { LeadScoreBadge } from './LeadScoreBadge';

/**
 * Phone layout for the contacts list: one card per contact instead of a horizontally scrolling table.
 * Tapping the card opens the contact; the checkbox and the menu button do not.
 */
export function ContactCardList({
  contacts,
  selected,
  onToggle,
  onOpen,
  onMenu,
}: {
  contacts: Contact[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onMenu: (e: React.MouseEvent, contact: Contact) => void;
}) {
  return (
    <ul className="divide-y divide-hud-bg-card" data-testid="contact-cards">
      {contacts.map((c) => {
        const name = `${c.first_name} ${c.last_name ?? ''}`.trim();
        const initials = `${c.first_name?.[0] ?? ''}${c.last_name?.[0] ?? ''}`.toUpperCase();
        return (
          <li key={c.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(c.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c.id); }}
              className="flex items-start gap-3 px-3 py-3 active:bg-hud-bg-card/60 touch-manipulation"
            >
              <label className="flex items-center justify-center w-9 h-11 -ml-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${name}`}
                  checked={selected.has(c.id)}
                  onChange={() => onToggle(c.id)}
                  className="w-5 h-5 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
                />
              </label>
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center shrink-0">
                <span className="text-sm font-semibold text-white">{initials}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-white truncate">{name}</p>
                  {typeof c.lead_score === 'number' && c.lead_score > 0 && <LeadScoreBadge score={c.lead_score} size="sm" />}
                </div>
                {(c.job_title || c.company) && (
                  <p className="flex items-center gap-1.5 text-xs text-hud-cream-dim truncate">
                    {c.company && <Building2 className="w-3 h-3 shrink-0" />}
                    <span className="truncate">{[c.job_title, c.company].filter(Boolean).join(' · ')}</span>
                  </p>
                )}
                {c.email && (
                  <p className="flex items-center gap-1.5 text-xs text-hud-cream-soft truncate mt-0.5">
                    <Mail className="w-3 h-3 text-hud-cream-mute shrink-0" /><span className="truncate">{c.email}</span>
                  </p>
                )}
                {c.phone && (
                  <p className="flex items-center gap-1.5 text-xs text-hud-cream-soft mt-0.5">
                    <Phone className="w-3 h-3 text-hud-cream-mute shrink-0" />{c.phone}
                  </p>
                )}
                {(c.tags?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {c.tags!.slice(0, 2).map((t) => (
                      <span key={t.id} className="px-2 py-0.5 rounded text-[11px] font-medium" style={{ backgroundColor: `${t.color}20`, color: t.color }}>
                        {t.name}
                      </span>
                    ))}
                    {c.tags!.length > 2 && <span className="text-[11px] text-hud-cream-dim self-center">+{c.tags!.length - 2}</span>}
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label={`Actions for ${name}`}
                onClick={(e) => onMenu(e, c)}
                className="w-11 h-11 -mr-2 flex items-center justify-center rounded-lg text-hud-cream-dim hover:bg-hud-bg-elev shrink-0"
              >
                <MoreVertical className="w-5 h-5" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
