import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search,
  Sparkles,
  Clock,
  FileText,
  TrendingUp,
  Loader2,
  MoreVertical,
  Eye,
  Copy,
  Trash2,
  Calendar as CalendarIcon,
  Filter,
  Download,
  X,
  BarChart3,
  MessageSquarePlus,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  getAIReports,
  getAIReportStats,
  deleteReport,
  duplicateReport,
  getReportCategoryLabel,
  getScopeLabel,
} from '../../services/aiReports';
import type {
  AIReport,
  AIReportFilters,
  AIReportStats,
  ReportScope,
  ReportCategory,
} from '../../types/aiReports';
import { PermissionGate } from '../../components/PermissionGate';
import { formatDateShort } from '../../utils/formatters';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';
import { ReportGenerator } from '../../components/reporting/ReportGenerator';

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  complete: { bg: 'bg-hud-emerald/10', text: 'text-hud-emerald', label: 'Complete' },
  running: { bg: 'bg-hud-gold/10', text: 'text-hud-gold-soft', label: 'Running' },
  failed: { bg: 'bg-hud-plum/10', text: 'text-hud-plum', label: 'Failed' },
};

const CATEGORY_FILTERS: { value: ReportCategory | ''; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'sales', label: 'Sales' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'ops', label: 'Operations' },
  { value: 'finance', label: 'Finance' },
  { value: 'projects', label: 'Projects' },
  { value: 'custom', label: 'Custom' },
];

