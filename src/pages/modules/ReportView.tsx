import { useState, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  Calendar,
  Clock,
  Copy,
  Trash2,
  Download,
  Sparkles,
  FileText,
  Users,
  Building2,
  User as UserIcon,
  History,
  Send,
  ChevronDown,
  MoreHorizontal,
  Printer,
  CalendarClock,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  getAIReportById,
  getReportVersions,
  duplicateReport,
  deleteReport,
  generateReport,
  pollReportStatus,
  getReportCategoryLabel,
  getScopeLabel,
  TIMEFRAME_OPTIONS,
  getAvailableScopes,
} from '../../services/aiReports';
import {
  getSchedulesByReportId,
  createSchedule,
} from '../../services/aiReportSchedules';
import { ReportKPIGrid } from '../../components/reporting/ReportKPICard';
import { ReportNarrative } from '../../components/reporting/ReportNarrative';
import { AIReportChartGrid } from '../../components/reporting/AIReportChart';
import { AIReportTableList } from '../../components/reporting/AIReportTable';
import { ScheduleReportModal } from '../../components/reporting/ScheduleReportModal';
import type { AIReport, AIReportSchedule, ReportScope } from '../../types/aiReports';
import { formatDateTimeShort } from '../../utils/formatters';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';

const scopeIcons: Record<string, React.ReactNode> = {
  my: <UserIcon className="w-4 h-4" />,
  team: <Users className="w-4 h-4" />,
  org: <Building2 className="w-4 h-4" />,
};

