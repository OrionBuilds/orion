import ReactMarkdown from 'react-markdown';

/** On/off switch, same look as the settings switches. */
export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-hud-gold' : 'bg-hud-bg-elev'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

/** Agent output / role prompts, styled like Memory's note reader. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-3 break-words text-sm leading-relaxed text-hud-cream-soft [&_a]:text-hud-teal [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-hud-gold/50 [&_blockquote]:pl-3 [&_blockquote]:text-hud-cream-dim [&_code]:rounded [&_code]:bg-hud-bg-card [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-white [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-white [&_h3]:font-semibold [&_h3]:text-white [&_hr]:border-hud-bg-elev [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-hud-bg-card [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer">{c}</a> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