export function Reporting() {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const { user, hasPermission } = useAuth();
  const { showToast } = useToast();

  const [reports, setReports] = useState<AIReport[]>([]);
  const [stats, setStats] = useState<AIReportStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<AIReportFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const loadData = useCallback(async (silent = false) => {
    if (!user?.organization_id) return;
    try {
      if (!silent) setIsLoading(true);
      const [reportsData, statsData] = await Promise.all([
        getAIReports(user.organization_id, { ...filters, search: searchQuery || undefined }),
        getAIReportStats(user.organization_id),
      ]);
      setReports(reportsData);
      setStats(statsData);
    } catch (err) {
      console.error('Failed to load reports:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user?.organization_id, filters, searchQuery]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // The generator reports new/finished reports; refresh list and stats without a spinner.
  const refreshQuietly = useCallback(() => {
    void loadData(true);
  }, [loadData]);

  /** Re-open a saved report as a thread in the generator so it can be refined. */
  const continueInGenerator = (report: AIReport) => {
    setOpenMenuId(null);
    setSearchParams({ thread: report.id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (report: AIReport) => {
    if (!confirm(`Delete "${report.report_name}"? This cannot be undone.`)) return;
    try {
      await deleteReport(report.id);
      setReports((prev) => prev.filter((r) => r.id !== report.id));
      setOpenMenuId(null);
      showToast('success', 'Report deleted');
    } catch {
      showToast('warning', 'Failed to delete report');
    }
  };

  const handleDuplicate = async (report: AIReport) => {
    if (!user) return;
    try {
      const dup = await duplicateReport(report.id, user.id);
      setReports((prev) => [dup, ...prev]);
      setOpenMenuId(null);
      showToast('success', 'Report duplicated');
    } catch {
      showToast('warning', 'Failed to duplicate report');
    }
  };

  const handleExportCSV = (report: AIReport) => {
    if (!report.csv_data) {
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
  };

  const handleExportPDF = (report: AIReport) => {
    if (!report.rendered_html) {
      showToast('info', 'No PDF data available for this report');
      return;
    }
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(report.rendered_html);
      printWindow.document.close();
      printWindow.onload = () => printWindow.print();
    }
  };

  return (
    <div className="min-h-dvh bg-hud-bg-mid">
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-white">Reporting</h1>
          <p className="text-hud-cream-dim mt-1">Analyze performance across your system</p>
        </div>

        <PermissionGate permission="reporting.ai.query">
          <ReportGenerator onReportsChanged={refreshQuietly} />
        </PermissionGate>

        {stats && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              icon={<FileText className="w-5 h-5 text-hud-gold-soft" />}
              iconBg="bg-hud-gold/20"
              label="Total Reports"
              value={stats.totalReports}
            />
            <StatCard
              icon={<Loader2 className="w-5 h-5 text-hud-rust" />}
              iconBg="bg-hud-rust/20"
              label="Running"
              value={stats.runningReports}
            />
            <StatCard
              icon={<Clock className="w-5 h-5 text-hud-teal" />}
              iconBg="bg-hud-teal/20"
              label="Scheduled"
              value={stats.scheduledReports}
            />
            <StatCard
              icon={<TrendingUp className="w-5 h-5 text-hud-emerald" />}
              iconBg="bg-hud-emerald/20"
              label="Last Generated"
              value={stats.lastGeneratedDate ? formatDateShort(stats.lastGeneratedDate) : '-'}
            />
          </div>
        )}

        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev">
          <div className="p-4 border-b border-hud-bg-elev">
            <div className="flex items-center gap-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-hud-cream-mute" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search reports..."
                  className="w-full pl-10 pr-4 py-2.5 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                />
              </div>

              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`flex items-center gap-2 px-4 py-2.5 border rounded-lg transition-colors ${
                  showFilters || Object.values(filters).some(Boolean)
                    ? 'border-hud-gold bg-hud-gold/10 text-hud-gold-soft'
                    : 'border-hud-cream-mute text-hud-cream-soft hover:bg-hud-bg-elev'
                }`}
              >
                <Filter className="w-4 h-4" />
                Filters
              </button>
            </div>

            {showFilters && (
              <div className="flex items-center gap-4 mt-4 pt-4 border-t border-hud-bg-elev">
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1.5">Category</label>
                  <select
                    value={filters.category || ''}
                    onChange={(e) =>
                      setFilters({ ...filters, category: (e.target.value as ReportCategory) || undefined })
                    }
                    className="text-sm [color-scheme:dark] bg-hud-bg-elev border border-hud-cream-mute rounded-lg px-3 py-2 text-white"
                  >
                    {CATEGORY_FILTERS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1.5">Scope</label>
                  <select
                    value={filters.scope || ''}
                    onChange={(e) =>
                      setFilters({ ...filters, scope: (e.target.value as ReportScope) || undefined })
                    }
                    className="text-sm [color-scheme:dark] bg-hud-bg-elev border border-hud-cream-mute rounded-lg px-3 py-2 text-white"
                  >
                    <option value="">All Scopes</option>
                    <option value="my">My Data</option>
                    <option value="team">Team</option>
                    <option value="org">Organization</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1.5">Status</label>
                  <select
                    value={filters.status || ''}
                    onChange={(e) =>
                      setFilters({ ...filters, status: (e.target.value as 'complete' | 'running' | 'failed') || undefined })
                    }
                    className="text-sm [color-scheme:dark] bg-hud-bg-elev border border-hud-cream-mute rounded-lg px-3 py-2 text-white"
                  >
                    <option value="">All Statuses</option>
                    <option value="complete">Complete</option>
                    <option value="running">Running</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>

                {Object.values(filters).some(Boolean) && (
                  <button
                    onClick={() => setFilters({})}
                    className="flex items-center gap-1 text-sm text-hud-gold-soft hover:text-hud-gold-soft mt-5"
                  >
                    <X className="w-3.5 h-3.5" />
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {isLoading ? (
            <div className="p-12 text-center">
              <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin mx-auto" />
            </div>
          ) : reports.length === 0 ? (
            <div className="p-12 text-center">
              <BarChart3 className="w-12 h-12 text-hud-cream-mute mx-auto mb-4" />
              <h3 className="text-lg font-medium text-white mb-2">No reports yet</h3>
              <p className="text-hud-cream-dim mb-4">Use the prompt above to generate your first AI report</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-hud-bg-mid/50 border-b border-hud-bg-elev">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Report</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Category</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Scope</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Timeframe</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-hud-cream-dim uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hud-bg-elev">
                {reports.map((report) => {
                  const statusStyle = STATUS_STYLES[report.status] || STATUS_STYLES.failed;
                  return (
                    <tr
                      key={report.id}
                      className="hover:bg-hud-bg-elev/50 cursor-pointer transition-colors"
                      onClick={() => navigate(`/reporting/${report.id}`)}
                    >
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-hud-gold/20 to-hud-teal/20 flex items-center justify-center text-hud-gold-soft">
                            <Sparkles className="w-4 h-4" />
                          </div>
                          <div>
                            <span className="font-medium text-white">{report.report_name}</span>
                            {report.created_by_user && (
                              <div className="text-xs text-hud-cream-mute mt-0.5">{report.created_by_user.name}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="px-2.5 py-1 bg-hud-bg-elev text-hud-cream-soft rounded-full text-xs font-medium">
                          {getReportCategoryLabel(report.report_category)}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-sm text-hud-cream-soft">{getScopeLabel(report.scope)}</td>
                      <td className="px-4 py-4 text-sm text-hud-cream-dim">
                        {report.timeframe_start && report.timeframe_end ? (
                          <span className="flex items-center gap-1.5">
                            <CalendarIcon className="w-3.5 h-3.5" />
                            {formatDateShort(report.timeframe_start)} - {formatDateShort(report.timeframe_end)}
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-4 text-sm text-hud-cream-dim">{formatDateShort(report.created_at)}</td>
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                          {report.status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
                          {statusStyle.label}
                        </span>
                      </td>
                      <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {report.status === 'complete' && report.csv_data && (
                            <button
                              onClick={() => handleExportCSV(report)}
                              className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg transition-colors"
                              title="Export CSV"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          )}
                          <div className="relative">
                            <button
                              onClick={() => setOpenMenuId(openMenuId === report.id ? null : report.id)}
                              className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded-lg"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                            {openMenuId === report.id && (
                              <>
                                <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} />
                                <AnchoredMenu className="w-48 bg-hud-bg-elev rounded-lg shadow-xl border border-hud-cream-mute py-1 z-20">
                                  <button onClick={() => navigate(`/reporting/${report.id}`)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-cream-mute">
                                    <Eye className="w-4 h-4" />View Report
                                  </button>
                                  {report.status === 'complete' && hasPermission('reporting.ai.query') && (
                                    <button onClick={() => continueInGenerator(report)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-cream-mute">
                                      <MessageSquarePlus className="w-4 h-4" />Continue in generator
                                    </button>
                                  )}
                                  <button onClick={() => handleDuplicate(report)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-cream-mute">
                                    <Copy className="w-4 h-4" />Duplicate
                                  </button>
                                  {report.status === 'complete' && report.rendered_html && (
                                    <button onClick={() => handleExportPDF(report)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-cream-mute">
                                      <Download className="w-4 h-4" />Export PDF
                                    </button>
                                  )}
                                  {report.created_by_user_id === user?.id && (
                                    <>
                                      <div className="border-t border-hud-cream-mute my-1" />
                                      <button onClick={() => handleDelete(report)} className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-plum/10">
                                        <Trash2 className="w-4 h-4" />Delete
                                      </button>
                                    </>
                                  )}
                                </AnchoredMenu>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, iconBg, label, value }: { icon: React.ReactNode; iconBg: string; label: string; value: number | string }) {
  return (
    <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-5">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg ${iconBg} flex items-center justify-center`}>{icon}</div>
        <div>
          <div className="text-sm text-hud-cream-dim">{label}</div>
          <div className="text-2xl font-bold text-white">{value}</div>
        </div>
      </div>
    </div>
  );
}
