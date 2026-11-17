import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  CornerDownRight,
  FileText,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Table2,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  TIMEFRAME_OPTIONS,
  generateReport,
  getAvailableScopes,
  getReportThread,
  getScopeLabel,
  pollReportStatus,
} from '../../services/aiReports';
import { REFINEMENT_SUGGESTIONS, getAvailableReportTemplates } from '../../config/reportTemplates';
import type { AIReport, ReportScope } from '../../types/aiReports';
import { formatDateShort } from '../../utils/formatters';
import { ReportKPIGrid } from './ReportKPICard';
import { AIReportChart } from './AIReportChart';

/** One question/answer pair in the generator thread. */
interface ThreadTurn {
  key: string;
  prompt: string;
  status: 'running' | 'complete' | 'failed';
  report?: AIReport;
  error?: string;
}

const THREAD_PARAM = 'thread';
const SUMMARY_PREVIEW_CHARS = 900;

/** Thrown from the poll callback to stop polling once the generator unmounts. */
class PollCancelled extends Error {}

function turnFromReport(report: AIReport): ThreadTurn {
  return {
    key: report.id,
    prompt: report.prompt,
    status: report.status,
    report,
    error: report.status === 'failed' ? report.error_message || 'Report generation failed' : undefined,
  };
}

interface ReportGeneratorProps {
  /** Called when a report is created or finishes, so the page can refresh its list and stats. */
  onReportsChanged?: () => void;
}

/**
 * The /reporting "Generate Report" card. Ask for a report, read the answer inline, then refine
 * it in the same thread ("break that down by month", "only enterprise clients"). Each turn is
 * a saved ai_reports row whose parent_report_id is the previous turn, so ai-report-generate
 * plans the follow-up with the thread's history and last queries. This absorbed the old
 * Full Chat page (/reporting/ai), which offered the same follow-up threading on its own page.
 *
 * The newest report id lives in ?thread=, so the conversation survives "View full report"
 * and back, and a report from the list can be continued here.
 */