export function ReportView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  // Opened from the generator's thread: going back resumes that conversation.
  const backTo = (location.state as { fromThread?: boolean } | null)?.fromThread && id
    ? `/reporting?thread=${id}`
    : '/reporting';
  const { user } = useAuth();
  const { showToast } = useToast();

  const [report, setReport] = useState<AIReport | null>(null);
  const [versions, setVersions] = useState<AIReport[]>([]);
  const [schedules, setSchedules] = useState<AIReportSchedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showActions, setShowActions] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  const [followUpPrompt, setFollowUpPrompt] = useState('');
  const [followUpScope, setFollowUpScope] = useState<ReportScope>('my');
  const [followUpTimeframe, setFollowUpTimeframe] = useState('last_30_days');
  const [isGeneratingFollowUp, setIsGeneratingFollowUp] = useState(false);

  const availableScopes = getAvailableScopes(user?.role?.name, user?.department_id);

  useEffect(() => {
    if (id && user?.organization_id) loadReport();
  }, [id, user?.organization_id]);

  const loadReport = async () => {
    try {
      setIsLoading(true);
      const [reportData, versionData, scheduleData] = await Promise.all([
        getAIReportById(id!),
        getReportVersions(id!),
        getSchedulesByReportId(id!),
      ]);
      setReport(reportData);
      setVersions(versionData);
      setSchedules(scheduleData);
      if (reportData) {
        setFollowUpScope(reportData.scope);
      }
    } catch {
      showToast('warning', 'Failed to load report');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDuplicate = async () => {
    if (!report || !user) return;
    try {
      const copy = await duplicateReport(report.id, user.id);
      showToast('success', 'Report duplicated');
      navigate(`/reporting/${copy.id}`);
    } catch {
      showToast('warning', 'Failed to duplicate report');
    }
    setShowActions(false);
  };

  const handleDelete = async () => {
    if (!report) return;
    try {
      await deleteReport(report.id);
      showToast('success', 'Report deleted');
      navigate('/reporting');
    } catch {
      showToast('warning', 'Failed to delete report');
    }
    setShowActions(false);
  };

  const handleExportCSV = () => {
    if (!report?.csv_data) {
      showToast('info', 'No CSV data available for this report');
      return;
    }
    const blob = new Blob([report.csv_data], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.report_name.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setShowActions(false);
  };

  const handleExportPDF = () => {
    if (!report?.rendered_html) {
      showToast('info', 'No rendered content available for PDF export');
      return;
    }
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(report.rendered_html);
      win.document.close();
      setTimeout(() => win.print(), 500);
    }
    setShowActions(false);
  };

  const handleScheduleSave = async (cadenceDays: number) => {
    if (!report || !user) return;
    try {
      await createSchedule(user.organization_id, user.id, {
        reportId: report.id,
        cadenceDays,
        reportNameTemplate: report.report_name,
        scope: report.scope,
        promptTemplate: report.prompt,
        planTemplate: report.plan_json ? (report.plan_json as unknown as Record<string, unknown>) : undefined,
      });
      showToast('success', 'Schedule created');
      const updated = await getSchedulesByReportId(report.id);
      setSchedules(updated);
    } catch {
      showToast('warning', 'Failed to create schedule');
    }
  };

  const handleFollowUp = async () => {
    if (!followUpPrompt.trim() || isGeneratingFollowUp || !user || !report) return;
    setIsGeneratingFollowUp(true);
    try {
      const result = await generateReport(user.organization_id, user.id, {
        prompt: followUpPrompt.trim(),
        scope: followUpScope,
        timeframe: { type: 'preset', preset: followUpTimeframe },
        parent_report_id: report.id,
      });
      if (!result.success) {
        showToast('warning', result.error || 'Follow-up generation failed');
        return;
      }
      const completed = await pollReportStatus(result.report_id);
      if (completed.status === 'complete') {
        showToast('success', 'Follow-up report generated');
        navigate(`/reporting/${completed.id}`, { state: location.state });
      } else {
        showToast('warning', completed.error_message || 'Report generation failed');
      }
    } catch (err) {
      showToast('warning', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsGeneratingFollowUp(false);
      setFollowUpPrompt('');
    }
  };

  const formatTimeframe = () => {
    if (!report) return '';
    if (report.timeframe_start && report.timeframe_end) {
      return `${new Date(report.timeframe_start).toLocaleDateString()} - ${new Date(report.timeframe_end).toLocaleDateString()}`;
    }
    return '';
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-hud-bg-mid">
        <Loader2 className="w-8 h-8 text-hud-gold animate-spin" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="h-full flex items-center justify-center bg-hud-bg-mid">
        <div className="text-center">
          <FileText className="w-12 h-12 text-hud-cream-mute mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">Report Not Found</h2>
          <p className="text-hud-cream-dim mb-6">This report may have been deleted or you don't have access.</p>
          <button
            onClick={() => navigate('/reporting')}
            className="px-5 py-2.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg transition-colors"
          >
            Back to Reports
          </button>
        </div>
      </div>
    );
  }

  const result = report.result_json;
  const isComplete = report.status === 'complete' && result;

  return (
    <div className="h-full flex flex-col bg-hud-bg-mid">
      <div className="px-6 py-4 border-b border-hud-bg-elev/60 bg-hud-bg-mid/95 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(backTo)}
              className="p-2 text-hud-cream-dim hover:text-white hover:bg-hud-bg-card rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-white">
                  {result?.title || report.report_name}
                </h1>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                  report.status === 'complete'
                    ? 'bg-hud-emerald/10 text-hud-emerald border border-hud-emerald/20'
                    : report.status === 'running'
                    ? 'bg-hud-rust/10 text-hud-rust border border-hud-rust/20'
                    : 'bg-hud-plum/10 text-hud-plum border border-hud-plum/20'
                }`}>
                  {report.status === 'complete' ? 'Complete' : report.status === 'running' ? 'Running' : 'Failed'}
                </span>
              </div>
              <div className="flex items-center gap-4 mt-1.5 text-sm text-hud-cream-dim">
                <span className="flex items-center gap-1.5">
                  {scopeIcons[report.scope]}
                  {getScopeLabel(report.scope)}
                </span>
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  {getReportCategoryLabel(report.report_category)}
                </span>
                {formatTimeframe() && (
                  <span className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatTimeframe()}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  {formatDateTimeShort(report.created_at, { hour: 'numeric' })}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {schedules.length > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft">
                <CalendarClock className="w-4 h-4 text-hud-gold-soft" />
                {schedules.filter(s => s.is_active).length} schedule{schedules.filter(s => s.is_active).length !== 1 ? 's' : ''}
              </div>
            )}

            <button
              onClick={() => setShowScheduleModal(true)}
              className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft hover:text-white hover:border-hud-cream-mute transition-colors text-sm"
            >
              <Clock className="w-4 h-4" />
              Schedule
            </button>

            {versions.length > 1 && (
              <button
                onClick={() => setShowVersions(!showVersions)}
                className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft hover:text-white hover:border-hud-cream-mute transition-colors text-sm"
              >
                <History className="w-4 h-4" />
                v{versions.findIndex(v => v.id === report.id) + 1} of {versions.length}
              </button>
            )}

            <div className="relative">
              <button
                onClick={() => setShowActions(!showActions)}
                className="p-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft hover:text-white hover:border-hud-cream-mute transition-colors"
              >
                <MoreHorizontal className="w-5 h-5" />
              </button>
              {showActions && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
                  <AnchoredMenu className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-xl shadow-xl z-20 py-1">
                    <button
                      onClick={handleExportCSV}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50 hover:text-white transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      Export CSV
                    </button>
                    <button
                      onClick={handleExportPDF}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50 hover:text-white transition-colors"
                    >
                      <Printer className="w-4 h-4" />
                      Export PDF
                    </button>
                    <button
                      onClick={handleDuplicate}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50 hover:text-white transition-colors"
                    >
                      <Copy className="w-4 h-4" />
                      Duplicate
                    </button>
                    <div className="border-t border-hud-bg-elev my-1" />
                    <button
                      onClick={handleDelete}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-hud-plum hover:bg-hud-plum/10 hover:text-hud-plum/40 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                  </AnchoredMenu>
                </>
              )}
            </div>
          </div>
        </div>

        {showVersions && versions.length > 1 && (
          <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1">
            {versions.map((v, idx) => (
              <button
                key={v.id}
                onClick={() => {
                  navigate(`/reporting/${v.id}`);
                  setShowVersions(false);
                }}
                className={`flex-shrink-0 px-3 py-2 rounded-lg text-sm transition-colors ${
                  v.id === report.id
                    ? 'bg-hud-gold/10 border border-hud-gold/30 text-hud-gold-soft'
                    : 'bg-hud-bg-card border border-hud-bg-elev text-hud-cream-dim hover:text-white hover:border-hud-cream-mute'
                }`}
              >
                <span className="font-medium">v{idx + 1}</span>
                <span className="ml-2 text-xs opacity-70">
                  {new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {report.status === 'running' ? (
          <div className="flex items-center justify-center h-96">
            <div className="text-center">
              <Loader2 className="w-10 h-10 text-hud-gold-soft animate-spin mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-white mb-1">Generating Report</h3>
              <p className="text-hud-cream-dim text-sm">AI is analyzing your data and building the report...</p>
            </div>
          </div>
        ) : report.status === 'failed' ? (
          <div className="flex items-center justify-center h-96">
            <div className="text-center max-w-md">
              <div className="w-14 h-14 rounded-2xl bg-hud-plum/10 border border-hud-plum/20 flex items-center justify-center mx-auto mb-4">
                <FileText className="w-7 h-7 text-hud-plum" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">Report Generation Failed</h3>
              <p className="text-hud-cream-dim text-sm mb-4">
                {report.error_message || 'An error occurred while generating this report.'}
              </p>
              <button
                onClick={() => navigate(backTo)}
                className="px-5 py-2.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : isComplete ? (
          <div className="max-w-6xl mx-auto p-6 space-y-8">
            {report.prompt && (
              <div className="bg-hud-bg-card/40 rounded-xl border border-hud-bg-elev/40 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles className="w-4 h-4 text-hud-gold-soft" />
                  <span className="text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Prompt</span>
                </div>
                <p className="text-sm text-hud-cream-soft">{report.prompt}</p>
              </div>
            )}

            <ReportKPIGrid kpis={result.kpis} />

            <ReportNarrative
              executiveSummary={result.executive_summary}
              insights={result.insights}
              recommendations={result.recommendations}
            />

            <AIReportChartGrid charts={result.charts} />

            <AIReportTableList tables={result.tables} />

            {report.data_sources_used && report.data_sources_used.length > 0 && (
              <div className="text-xs text-hud-cream-mute flex items-center gap-2 pt-4 border-t border-hud-bg-card">
                <span>Data sources:</span>
                {report.data_sources_used.map((src, i) => (
                  <span key={i} className="px-2 py-0.5 bg-hud-bg-card rounded text-hud-cream-dim">{src}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-96">
            <div className="text-center text-hud-cream-mute">No report data available</div>
          </div>
        )}

        {isComplete && (
          <div className="border-t border-hud-bg-elev/60 bg-hud-bg-card/30 p-4">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-hud-gold-soft" />
                <span className="text-sm font-medium text-hud-cream-soft">Ask a follow-up</span>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <textarea
                    value={followUpPrompt}
                    onChange={(e) => setFollowUpPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleFollowUp();
                      }
                    }}
                    placeholder="Drill deeper, change scope, or request changes to this report..."
                    rows={1}
                    className="w-full px-4 py-3 bg-hud-bg-elev/60 border border-hud-cream-mute/60 rounded-xl text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/50 focus:border-transparent resize-none text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <select
                      value={followUpScope}
                      onChange={(e) => setFollowUpScope(e.target.value as ReportScope)}
                      className="appearance-none [color-scheme:dark] h-full px-3 pr-8 bg-hud-bg-elev/60 border border-hud-cream-mute/60 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold/50 cursor-pointer"
                    >
                      {availableScopes.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim pointer-events-none" />
                  </div>
                  <div className="relative">
                    <select
                      value={followUpTimeframe}
                      onChange={(e) => setFollowUpTimeframe(e.target.value)}
                      className="appearance-none [color-scheme:dark] h-full px-3 pr-8 bg-hud-bg-elev/60 border border-hud-cream-mute/60 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold/50 cursor-pointer"
                    >
                      {TIMEFRAME_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim pointer-events-none" />
                  </div>
                  <button
                    onClick={handleFollowUp}
                    disabled={!followUpPrompt.trim() || isGeneratingFollowUp}
                    className="p-3 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-xl hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isGeneratingFollowUp ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Send className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <ScheduleReportModal
        isOpen={showScheduleModal}
        onClose={() => setShowScheduleModal(false)}
        onSave={handleScheduleSave}
        reportName={report.report_name}
      />
    </div>
  );
}
