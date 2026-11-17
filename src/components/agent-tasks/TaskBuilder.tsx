import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Bot, CalendarClock, ChevronDown, ChevronRight, Loader2, Pencil, Send,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import {
  BUILDER_CADENCES,
  describeCadence,
  LIMITS,
  OUTPUT_KINDS,
  RISK_TIERS,
  validateProposal,
  type BuilderAgent,
  type BuilderMessage,
  type CreateMode,
  type TaskProposal,
} from '../../../supabase/functions/_shared/agent-task-proposal';
import { converseTaskBuilder, createTaskFromProposal } from '../../services/agentTaskBuilder';
import type { AgentTaskSchedule } from '../../services/agentTasks';
import { AGENT_DIRECTORY, inputCls, labelCls } from './shared';

/**
 * Conversational task builder: pick an agent, describe the task, answer the assistant's clarifying
 * questions, confirm the proposal, and create the schedule (enabled) in one step. The assistant and
 * the insert both live in the agent-task-builder edge function; the confirm card re-validates edits
 * locally with the same validator the server uses so mistakes surface before the round trip.
 */

type Step = 'agent' | 'describe' | 'chat' | 'confirm';

const RISK_LABEL: Record<string, string> = {
  autonomous: 'Autonomous — runs and reports',
  owner_review: 'Owner review — output gated on you',
  client_visible: 'Client visible — always approval-gated',
};

