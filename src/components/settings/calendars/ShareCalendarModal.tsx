import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Share2, X, Copy, Check, ExternalLink, Download, Loader2 } from 'lucide-react';
import { Portal } from '../../shared/Portal';

interface ShareCalendarModalProps {
  open: boolean;
  onClose: () => void;
  calendarName: string;
  calendarSlug: string;
  typeSlug?: string;
}

type Tab = 'link' | 'qr' | 'inline' | 'popup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'link', label: 'Public link' },
  { id: 'qr', label: 'QR code' },
  { id: 'inline', label: 'Inline embed' },
  { id: 'popup', label: 'Popup embed' },
];

// Generated in the browser (no QR web service): black on white with the standard 4-module quiet
// zone, error correction M, so printed and on-screen codes scan reliably.
const QR_OPTIONS = {
  errorCorrectionLevel: 'M' as const,
  margin: 4,
  color: { dark: '#000000', light: '#ffffff' },
};

function downloadFile(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function BookingQrPanel({ url, fileBase }: { url: string; fileBase: string }) {
  const [png, setPng] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const canCopyImage = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      QRCode.toDataURL(url, { ...QR_OPTIONS, width: 1024 }),
      QRCode.toString(url, { ...QR_OPTIONS, type: 'svg' }),
    ])
      .then(([pngUrl, svgText]) => {
        if (cancelled) return;
        setPng(pngUrl);
        setSvg(svgText);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not generate the QR code');
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const handleDownloadSvg = () => {
    if (!svg) return;
    const href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    downloadFile(href, `${fileBase}-qr.svg`);
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const handleCopyImage = async () => {
    if (!png) return;
    try {
      const blob = await (await fetch(png)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copying images is not allowed in this browser; download the PNG instead.');
    }
  };

  const buttonClass =
    'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm font-medium hover:bg-hud-bg-elev hover:text-white transition-colors disabled:opacity-50';

  return (
    <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-start">
      {/* Deliberately white (not a theme surface): the code needs dark-on-light contrast to scan. */}
      <div className="w-48 h-48 shrink-0 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#ffffff' }}>
        {png ? (
          <img src={png} alt={`QR code for ${url}`} className="w-full h-full rounded-lg" />
        ) : !error ? (
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        ) : null}
      </div>
      <div className="space-y-3 min-w-0">
        <p className="text-sm text-hud-cream-dim">
          Scanning this code opens the public booking page:
        </p>
        <p className="text-xs font-mono text-hud-cream-soft break-all">{url}</p>
        {error && <p className="text-xs text-hud-plum">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => png && downloadFile(png, `${fileBase}-qr.png`)}
            disabled={!png}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-hud-gold text-hud-bg-deep text-sm font-medium hover:bg-hud-gold-deep transition-colors disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            Download PNG
          </button>
          <button onClick={handleDownloadSvg} disabled={!svg} className={buttonClass}>
            <Download className="w-4 h-4" />
            Download SVG
          </button>
          {canCopyImage && (
            <button onClick={handleCopyImage} disabled={!png} className={buttonClass}>
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy image'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false
    );
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

export function ShareCalendarModal({
  open,
  onClose,
  calendarName,
  calendarSlug,
  typeSlug,
}: ShareCalendarModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('link');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!open) return null;

  const origin =
    typeof window !== 'undefined' ? window.location.origin : '';
  const widgetSrc =
    (import.meta.env.VITE_BOOKING_WIDGET_URL as string | undefined) ||
    `${origin}/booking-widget.js`;

  const publicPath = typeSlug
    ? `/book/${calendarSlug}/${typeSlug}`
    : `/book/${calendarSlug}`;
  const publicUrl = `${origin}${publicPath}`;

  const inlineSnippet = `<div id="orion-booking"></div>
<script src="${widgetSrc}"
  data-base-url="${origin}"
  data-calendar-slug="${calendarSlug}"${
    typeSlug ? `\n  data-type-slug="${typeSlug}"` : ''
  }
  data-mode="inline"
  data-target="#orion-booking"></script>`;

  const popupSnippet = `<script src="${widgetSrc}"
  data-base-url="${origin}"
  data-calendar-slug="${calendarSlug}"${
    typeSlug ? `\n  data-type-slug="${typeSlug}"` : ''
  }
  data-mode="popup"
  data-button-text="Book a meeting"
  data-primary-color="#0891b2"></script>`;

  const handleCopy = async (key: string, value: string) => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1500);
    }
  };

  return (
    <>
      <Portal><div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} /></Portal>
      <Portal><div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div
          className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-hud-gold/20 rounded-lg flex items-center justify-center">
                <Share2 className="w-5 h-5 text-hud-gold-soft" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Share</h2>
                <p className="text-xs text-hud-cream-dim">
                  {calendarName}
                  {typeSlug ? ` · ${typeSlug}` : ''}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-hud-cream-dim hover:text-white rounded"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-6 pt-4 border-b border-hud-bg-elev">
            <nav className="flex gap-6 overflow-x-auto">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`py-3 border-b-2 transition-colors text-sm font-medium whitespace-nowrap ${
                      isActive
                        ? 'border-hud-gold text-hud-gold-soft'
                        : 'border-transparent text-hud-cream-dim hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="p-6 space-y-4">
            {activeTab === 'link' && (
              <>
                <p className="text-sm text-hud-cream-dim">
                  Share this URL with clients to send them straight to the
                  booking page.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={publicUrl}
                    className="flex-1 px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    onClick={() => handleCopy('link', publicUrl)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-hud-gold text-hud-bg-deep text-sm font-medium hover:bg-hud-gold-deep transition-colors"
                  >
                    {copiedKey === 'link' ? (
                      <>
                        <Check className="w-4 h-4" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4" />
                        Copy
                      </>
                    )}
                  </button>
                  <a
                    href={publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm font-medium hover:bg-hud-bg-elev hover:text-white transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open
                  </a>
                </div>
              </>
            )}

            {activeTab === 'qr' && (
              <BookingQrPanel
                url={publicUrl}
                fileBase={typeSlug ? `${calendarSlug}-${typeSlug}` : calendarSlug}
              />
            )}

            {activeTab === 'inline' && (
              <>
                <p className="text-sm text-hud-cream-dim">
                  Drop this snippet into any page to render the booking
                  calendar inline. The widget will resize itself to fit its
                  contents.
                </p>
                <textarea
                  readOnly
                  value={inlineSnippet}
                  rows={8}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-xs font-mono focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={() => handleCopy('inline', inlineSnippet)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-hud-gold text-hud-bg-deep text-sm font-medium hover:bg-hud-gold-deep transition-colors"
                >
                  {copiedKey === 'inline' ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy snippet
                    </>
                  )}
                </button>
              </>
            )}

            {activeTab === 'popup' && (
              <>
                <p className="text-sm text-hud-cream-dim">
                  Add a floating "Book a meeting" button that opens the
                  calendar in a modal. Customize <code className="text-hud-cream-soft">data-button-text</code> and{' '}
                  <code className="text-hud-cream-soft">data-primary-color</code> to match your brand.
                </p>
                <textarea
                  readOnly
                  value={popupSnippet}
                  rows={8}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-xs font-mono focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={() => handleCopy('popup', popupSnippet)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-hud-gold text-hud-bg-deep text-sm font-medium hover:bg-hud-gold-deep transition-colors"
                >
                  {copiedKey === 'popup' ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy snippet
                    </>
                  )}
                </button>
              </>
            )}
          </div>

          <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div></Portal>
    </>
  );
}
