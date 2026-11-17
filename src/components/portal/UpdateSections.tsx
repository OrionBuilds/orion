import type { PortalUpdateSections } from '../../services/clientPortal';

/**
 * Expanded body of a "Project Updates" entry written in the sections.v1 format:
 * five labelled, plain-English blocks a non-technical client can scan on a phone.
 * Legacy entries (no sections) keep rendering their `detail` paragraph in the page.
 */
const LABELS: Array<[keyof Omit<PortalUpdateSections, 'check'>, string]> = [
  ['context', 'What took place'],
  ['changes', 'What we did'],
  ['impact', 'How it affects your software'],
  ['live_now', "What's live now"],
];

export function UpdateSections({ sections }: { sections: PortalUpdateSections }) {
  const check = (sections.check ?? []).filter((c) => c && c.trim());
  return (
    <div className="mt-1.5 pr-5 space-y-2">
      {LABELS.map(([key, label]) => {
        const value = sections[key];
        if (!value || !value.trim()) return null;
        return (
          <div key={key}>
            <p className="text-[10px] uppercase tracking-wide text-hud-cream-dim">{label}</p>
            <p className="text-xs text-hud-cream-mute leading-relaxed whitespace-pre-line">{value}</p>
          </div>
        );
      })}
      {check.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-hud-cream-dim">What to check</p>
          <ul className="list-disc ml-4 text-xs text-hud-cream-mute leading-relaxed space-y-0.5">
            {check.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
