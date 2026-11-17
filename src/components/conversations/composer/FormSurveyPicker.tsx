import { useEffect, useRef, useState } from 'react';
import { X, Search, FileText, ListChecks, Loader2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { Portal } from '../../shared/Portal';

export interface PickerItem {
  kind: 'form' | 'survey';
  id: string;
  name: string;
  slug: string;
}

interface FormSurveyPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: PickerItem) => void;
}

interface SlugRow {
  id: string;
  name: string;
  public_slug: string;
}

export function FormSurveyPicker({ open, onClose, onSelect }: FormSurveyPickerProps) {
  const [forms, setForms] = useState<SlugRow[]>([]);
  const [surveys, setSurveys] = useState<SlugRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'forms' | 'surveys'>('forms');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [formsRes, surveysRes] = await Promise.all([
          supabase
            .from('forms')
            .select('id,name,public_slug')
            .eq('status', 'published')
            .not('public_slug', 'is', null)
            .order('updated_at', { ascending: false }),
          supabase
            .from('surveys')
            .select('id,name,public_slug')
            .eq('status', 'published')
            .not('public_slug', 'is', null)
            .order('updated_at', { ascending: false }),
        ]);
        if (cancelled) return;
        setForms((formsRes.data || []) as SlugRow[]);
        setSurveys((surveysRes.data || []) as SlugRow[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const items = (tab === 'forms' ? forms : surveys).filter(
    (i) => !search || i.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Portal><div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="bg-hud-bg-mid border border-hud-bg-elev rounded-xl shadow-2xl w-full max-w-md max-h-[70dvh] overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hud-bg-elev">
          <h3 className="text-sm font-semibold text-white">Insert form or survey link</h3>
          <button
            onClick={onClose}
            className="p-1 text-hud-cream-dim hover:text-white rounded"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex border-b border-hud-bg-elev">
          <button
            onClick={() => setTab('forms')}
            className={`flex-1 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'forms'
                ? 'border-hud-gold text-hud-gold-soft'
                : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft'
            }`}
          >
            <FileText size={14} className="inline mr-1.5 -mt-0.5" />
            Forms ({forms.length})
          </button>
          <button
            onClick={() => setTab('surveys')}
            className={`flex-1 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'surveys'
                ? 'border-hud-gold text-hud-gold-soft'
                : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft'
            }`}
          >
            <ListChecks size={14} className="inline mr-1.5 -mt-0.5" />
            Surveys ({surveys.length})
          </button>
        </div>

        <div className="p-3 border-b border-hud-bg-elev">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-mute pointer-events-none"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${tab}...`}
              className="w-full pl-8 pr-3 py-2 text-sm bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="text-hud-cream-mute animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-8 text-sm text-hud-cream-mute">
              No published {tab} found
            </div>
          ) : (
            <ul className="py-1">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() =>
                      onSelect({
                        kind: tab === 'forms' ? 'form' : 'survey',
                        id: item.id,
                        name: item.name,
                        slug: item.public_slug,
                      })
                    }
                    className="w-full text-left px-4 py-2.5 hover:bg-hud-bg-card transition-colors"
                  >
                    <div className="text-sm text-white truncate">{item.name}</div>
                    <div className="text-xs text-hud-cream-mute truncate font-mono">
                      /{tab === 'forms' ? 'f' : 's'}/{item.public_slug}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div></Portal>
  );
}
