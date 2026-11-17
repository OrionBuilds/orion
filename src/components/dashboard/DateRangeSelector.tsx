import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { getDateRangePresets, type DateRange } from '../../services/dashboard';

interface DateRangeSelectorProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function DateRangeSelector({ value, onChange }: DateRangeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const presets = getDateRangePresets();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white hover:bg-hud-bg-elev transition-colors focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
      >
        <Calendar className="h-4 w-4 text-hud-cream-dim" />
        <span>{value.label}</span>
        <ChevronDown className={`h-4 w-4 text-hud-cream-dim transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50">
          <div className="py-1">
            {presets.map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  onChange(preset);
                  setIsOpen(false);
                }}
                className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                  value.label === preset.label
                    ? 'bg-hud-gold/10 text-hud-gold-soft'
                    : 'text-hud-cream-soft hover:bg-hud-bg-elev'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
