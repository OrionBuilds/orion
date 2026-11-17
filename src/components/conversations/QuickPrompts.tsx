export interface QuickPrompt {
  label: string;
  text: string;
  /** true: send as is. false: drop into the box so the owner can finish it ("Email ..."). */
  send: boolean;
}

const CLARA: QuickPrompt[] = [
  { label: "What's on today?", text: "What's on my plate today? Give me my calendar, anything overdue and anything waiting on me.", send: true },
  { label: 'Approvals', text: 'What approvals are waiting for me? List them with what each one is.', send: true },
  { label: 'New messages', text: 'Summarize my new messages and emails and tell me which ones need me.', send: true },
  { label: 'This week', text: "What's on my calendar for the next 7 days?", send: true },
  { label: "Friday's work", text: "What is Friday working on right now, and is anything stuck?", send: true },
  { label: 'Delegate to Friday', text: 'Delegate to Friday: ', send: false },
  { label: 'Create a task', text: 'Create a task: ', send: false },
  { label: 'Email…', text: 'Email ', send: false },
  { label: 'Text…', text: 'Text ', send: false },
  { label: 'Book a meeting', text: 'Put a meeting on my calendar: ', send: false },
];

const FRIDAY: QuickPrompt[] = [
  { label: 'What are you on?', text: 'What are you working on right now and what is queued?', send: true },
  { label: 'Anything stuck?', text: 'Is anything blocked or waiting on me?', send: true },
  { label: 'New request', text: '', send: false },
];

export function quickPromptsFor(mode: string | null | undefined): QuickPrompt[] {
  if (mode === 'clara') return CLARA;
  if (mode === 'friday') return FRIDAY;
  return [];
}

/** A horizontally scrolling row of one-tap prompts above the composer. */
export function QuickPrompts({ prompts, onPick }: { prompts: QuickPrompt[]; onPick: (p: QuickPrompt) => void }) {
  if (prompts.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto border-t border-hud-bg-elev bg-hud-bg-card px-3 py-2 snap-x-row" data-testid="quick-prompts">
      {prompts.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onPick(p)}
          className="shrink-0 rounded-full border border-hud-cream-mute/60 bg-hud-bg-mid px-3 py-1.5 text-xs font-medium text-hud-cream-soft touch-manipulation active:bg-hud-bg-elev"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
