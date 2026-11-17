import { useState } from 'react';
import { X } from 'lucide-react';
import { Portal } from '../../shared/Portal';

interface LinkDialogProps {
  initialText: string;
  onInsert: (url: string, text: string) => void;
  onClose: () => void;
}

function normalizeUrl(u: string): string {
  const t = u.trim();
  if (!t) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(t)) return t;
  return `https://${t}`;
}

/** Small dialog for the composer "insert link" action. Pre-fills the display
 *  text with the user's current selection; inserts a hyperlink on confirm. */
export function LinkDialog({ initialText, onInsert, onClose }: LinkDialogProps) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState(initialText);

  const submit = () => {
    const u = normalizeUrl(url);
    if (!u) return;
    onInsert(u, text.trim() || u);
  };

  return (
    <Portal><div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
      onClick={onClose}
    >
      <div
        className="bg-hud-bg-card rounded-xl border border-hud-bg-elev w-full max-w-md p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Insert link</h3>
          <button onClick={onClose} className="p-1 hover:bg-hud-bg-elev rounded transition-colors">
            <X size={16} className="text-hud-cream-dim" />
          </button>
        </div>

        <label className="block text-xs text-hud-cream-dim mb-1">URL</label>
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="https://example.com"
          className="w-full mb-3 px-3 py-2 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
        />

        <label className="block text-xs text-hud-cream-dim mb-1">Text to display</label>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Link text"
          className="w-full mb-4 px-3 py-2 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-sm text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
        />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-hud-cream-soft hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!url.trim()}
            className="px-4 py-1.5 text-sm font-medium text-white hover:text-hud-bg-deep bg-hud-gold-deep rounded-lg hover:bg-hud-gold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Insert
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
