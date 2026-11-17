import { useState, useEffect } from 'react';
import {
  getPaymentAnalyticsSummary,
  getRevenueByPeriod,
  getOutstandingAging,
  getPaymentMethodBreakdown,
  getRecentPayments,
  getDebtorDays,
  getInvoiceExceptions,
  type DebtorDays,
  type InvoiceException,
  type PaymentAnalyticsSummary,
  type RevenueByPeriod,
  type OutstandingAging,
  type PaymentMethodBreakdown,
} from '../../services/paymentAnalytics';
import {
  DollarSign,
  TrendingUp,
  Clock,
  AlertTriangle,
  CreditCard,
  BarChart3,
  PieChart,
  Calendar,
  Loader2,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RechartsPie,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts';
import { formatDateNumeric, formatWholeCurrency } from '../../utils/formatters';
import { setInvoiceDispute } from '../../services/invoices';
import { useAuth } from '../../contexts/AuthContext';

/** Overdue longer than this many days lands in the Exceptions panel for a human. */
const EXCEPTION_OVERDUE_DAYS = 60;

const COLORS = ['#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export function PaymentReportsTab() {
  const { hasPermission } = useAuth();
  const canRelease = hasPermission('invoices.send');
  const [summary, setSummary] = useState<PaymentAnalyticsSummary | null>(null);
  const [revenueData, setRevenueData] = useState<RevenueByPeriod[]>([]);
  const [agingData, setAgingData] = useState<OutstandingAging[]>([]);
  const [methodData, setMethodData] = useState<PaymentMethodBreakdown[]>([]);
  const [recentPayments, setRecentPayments] = useState<{
    id: string;
    amount: number;
    payment_method: string;
    received_at: string;
    invoice?: { doc_number: string };
    contact?: { first_name: string; last_name: string; company?: string };
  }[]>([]);
  const [debtorDays, setDebtorDays] = useState<DebtorDays | null>(null);
  const [exceptions, setExceptions] = useState<InvoiceException[]>([]);
  const [exceptionsError, setExceptionsError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [periodType, setPeriodType] = useState<'daily' | 'weekly' | 'monthly'>('monthly');

  useEffect(() => {
    loadData();
  }, [periodType]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const [summaryData, revenue, aging, methods, payments] = await Promise.all([
        getPaymentAnalyticsSummary(),
        getRevenueByPeriod(periodType),
        getOutstandingAging(),
        getPaymentMethodBreakdown(),
        getRecentPayments(5),
      ]);
      setSummary(summaryData);
      setRevenueData(revenue);
      setAgingData(aging);
      setMethodData(methods);
      setRecentPayments(payments);
      // Best-effort: the report still renders if the debtor-days RPC is not deployed yet.
      const [dso, exc] = await Promise.all([
        getDebtorDays().catch(() => null),
        getInvoiceExceptions(EXCEPTION_OVERDUE_DAYS).then((rows) => ({ rows, error: null as string | null })).catch((e: Error) => ({ rows: [] as InvoiceException[], error: e.message })),
      ]);
      setDebtorDays(dso);
      setExceptions(exc.rows);
      setExceptionsError(exc.error);
    } catch (err) {
      console.error('Failed to load payment analytics:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const releaseHold = async (id: string) => {
    try {
      setReleaseError(null);
      await setInvoiceDispute(id, false);
      await loadData();
    } catch (err) {
      console.error('Failed to release dispute hold:', err);
      // A failed release must not hide the exception list: keep it visible so another hold can be released.
      setReleaseError(err instanceof Error ? err.message : 'Could not release the hold');
    }
  };

  const formatPeriod = (period: string) => {
    if (periodType === 'monthly') {
      const [year, month] = period.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }
    return new Date(period).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-white">Payment Analytics</h3>
        <button
          onClick={loadData}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-hud-bg-card text-hud-cream-soft hover:text-white hover:bg-hud-bg-elev transition-colors text-sm"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-emerald/10">
                <DollarSign className="w-5 h-5 text-hud-emerald" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{formatWholeCurrency(summary.totalRevenue)}</p>
                <p className="text-sm text-hud-cream-dim">Total Revenue</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-rust/10">
                <Clock className="w-5 h-5 text-hud-rust" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{formatWholeCurrency(summary.totalOutstanding)}</p>
                <p className="text-sm text-hud-cream-dim">Outstanding</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-plum/10">
                <AlertTriangle className="w-5 h-5 text-hud-plum" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{formatWholeCurrency(summary.totalOverdue)}</p>
                <p className="text-sm text-hud-cream-dim">Overdue</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev/50 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-gold/10">
                <TrendingUp className="w-5 h-5 text-hud-gold-soft" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-white">{summary.collectionRate}%</p>
                <p className="text-sm text-hud-cream-dim">Collection Rate</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-hud-bg-card/30 rounded-lg p-4">
            <p className="text-hud-cream-dim text-sm">Avg Invoice Value</p>
            <p className="text-xl font-semibold text-white mt-1">{formatWholeCurrency(summary.averageInvoiceValue)}</p>
          </div>
          <div className="bg-hud-bg-card/30 rounded-lg p-4">
            <p className="text-hud-cream-dim text-sm">Days Sales Outstanding</p>
            <p className="text-xl font-semibold text-white mt-1">{summary.daysOutstanding} days</p>
          </div>
          <div className="bg-hud-bg-card/30 rounded-lg p-4">
            <p className="text-hud-cream-dim text-sm">Monthly Recurring</p>
            <p className="text-xl font-semibold text-white mt-1">{formatWholeCurrency(summary.monthlyRecurringRevenue)}</p>
          </div>
          <div className="bg-hud-bg-card/30 rounded-lg p-4">
            <p className="text-hud-cream-dim text-sm">Annual Recurring</p>
            <p className="text-xl font-semibold text-white mt-1">{formatWholeCurrency(summary.annualRecurringRevenue)}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-hud-bg-card/30 rounded-xl border border-hud-bg-elev/50 p-6">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-white font-medium flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-hud-gold-soft" />
              Revenue Over Time
            </h4>
            <select
              value={periodType}
              onChange={(e) => setPeriodType(e.target.value as typeof periodType)}
              className="px-3 py-1 rounded bg-hud-bg-elev border border-hud-cream-mute text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          {revenueData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="period"
                  tickFormatter={formatPeriod}
                  stroke="#94a3b8"
                  tick={{ fill: '#94a3b8', fontSize: 12 }}
                />
                <YAxis
                  stroke="#94a3b8"
                  tick={{ fill: '#94a3b8', fontSize: 12 }}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                  }}
                  formatter={(value: number | undefined) => [formatWholeCurrency(value ?? 0), 'Revenue']}
                  labelFormatter={(label) => formatPeriod(String(label ?? ''))}
                />
                <Bar dataKey="revenue" fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-hud-cream-mute">
              No revenue data available
            </div>
          )}
        </div>

        <div className="bg-hud-bg-card/30 rounded-xl border border-hud-bg-elev/50 p-6">
          <h4 className="text-white font-medium flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-hud-rust" />
            Receivables Aging
          </h4>
          {agingData.some(d => d.amount > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={agingData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  type="number"
                  stroke="#94a3b8"
                  tick={{ fill: '#94a3b8', fontSize: 12 }}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                />
                <YAxis
                  type="category"
                  dataKey="bucket"
                  stroke="#94a3b8"
                  tick={{ fill: '#94a3b8', fontSize: 12 }}
                  width={80}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                  }}
                  formatter={(value: number | undefined) => [formatWholeCurrency(value ?? 0), 'Amount']}
                />
                <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
                  {agingData.map((_, index) => (
                    <Cell key={index} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-hud-cream-mute">
              No outstanding invoices
            </div>
          )}
        </div>

        <div className="bg-hud-bg-card/30 rounded-xl border border-hud-bg-elev/50 p-6">
          <h4 className="text-white font-medium flex items-center gap-2 mb-4">
            <AlertTriangle className="w-5 h-5 text-hud-rust" />
            Debtor Days &amp; Exceptions
          </h4>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-hud-cream-mute text-sm">Debtor days now</p>
              <p className="text-2xl text-white font-semibold">{debtorDays?.now.dso != null ? debtorDays.now.dso.toFixed(0) : '—'}</p>
            </div>
            <div>
              <p className="text-hud-cream-mute text-sm">A year ago</p>
              <p className="text-2xl text-white font-semibold">{debtorDays?.year_ago.dso != null ? debtorDays.year_ago.dso.toFixed(0) : '—'}</p>
            </div>
          </div>
          {releaseError && (
            <p className="text-hud-rust text-sm mb-2">Could not release the hold: {releaseError}</p>
          )}
          {exceptionsError ? (
            <p className="text-hud-rust text-sm">Could not load exceptions: {exceptionsError}</p>
          ) : exceptions.length > 0 ? (
            <ul className="divide-y divide-hud-bg-elev/50 max-h-[200px] overflow-y-auto">
              {exceptions.map((e) => (
                <li key={e.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white text-sm truncate">
                      {e.contactName} · {e.doc_number ?? 'Invoice'} · {formatWholeCurrency(e.total)}
                    </p>
                    <p className="text-hud-cream-mute text-xs truncate">
                      {e.disputed_at ? `On dispute hold${e.dispute_note ? `: ${e.dispute_note}` : ''}` : `${e.daysOverdue} days overdue`}
                    </p>
                  </div>
                  {e.disputed_at && canRelease && (
                    <button
                      onClick={() => releaseHold(e.id)}
                      className="text-xs px-2 py-1 rounded-lg bg-hud-bg-elev/50 text-hud-cream hover:bg-hud-bg-elev"
                    >
                      Release hold
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-hud-cream-mute text-sm">No disputed invoices and nothing overdue more than {EXCEPTION_OVERDUE_DAYS} days.</p>
          )}
        </div>

        <div className="bg-hud-bg-card/30 rounded-xl border border-hud-bg-elev/50 p-6">
          <h4 className="text-white font-medium flex items-center gap-2 mb-4">
            <PieChart className="w-5 h-5 text-hud-emerald" />
            Payment Methods
          </h4>
          {methodData.length > 0 ? (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="50%" height={200}>
                <RechartsPie>
                  <Pie
                    data={methodData}
                    dataKey="amount"
                    nameKey="method"
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {methodData.map((_, index) => (
                      <Cell key={index} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: '8px',
                    }}
                    formatter={(value: number | undefined) => formatWholeCurrency(value ?? 0)}
                  />
                </RechartsPie>
              </ResponsiveContainer>
              <div className="flex-1 space-y-2">
                {methodData.map((method, index) => (
                  <div key={method.method} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: COLORS[index % COLORS.length] }}
                      />
                      <span className="text-hud-cream-soft text-sm">{method.method}</span>
                    </div>
                    <span className="text-white text-sm font-medium">{method.percentage}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-hud-cream-mute">
              No payment data available
            </div>
          )}
        </div>

        <div className="bg-hud-bg-card/30 rounded-xl border border-hud-bg-elev/50 p-6">
          <h4 className="text-white font-medium flex items-center gap-2 mb-4">
            <CreditCard className="w-5 h-5 text-hud-teal" />
            Recent Payments
          </h4>
          {recentPayments.length > 0 ? (
            <div className="space-y-3">
              {recentPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-hud-bg-card/50"
                >
                  <div>
                    <p className="text-white font-medium">
                      {payment.contact?.company ||
                        `${payment.contact?.first_name || ''} ${payment.contact?.last_name || ''}`.trim() ||
                        'Unknown'}
                    </p>
                    <p className="text-hud-cream-dim text-xs">
                      {payment.invoice?.doc_number || 'No invoice'} - {formatDateNumeric(payment.received_at)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-hud-emerald font-medium">{formatWholeCurrency(payment.amount)}</p>
                    <p className="text-hud-cream-mute text-xs capitalize">{payment.payment_method.replace('_', ' ')}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-hud-cream-mute">
              No recent payments
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