export function ReportGenerator({ onReportsChanged }: ReportGeneratorProps) {
  const navigate = useNavigate();
  const { user, isFeatureEnabled } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const threadParam = searchParams.get(THREAD_PARAM);

  const [prompt, setPrompt] = useState('');
  const [scope, setScope] = useState<ReportScope>('my');
  const [timeframe, setTimeframe] = useState('last_30_days');
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoadingThread, setIsLoadingThread] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const mountedRef = useRef(true);
  const leafIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const roleName = user?.role?.name;
  const departmentId = user?.department_id;
  const availableScopes = useMemo(() => getAvailableScopes(roleName, departmentId), [roleName, departmentId]);
  const templates = useMemo(() => getAvailableReportTemplates(isFeatureEnabled), [isFeatureEnabled]);

  const lastComplete = [...turns].reverse().find((t) => t.status === 'complete' && t.report);
  const parentReport = lastComplete?.report ?? null;
  const lastTurn = turns[turns.length - 1];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep the selected scope valid if the role/department list changes.
  useEffect(() => {
    if (!availableScopes.some((s) => s.value === scope)) setScope('my');
  }, [availableScopes, scope]);

  useEffect(() => {
    if (turns.length > 0) threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns]);

  const setLeaf = useCallback(
    (reportId: string | null) => {
      leafIdRef.current = reportId;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (reportId) next.set(THREAD_PARAM, reportId);
          else next.delete(THREAD_PARAM);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /** Waits for a running report and writes the outcome into its turn. */
  const waitForReport = useCallback(
    async (reportId: string, turnKey: string) => {
      try {
        const done = await pollReportStatus(reportId, () => {
          if (!mountedRef.current) throw new PollCancelled();
        });
        if (!mountedRef.current) return;
        setTurns((prev) => prev.map((t) => (t.key === turnKey ? { ...turnFromReport(done), key: turnKey } : t)));
        if (done.status === 'complete') setLeaf(done.id);
      } catch (err) {
        if (err instanceof PollCancelled || !mountedRef.current) return;
        setTurns((prev) =>
          prev.map((t) =>
            t.key === turnKey
              ? { ...t, status: 'failed', error: err instanceof Error ? err.message : 'Something went wrong' }
              : t,
          ),
        );
      } finally {
        if (mountedRef.current) {
          setIsGenerating(false);
          onReportsChanged?.();
        }
      }
    },
    [onReportsChanged, setLeaf],
  );

  // Load (or switch to) the thread named in ?thread= - e.g. back from a report, or "Continue
  // in generator" from the reports list. Skipped when the param is the thread we already show.
  useEffect(() => {
    if (!threadParam || threadParam === leafIdRef.current || isGenerating) return;
    let cancelled = false;
    setIsLoadingThread(true);
    getReportThread(threadParam)
      .then((reports) => {
        if (cancelled || !mountedRef.current) return;
        leafIdRef.current = threadParam;
        setTurns(reports.map(turnFromReport));
        const leaf = reports[reports.length - 1];
        if (leaf?.scope && availableScopes.some((s) => s.value === leaf.scope)) setScope(leaf.scope);
        if (leaf?.status === 'running') {
          setIsGenerating(true);
          void waitForReport(leaf.id, leaf.id);
        }
      })
      .catch(() => {
        if (!cancelled) setTurns([]);
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setIsLoadingThread(false);
      });
    return () => {
      cancelled = true;
    };
    // availableScopes is derived from the user each render; the thread id is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadParam]);

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || !user || isGenerating) return;

    const turnKey = crypto.randomUUID();
    setTurns((prev) => [...prev, { key: turnKey, prompt: text, status: 'running' }]);
    setPrompt('');
    setIsGenerating(true);

    try {
      const result = await generateReport(user.organization_id, user.id, {
        prompt: text,
        scope,
        timeframe: { type: 'preset', preset: timeframe },
        parent_report_id: parentReport?.id,
      });
      if (!result.success) {
        setTurns((prev) =>
          prev.map((t) => (t.key === turnKey ? { ...t, status: 'failed', error: result.error || 'Could not start the report' } : t)),
        );
        setIsGenerating(false);
        return;
      }
      onReportsChanged?.();
      await waitForReport(result.report_id, turnKey);
    } catch (err) {
      setTurns((prev) =>
        prev.map((t) =>
          t.key === turnKey ? { ...t, status: 'failed', error: err instanceof Error ? err.message : 'Something went wrong' } : t,
        ),
      );
      setIsGenerating(false);
    }
  };

  const startNewThread = () => {
    setTurns([]);
    setExpanded({});
    setPrompt('');
    setLeaf(null);
    inputRef.current?.focus();
  };

  const applySuggestion = (text: string) => {
    setPrompt(text);
    inputRef.current?.focus();
  };

  const selectClass =
    'appearance-none [color-scheme:dark] h-full min-h-[46px] pl-4 pr-10 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-sm text-hud-cream focus:outline-none focus:ring-2 focus:ring-hud-gold cursor-pointer disabled:opacity-60';

  return (
    <div className="bg-hud-bg-card/50 backdrop-blur rounded-xl border border-hud-bg-elev p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-hud-gold-soft" />
          <h2 className="text-lg font-semibold text-white">Generate Report</h2>
        </div>
        {turns.length > 0 && (
          <button
            onClick={startNewThread}
            disabled={isGenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-hud-cream-soft border border-hud-cream-mute/60 rounded-lg hover:bg-hud-bg-elev hover:text-white transition-colors disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            New report
          </button>
        )}
      </div>

      {(turns.length > 0 || isLoadingThread) && (
        <div className="mb-5 space-y-4 max-h-[60dvh] overflow-y-auto pr-1" aria-live="polite">
          {isLoadingThread && turns.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-hud-cream-dim">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading conversation...
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.key} className="space-y-3">
              <div className="flex justify-end">
                <div className="max-w-[85%] bg-hud-bg-elev rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-hud-cream whitespace-pre-wrap">
                  {turn.prompt}
                </div>
              </div>
              <ReportAnswer
                turn={turn}
                expanded={!!expanded[turn.key]}
                onToggleExpanded={() => setExpanded((prev) => ({ ...prev, [turn.key]: !prev[turn.key] }))}
                onOpen={(id) => navigate(`/reporting/${id}`, { state: { fromThread: true } })}
              />
            </div>
          ))}
          <div ref={threadEndRef} />
        </div>
      )}

      {parentReport && (
        <div className="flex items-center gap-2 mb-2 text-xs text-hud-cream-dim">
          <CornerDownRight className="w-3.5 h-3.5 text-hud-gold-soft" />
          <span className="truncate">
            Following up on <span className="text-hud-cream-soft">{parentReport.result_json?.title || parentReport.report_name}</span>
          </span>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-3">
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          rows={2}
          aria-label="Describe the report you need"
          placeholder={
            parentReport
              ? 'Ask a follow-up... e.g. "break that down by month" or "only enterprise clients"'
              : 'Describe the report you need... e.g. "Project status and progress by client"'
          }
          className="flex-1 min-h-[46px] px-4 py-3 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-hud-cream placeholder:text-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent resize-y"
          disabled={isGenerating}
        />

        <div className="flex gap-3">
          <div className="relative">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as ReportScope)}
              disabled={isGenerating}
              aria-label="Data scope"
              className={selectClass}
            >
              {availableScopes.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-hud-bg-elev text-hud-cream">
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim pointer-events-none" />
          </div>

          <div className="relative">
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              disabled={isGenerating}
              aria-label="Date range"
              className={selectClass}
            >
              {TIMEFRAME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-hud-bg-elev text-hud-cream">
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim pointer-events-none" />
          </div>

          <button
            onClick={() => void handleSubmit()}
            disabled={!prompt.trim() || isGenerating}
            aria-label={parentReport ? 'Send follow-up' : 'Generate report'}
            className="px-5 min-h-[46px] bg-gradient-to-r from-hud-gold to-hud-teal text-hud-bg-deep rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-4">
        {parentReport && lastTurn?.status !== 'running'
          ? REFINEMENT_SUGGESTIONS.map((text) => (
              <SuggestionChip key={text} label={text} disabled={isGenerating} onClick={() => applySuggestion(text)} />
            ))
          : turns.length === 0 &&
            templates.map((t) => (
              <SuggestionChip key={t.id} label={t.label} disabled={isGenerating} onClick={() => applySuggestion(t.prompt)} />
            ))}
      </div>
      <p className="text-xs text-hud-cream-mute mt-3">
        Enter to send, Shift+Enter for a new line. Every answer is saved to your reports list.
      </p>
    </div>
  );
}

function SuggestionChip({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 bg-hud-bg-elev/60 text-hud-cream-soft text-sm rounded-full border border-hud-cream-mute/40 hover:bg-hud-bg-elev hover:text-white hover:border-hud-gold/40 transition-colors disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function ReportAnswer({
  turn,
  expanded,
  onToggleExpanded,
  onOpen,
}: {
  turn: ThreadTurn;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpen: (reportId: string) => void;
}) {
  if (turn.status === 'running') {
    return (
      <div className="max-w-[92%] bg-hud-bg-mid/60 border border-hud-gold/20 rounded-2xl rounded-bl-md p-4 flex items-center gap-3">
        <Loader2 className="w-5 h-5 text-hud-gold-soft animate-spin shrink-0" />
        <div>
          <p className="text-sm text-white font-medium">Building your report...</p>
          <p className="text-xs text-hud-cream-dim">Querying your data and writing it up. This can take a minute or two.</p>
        </div>
      </div>
    );
  }

  if (turn.status === 'failed' || !turn.report?.result_json) {
    return (
      <div className="max-w-[92%] bg-hud-plum/10 border border-hud-plum/20 rounded-2xl rounded-bl-md p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-hud-plum shrink-0 mt-0.5" />
        <p className="text-sm text-hud-cream-soft">{turn.error || 'Report generation failed'}</p>
      </div>
    );
  }

  const report = turn.report;
  const result = report.result_json!;
  const summary = result.executive_summary || '';
  const isLong = summary.length > SUMMARY_PREVIEW_CHARS;
  const shownSummary = expanded || !isLong ? summary : `${summary.slice(0, SUMMARY_PREVIEW_CHARS).trimEnd()}...`;
  const kpis = (result.kpis || []).slice(0, 4);
  const firstChart = result.charts?.find((c) => c.data && c.data.length > 0);

  return (
    <div className="max-w-[92%] bg-hud-bg-card border border-hud-bg-elev rounded-2xl rounded-bl-md p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="w-4 h-4 text-hud-gold-soft" />
        <span className="text-sm font-semibold text-white">{result.title || report.report_name}</span>
        <span className="text-xs text-hud-cream-dim">
          {getScopeLabel(report.scope)}
          {report.timeframe_start && report.timeframe_end
            ? ` · ${formatDateShort(report.timeframe_start)} - ${formatDateShort(report.timeframe_end)}`
            : ''}
        </span>
      </div>

      {kpis.length > 0 && <ReportKPIGrid kpis={kpis} />}

      {summary && (
        <div>
          <p className="text-sm text-hud-cream-soft leading-relaxed whitespace-pre-wrap">{shownSummary}</p>
          {isLong && (
            <button onClick={onToggleExpanded} className="mt-1 text-xs text-hud-gold-soft hover:underline">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {firstChart && <AIReportChart chart={firstChart} />}

      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-hud-bg-elev">
        <button
          onClick={() => onOpen(report.id)}
          className="flex items-center gap-2 px-3 py-1.5 bg-hud-gold/20 text-hud-gold-soft rounded-lg hover:bg-hud-gold/30 transition-colors text-sm"
        >
          <FileText className="w-4 h-4" />
          View full report
        </button>
        <span className="flex items-center gap-3 text-xs text-hud-cream-dim">
          <span className="flex items-center gap-1">
            <BarChart3 className="w-3.5 h-3.5" /> {result.charts?.length || 0} charts
          </span>
          <span className="flex items-center gap-1">
            <Table2 className="w-3.5 h-3.5" /> {result.tables?.length || 0} tables
          </span>
        </span>
      </div>
    </div>
  );
}
