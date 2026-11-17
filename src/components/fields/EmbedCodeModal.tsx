import { useState } from 'react';
import { X, Copy, ExternalLink } from 'lucide-react';
import { Portal } from '../shared/Portal';

type EmbedKind = 'form' | 'survey';

const KIND = {
  form: {
    noun: 'Form',
    path: 'f',
    containerPrefix: 'orion-form',
    slugAttr: 'data-form-slug',
    popupButtonText: 'Get in touch',
  },
  survey: {
    noun: 'Survey',
    path: 's',
    containerPrefix: 'orion-survey',
    slugAttr: 'data-survey-slug',
    popupButtonText: 'Take Survey',
  },
} as const satisfies Record<EmbedKind, unknown>;

/**
 * Embed / share modal for public forms and surveys.
 *
 * The two copies differed only in five strings (noun, URL segment, container id
 * prefix, slug data-attribute, popup button label), so those are the config above.
 */
export function EmbedCodeModal({
  slug,
  kind,
  onClose,
}: {
  slug: string | null;
  kind: EmbedKind;
  onClose: () => void;
}) {
  const [embedType, setEmbedType] = useState<'inline' | 'popup' | 'link'>('inline');
  const [copied, setCopied] = useState(false);

  const cfg = KIND[kind];
  const baseUrl = window.location.origin;
  const publicUrl = `${baseUrl}/${cfg.path}/${slug}`;
  const containerId = `${cfg.containerPrefix}-${slug}`;

  function getEmbedCode() {
    if (embedType === 'link') return publicUrl;

    if (embedType === 'popup') {
      return `<script src="${baseUrl}/forms-widget.js"
  data-base-url="${baseUrl}"
  ${cfg.slugAttr}="${slug}"
  data-mode="popup"
  data-button-text="${cfg.popupButtonText}"
  data-primary-color="#0891b2"></script>`;
    }

    return `<div id="${containerId}"></div>
<script src="${baseUrl}/forms-widget.js"
  data-base-url="${baseUrl}"
  ${cfg.slugAttr}="${slug}"
  data-mode="inline"
  data-target="#${containerId}"></script>`;
  }

  function handleCopy() {
    navigator.clipboard.writeText(getEmbedCode());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-hud-bg-card rounded-xl shadow-xl w-full max-w-2xl max-h-[80dvh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">Embed {cfg.noun}</h2>
          <button onClick={onClose} className="p-2 hover:bg-hud-bg-elev rounded-lg">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Embed Type</label>
            <div className="flex gap-2">
              {[
                { id: 'inline', label: 'Inline', desc: 'Embed directly in page' },
                { id: 'popup', label: 'Popup', desc: 'Floating button + modal' },
                { id: 'link', label: 'Link', desc: 'Share customer-facing URL' },
              ].map((type) => (
                <button
                  key={type.id}
                  onClick={() => setEmbedType(type.id as typeof embedType)}
                  className={`flex-1 p-3 rounded-lg border-2 text-left transition-colors ${
                    embedType === type.id
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-hud-bg-elev hover:border-hud-cream-mute'
                  }`}
                >
                  <div className="font-medium text-white">{type.label}</div>
                  <div className="text-xs text-hud-cream-dim">{type.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-hud-cream-soft">
                {embedType === 'link' ? 'Direct Link' : 'Embed Code'}
              </label>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-3 py-1 text-sm text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors"
              >
                {copied ? 'Copied!' : <><Copy className="w-4 h-4" /> Copy</>}
              </button>
            </div>
            <pre className="bg-hud-bg-mid text-hud-cream p-4 rounded-lg text-sm overflow-x-auto whitespace-pre-wrap">
              {getEmbedCode()}
            </pre>
          </div>

          {embedType === 'link' && (
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open {cfg.noun}
            </a>
          )}
        </div>
      </div>
    </div></Portal>
  );
}