const OUTPUT_LABEL: Record<string, string> = {
  owner_briefing: 'Owner briefing',
  client_deliverable: 'Client deliverable',
  housekeeping_report: 'Housekeeping report',
  none: 'None',
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const EXAMPLES: Record<BuilderAgent, string> = {
  clara: 'e.g. Every weekday at 7:30am, check my inbox for anything from clients that needs a reply today and send me a short list in my OS inbox.',
  friday: 'e.g. Every Monday morning, check all live client sites for broken links and slow pages and give me a summary with the worst offenders first.',
};

/** What the assistant proposed, as a text turn, so a follow-up ("make it weekly") has context. */
function proposalAsMessage(p: TaskProposal): string {
  return `I propose: "${p.title}". ${p.summary}\nSchedule: ${describeCadence(p)}. Risk: ${p.risk_tier}. Output: ${p.output_kind}${p.output_destination ? ` (${p.output_destination})` : ''}. Approval required: ${p.approval_required ? 'yes' : 'no'}.\nInstructions:\n${p.instructions}`.slice(0, LIMITS.messageChars);
}

/** Keep the owner's original ask plus the most recent turns within the server's message cap. */
function capped(msgs: BuilderMessage[]): BuilderMessage[] {
  if (msgs.length <= LIMITS.messages) return msgs;
  return [msgs[0], ...msgs.slice(msgs.length - (LIMITS.messages - 1))];
}

interface TaskBuilderProps {
  onCreated: (schedule: AgentTaskSchedule) => void;
  onCancel: () => void;
}

export function TaskBuilder({ onCreated, onCancel }: TaskBuilderProps) {
  const [step, setStep] = useState<Step>('agent');
  const [agent, setAgent] = useState<BuilderAgent | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const [adjustments, setAdjustments] = useState<string[]>([]);
  const [mode, setMode] = useState<CreateMode>('active');
  const [recommended, setRecommended] = useState<CreateMode>('active');
  const [model, setModel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

  const agentInfo = AGENT_DIRECTORY.find((a) => a.slug === agent);
  const lastIsUser = messages.length > 0 && messages[messages.length - 1].role === 'user';

  useEffect(() => { threadEnd.current?.scrollIntoView?.({ behavior: 'smooth' }); }, [messages, busy]);

  async function send(next: BuilderMessage[]) {
    if (!agent) return;
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const reply = await converseTaskBuilder(agent, capped(next));
      setModel(reply.model ?? null);
      if (reply.type === 'questions') {
        setMessages([...next, { role: 'assistant', content: reply.text }]);
        setStep('chat');
      } else {
        setProposal(reply.proposal);
        setAdjustments(reply.adjustments ?? []);
        setRecommended(reply.recommended_mode);
        setMode(reply.recommended_mode);
        setEditing(false);
        setShowInstructions(false);
        setStep('confirm');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The task assistant failed to respond');
      if (next.length === 1) {
        // First ask failed: put the text back in the box rather than leaving a dangling turn.
        setMessages([]);
        setDraft(next[0].content);
        setStep('describe');
      } else {
        setStep('chat');
      }
    } finally {
      setBusy(false);
    }
  }

  function submitDraft(text = draft) {
    const content = text.trim();
    if (!content || busy) return;
    void send([...messages, { role: 'user', content }]);
  }

  function backToChat() {
    if (!proposal) return;
    setMessages((prev) => [...prev, { role: 'assistant', content: proposalAsMessage(proposal) }]);
    setProposal(null);
    setStep('chat');
  }

  function patch(p: Partial<TaskProposal>) {
    setProposal((prev) => (prev ? { ...prev, ...p } : prev));
  }

  async function handleCreate() {
    if (!agent || !proposal) return;
    const v = validateProposal(proposal);
    if (!v.ok) { setError(v.errors.join('; ')); setEditing(true); return; }
    setBusy(true);
    setError(null);
    try {
      const { schedule } = await createTaskFromProposal({
        agent,
        proposal: v.proposal,
        mode,
        messages: capped([...messages, { role: 'assistant', content: proposalAsMessage(v.proposal) }]),
        model,
      });
      onCreated(schedule);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the task');
    } finally {
      setBusy(false);
    }
  }

  const errorBanner = error && (
    <div className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30">
      <p className="text-sm text-hud-plum/40">{error}</p>
    </div>
  );

  // --- step 1: pick an agent -----------------------------------------------------------------
  if (step === 'agent') {
    return (
      <div className="p-4 space-y-3">
        <p className="text-sm text-hud-cream-soft">Who should do this?</p>
        {AGENT_DIRECTORY.map((a) => (
          <button
            key={a.slug}
            type="button"
            onClick={() => { setAgent(a.slug); setStep('describe'); }}
            className="w-full flex items-start gap-3 p-4 rounded-xl border border-hud-bg-elev bg-hud-bg-card hover:border-hud-gold/50 hover:bg-hud-bg-card/70 text-left transition-colors"
          >
            <Bot className="w-5 h-5 mt-0.5 text-hud-gold-soft shrink-0" />
            <span>
              <span className="block text-sm font-semibold text-white">{a.label}</span>
              <span className="block text-xs text-hud-cream-mute mt-0.5">{a.blurb}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  const header = agentInfo && (
    <div className="flex items-center gap-2 text-xs text-hud-cream-mute">
      <Bot className="w-4 h-4 text-hud-gold-soft" />
      <span className="font-semibold text-hud-cream-soft">{agentInfo.label}</span>
      <span>·</span>
      <span className="truncate">{agentInfo.blurb}</span>
      {step === 'describe' && (
        <button type="button" onClick={() => setStep('agent')} className="ml-auto text-hud-gold-soft hover:underline">
          Change
        </button>
      )}
    </div>
  );

  // --- step 2: describe ----------------------------------------------------------------------
  if (step === 'describe') {
    return (
      <div className="p-4 space-y-4">
        {header}
        {errorBanner}
        <div>
          <label className={labelCls} htmlFor="task-builder-describe">
            Describe what you want {agentInfo?.label} to do
          </label>
          <textarea
            id="task-builder-describe"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitDraft(); }}
            rows={5}
            maxLength={LIMITS.messageChars}
            placeholder={agent ? EXAMPLES[agent] : ''}
            className={inputCls}
            autoFocus
          />
          <p className="text-xs text-hud-cream-mute mt-1">
            Plain English is fine. {agentInfo?.label} will ask a few questions if anything is unclear.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-hud-cream-soft hover:bg-hud-bg-card transition-colors">
            Cancel
          </button>
          <button type="button" onClick={() => submitDraft()} disabled={!draft.trim() || busy}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all font-medium text-sm disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Continue
          </button>
        </div>
      </div>
    );
  }

  // --- step 3: clarifying questions ----------------------------------------------------------
  if (step === 'chat') {
    return (
      <div className="flex flex-col">
        <div className="p-4 pb-2">{header}</div>
        <div className="px-4 space-y-3 max-h-[45dvh] overflow-y-auto" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-hud-gold/15 border border-hud-gold/30 text-white'
                  : 'bg-hud-bg-card border border-hud-bg-elev text-hud-cream-soft'
              }`}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs text-hud-cream-mute">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {agentInfo?.label} is thinking…
            </div>
          )}
          <div ref={threadEnd} />
        </div>
        <div className="p-4 space-y-2 border-t border-hud-bg-card mt-3">
          {errorBanner}
          {error && lastIsUser && !busy && (
            <button type="button" onClick={() => void send(messages)}
              className="text-xs text-hud-gold-soft hover:underline">
              Retry
            </button>
          )}
          <div className="flex gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitDraft(); } }}
              rows={2}
              maxLength={LIMITS.messageChars}
              disabled={busy}
              placeholder="Type your answer… (Enter to send, Shift+Enter for a new line)"
              className={`${inputCls} resize-none`}
              aria-label="Your answer"
            />
            <button type="button" onClick={() => submitDraft()} disabled={!draft.trim() || busy}
              aria-label="Send"
              className="self-end p-2.5 rounded-lg bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/40 hover:bg-hud-gold/30 disabled:opacity-40">
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="flex justify-between">
            <button type="button" onClick={onCancel}
              className="px-3 py-1.5 rounded-lg text-xs text-hud-cream-dim hover:bg-hud-bg-card transition-colors">
              Cancel
            </button>
            <button type="button" disabled={busy}
              onClick={() => void send([...messages, { role: 'user', content: 'Please propose the task now, using sensible defaults for anything still open.' }])}
              className="px-3 py-1.5 rounded-lg text-xs text-hud-gold-soft hover:bg-hud-bg-card transition-colors disabled:opacity-40">
              Skip questions — propose now
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- step 4: confirm -----------------------------------------------------------------------
  if (!proposal) return null;
  const forcedApproval = proposal.risk_tier === 'client_visible' || proposal.external_effects;
  const risky = proposal.external_effects || proposal.risk_tier === 'client_visible';

  return (
    <div className="p-4 space-y-4">
      {header}
      {errorBanner}

      <div className="rounded-xl border border-hud-bg-elev bg-hud-bg-card/60 p-4 space-y-3">
        {editing ? (
          <div>
            <label className={labelCls}>Title</label>
            <input type="text" value={proposal.title} maxLength={LIMITS.title}
              onChange={(e) => patch({ title: e.target.value })} className={inputCls} />
          </div>
        ) : (
          <h4 className="text-base font-semibold text-white">{proposal.title}</h4>
        )}

        {editing ? (
          <div>
            <label className={labelCls}>What will happen</label>
            <textarea value={proposal.summary} rows={3} maxLength={LIMITS.summary}
              onChange={(e) => patch({ summary: e.target.value })} className={inputCls} />
          </div>
        ) : (
          <p className="text-sm text-hud-cream-soft whitespace-pre-wrap">{proposal.summary}</p>
        )}

        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Cadence</label>
                <select value={proposal.cadence}
                  onChange={(e) => {
                    const cadence = e.target.value as TaskProposal['cadence'];
                    patch({
                      cadence,
                      days_of_week: cadence === 'weekly' ? (proposal.days_of_week?.length ? proposal.days_of_week : [1]) : null,
                      day_of_month: cadence === 'monthly' ? (proposal.day_of_month ?? 1) : null,
                    });
                  }}
                  className={inputCls}>
                  {BUILDER_CADENCES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Time ({proposal.timezone})</label>
                <input type="time" value={proposal.time_of_day}
                  onChange={(e) => patch({ time_of_day: e.target.value })} className={inputCls} />
              </div>
            </div>
            {proposal.cadence === 'weekly' && (
              <div className="flex gap-1.5">
                {DOW.map((d, i) => {
                  const on = proposal.days_of_week?.includes(i) ?? false;
                  return (
                    <button key={d} type="button"
                      onClick={() => {
                        const cur = proposal.days_of_week ?? [];
                        patch({ days_of_week: on ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b) });
                      }}
                      className={`flex-1 px-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        on ? 'bg-hud-gold/20 text-hud-gold-soft border-hud-gold/40'
                          : 'bg-hud-bg-card text-hud-cream-dim border-hud-bg-elev hover:border-hud-cream-mute'
                      }`}>
                      {d}
                    </button>
                  );
                })}
              </div>
            )}
            {proposal.cadence === 'monthly' && (
              <div>
                <label className={labelCls}>Day of month</label>
                <input type="number" min={1} max={31} value={proposal.day_of_month ?? 1}
                  onChange={(e) => patch({ day_of_month: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
                  className={inputCls} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Risk tier</label>
                <select value={proposal.risk_tier}
                  onChange={(e) => patch({ risk_tier: e.target.value as TaskProposal['risk_tier'] })} className={inputCls}>
                  {RISK_TIERS.map((r) => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Output</label>
                <select value={proposal.output_kind}
                  onChange={(e) => patch({ output_kind: e.target.value as TaskProposal['output_kind'] })} className={inputCls}>
                  {OUTPUT_KINDS.map((o) => <option key={o} value={o}>{OUTPUT_LABEL[o]}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>Where the result goes</label>
              <input type="text" value={proposal.output_destination} maxLength={LIMITS.outputDestination}
                placeholder="e.g. Your OS inbox"
                onChange={(e) => patch({ output_destination: e.target.value })} className={inputCls} />
            </div>
            <label className="flex items-center gap-2 text-sm text-hud-cream-soft">
              <input type="checkbox" checked={proposal.external_effects}
                onChange={(e) => patch({ external_effects: e.target.checked })}
                className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold" />
              Sends things outside the OS or spends money
            </label>
            <label className={`flex items-center gap-2 text-sm ${forcedApproval ? 'text-hud-cream-mute' : 'text-hud-cream-soft'}`}>
              <input type="checkbox" checked={forcedApproval || proposal.approval_required} disabled={forcedApproval}
                onChange={(e) => patch({ approval_required: e.target.checked })}
                className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold" />
              Approval required before output is delivered
              {forcedApproval && <span className="text-xs text-hud-gold-soft">(required for this kind of task)</span>}
            </label>
          </div>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-hud-cream-mute">When</dt>
            <dd className="text-hud-cream-soft flex items-center gap-1.5">
              <CalendarClock className="w-3.5 h-3.5 text-hud-gold-soft" /> {describeCadence(proposal)}
            </dd>
            <dt className="text-hud-cream-mute">Risk tier</dt>
            <dd className="text-hud-cream-soft">{RISK_LABEL[proposal.risk_tier]}</dd>
            <dt className="text-hud-cream-mute">Output</dt>
            <dd className="text-hud-cream-soft">
              {OUTPUT_LABEL[proposal.output_kind]}{proposal.output_destination ? ` — ${proposal.output_destination}` : ''}
            </dd>
            <dt className="text-hud-cream-mute">Approval</dt>
            <dd className="text-hud-cream-soft flex items-center gap-1.5">
              {proposal.approval_required
                ? <><ShieldCheck className="w-3.5 h-3.5 text-hud-gold-soft" /> Required before anything is delivered</>
                : 'Not required'}
            </dd>
            {proposal.scope && (<><dt className="text-hud-cream-mute">Scope</dt><dd className="text-hud-cream-soft">{proposal.scope}</dd></>)}
            {proposal.success_criteria && (
              <><dt className="text-hud-cream-mute">Success</dt><dd className="text-hud-cream-soft">{proposal.success_criteria}</dd></>
            )}
          </dl>
        )}

        <div>
          {editing ? (
            <>
              <label className={labelCls}>Instructions for {agentInfo?.label}</label>
              <textarea value={proposal.instructions} rows={8} maxLength={LIMITS.instructions}
                onChange={(e) => patch({ instructions: e.target.value })}
                className={`${inputCls} font-mono text-xs`} spellCheck={false} />
            </>
          ) : (
            <>
              <button type="button" onClick={() => setShowInstructions((s) => !s)}
                className="flex items-center gap-1 text-xs text-hud-gold-soft hover:underline">
                {showInstructions ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Instructions {agentInfo?.label} will follow
              </button>
              {showInstructions && (
                <pre className="mt-2 p-3 rounded-lg bg-hud-bg-mid border border-hud-bg-elev text-xs text-hud-cream-soft whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
                  {proposal.instructions}
                </pre>
              )}
            </>
          )}
        </div>
      </div>

      {adjustments.length > 0 && (
        <ul className="text-xs text-hud-cream-mute space-y-1">
          {adjustments.map((a) => (
            <li key={a} className="flex items-start gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-hud-gold-soft shrink-0 mt-px" /> {a}</li>
          ))}
        </ul>
      )}

      <div>
        <label className={labelCls}>Start in</label>
        <div className="grid grid-cols-2 gap-2">
          {(['shadow', 'active'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`px-3 py-2 rounded-lg text-left border transition-colors ${
                mode === m ? 'bg-hud-gold/20 border-hud-gold/40' : 'bg-hud-bg-card border-hud-bg-elev hover:border-hud-cream-mute'
              }`}>
              <span className={`block text-xs font-semibold uppercase tracking-wide ${mode === m ? 'text-hud-gold-soft' : 'text-hud-cream-dim'}`}>
                {m}{recommended === m ? ' · recommended' : ''}
              </span>
              <span className="block text-xs text-hud-cream-mute mt-0.5">
                {m === 'shadow' ? 'Dry run: records what it would do, no side effects' : 'Live: runs for real on schedule'}
              </span>
            </button>
          ))}
        </div>
        {risky && mode === 'active' && (
          <p className="flex items-start gap-1.5 text-xs text-hud-rust mt-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            This task can reach people outside the OS or spend money. Anything it sends still waits for your approval.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={backToChat} disabled={busy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-hud-cream-soft hover:bg-hud-bg-card transition-colors disabled:opacity-50">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setEditing((e) => !e)} disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-hud-cream-soft hover:bg-hud-bg-card transition-colors disabled:opacity-50">
            <Pencil className="w-4 h-4" /> {editing ? 'Done editing' : 'Edit'}
          </button>
          <button type="button" onClick={() => void handleCreate()} disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all font-medium text-sm disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Create &amp; enable
          </button>
        </div>
      </div>
    </div>
  );
}
