import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  RefreshCw,
  Server,
  Shield,
  Users,
  BarChart3,
  Cog,
  AlertTriangle,
  Trash2,
  CheckCircle,
  Clock,
  Lock,
  Database,
  Zap,
  MessageSquare,
  Phone,
  Bot,
  Calendar,
  CreditCard,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSystemDashboardData } from '../hooks/useSystemDashboardData';
import {
  SystemStatCard,
  StatusBadge,
  ErrorStreamRow,
  MetricGrid,
  ConfirmDangerModal,
  ServiceHealthCard,
} from '../components/system-dashboard';

export function SystemDashboard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isSuperAdmin } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [clearCacheModal, setClearCacheModal] = useState(false);

  const {
    health,
    errors,
    tenants,
    usage,
    security,
    compliance,
    jobs,
    integrations,
    loading,
    isLoading,
    refetch,
    acknowledgeError,
  } = useSystemDashboardData();

  async function handleRefresh() {
    setRefreshing(true);
    await refetch();
    setTimeout(() => setRefreshing(false), 500);
  }

  function handleClearCache() {
    setClearCacheModal(false);
  }

  function switchToUserDashboard() {
    navigate('/', { replace: true });
  }

  const environment = 'Production';

  return (
    <div className="min-h-dvh bg-hud-bg-mid">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">System Dashboard</h1>
            <p className="text-hud-cream-dim mt-1">Platform health, security, and operations</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="px-3 py-1.5 bg-hud-emerald/10 text-hud-emerald text-xs font-medium rounded-full">
              {environment}
            </span>
            <div className="flex items-center bg-hud-bg-card border border-hud-bg-elev rounded-lg p-1">
              <button
                onClick={switchToUserDashboard}
                className="px-3 py-1.5 text-sm text-hud-cream-dim hover:text-white transition-colors rounded"
              >
                User Dashboard
              </button>
              <button className="px-3 py-1.5 text-sm text-white bg-hud-bg-elev rounded">
                System Dashboard
              </button>
            </div>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white hover:bg-hud-bg-elev transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <section>
          <h2 className="text-sm font-medium text-hud-cream-dim mb-4">Platform Health</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            <SystemStatCard
              title="API Uptime"
              value={`${health.overallUptime}%`}
              sublabel="last 24h"
              icon={Server}
              status="healthy"
              isLoading={loading.health}
            />
            <SystemStatCard
              title="Auth Service"
              value={health.services.find(s => s.name === 'Auth Service')?.status === 'healthy' ? 'Connected' : 'Issue'}
              sublabel={health.services.find(s => s.name === 'Auth Service')?.lastIncident ? 'Last incident today' : 'No incidents'}
              icon={Shield}
              status={health.services.find(s => s.name === 'Auth Service')?.status || 'healthy'}
              isLoading={loading.health}
            />
            <SystemStatCard
              title="Database"
              value={`${health.services.find(s => s.name === 'Database')?.latency || 0}ms`}
              sublabel="read/write latency"
              icon={Database}
              status={health.services.find(s => s.name === 'Database')?.status || 'healthy'}
              isLoading={loading.health}
            />
            <SystemStatCard
              title="Queue / Workers"
              value={jobs.jobsWaiting}
              sublabel={`${jobs.failedJobs24h} failed, ${jobs.stuckJobs} stuck`}
              icon={Cog}
              status={jobs.stuckJobs > 0 ? 'degraded' : 'healthy'}
              isLoading={loading.jobs}
            />
            <SystemStatCard
              title="Integrations"
              value={health.services.filter(s => s.status === 'healthy').length}
              sublabel={`${health.services.filter(s => s.status === 'degraded').length} degraded, ${health.services.filter(s => s.status === 'critical').length} down`}
              icon={Zap}
              status={health.services.find(s => s.name === 'Integrations')?.status || 'healthy'}
              onClick={() => navigate('/settings/integrations')}
              isLoading={loading.health}
            />
            <SystemStatCard
              title="Error Rate"
              value={`${health.errorRate}/min`}
              icon={AlertTriangle}
              status={health.errorRate > 1 ? 'degraded' : health.errorRate > 5 ? 'critical' : 'healthy'}
              trend={health.errorTrend}
              isLoading={loading.health}
            />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-hud-cream-dim mb-4">Service Connectivity</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <ServiceHealthCard
              title="Messaging"
              icon={MessageSquare}
              status={health.services.find(s => s.name === 'Integrations')?.status === 'healthy' ? 'connected' : 'degraded'}
              description="Email, SMS, and chat integrations"
              onClick={() => navigate('/settings/integrations')}
              isLoading={loading.health}
            />
            <ServiceHealthCard
              title="Calendar Sync"
              icon={Calendar}
              status="connected"
              description="Google Calendar and external sync"
              onClick={() => navigate('/settings/calendars')}
              isLoading={loading.health}
            />
            <ServiceHealthCard
              title="Payments"
              icon={CreditCard}
              status={errors.some(e => e.service === 'Payments' && !e.acknowledged) ? 'degraded' : 'connected'}
              description="QuickBooks Online"
              onClick={() => navigate('/settings/integrations')}
              isLoading={loading.health}
            />
            <ServiceHealthCard
              title="Integration Setup"
              icon={Zap}
              status={integrations.pending > 0 ? 'degraded' : 'connected'}
              description={`${integrations.configured}/${integrations.total} configured`}
              onClick={() => navigate('/settings/integrations?tab=all')}
              isLoading={loading.integrations}
            />
          </div>
        </section>

        {integrations.pending > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-hud-cream-dim">Integrations Requiring Configuration</h2>
              <span className="px-2 py-1 bg-hud-rust/10 text-hud-rust text-xs font-medium rounded-full">
                {integrations.pending} pending
              </span>
            </div>
            <div className="bg-hud-bg-card/50 rounded-xl border border-hud-rust/20 overflow-hidden">
              {loading.integrations ? (
                <div className="p-6">
                  <div className="animate-pulse space-y-3">
                    {[1, 2, 3].map(i => (
                      <div key={i} className="h-12 bg-hud-bg-elev/50 rounded" />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-hud-bg-elev/50">
                  {integrations.pendingList.slice(0, 8).map(integration => (
                    <div
                      key={integration.key}
                      onClick={() => navigate('/settings/integrations?tab=all')}
                      className="flex items-center justify-between p-4 hover:bg-hud-bg-card cursor-pointer transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-hud-bg-elev rounded-lg flex items-center justify-center">
                          <Zap className="h-4 w-4 text-hud-cream-dim" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-white">{integration.name}</p>
                          <p className="text-xs text-hud-cream-mute">{integration.category.replace('_', ' ')}</p>
                        </div>
                      </div>
                      <span className="px-2 py-1 bg-hud-rust/10 text-hud-rust text-xs font-medium rounded">
                        Needs API Key
                      </span>
                    </div>
                  ))}
                  {integrations.pendingList.length > 8 && (
                    <div
                      onClick={() => navigate('/settings/integrations?tab=all')}
                      className="p-4 text-center hover:bg-hud-bg-card cursor-pointer transition-colors"
                    >
                      <span className="text-sm text-hud-gold-soft">
                        +{integrations.pendingList.length - 8} more integrations
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-hud-cream-dim">Recent Errors</h2>
            <span className="text-xs text-hud-cream-mute">
              {errors.filter(e => !e.acknowledged).length} unacknowledged
            </span>
          </div>
          <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev overflow-hidden">
            {loading.errors ? (
              <div className="p-6">
                <div className="animate-pulse space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-16 bg-hud-bg-elev/50 rounded" />
                  ))}
                </div>
              </div>
            ) : errors.length === 0 ? (
              <div className="p-6 text-center">
                <CheckCircle className="h-8 w-8 text-hud-emerald mx-auto mb-2" />
                <p className="text-sm text-hud-cream-dim">No recent errors</p>
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto p-3 space-y-2">
                {errors.map(error => (
                  <ErrorStreamRow
                    key={error.id}
                    error={error}
                    onAcknowledge={acknowledgeError}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-hud-cream-dim mb-4">Tenant & Usage Metrics</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricGrid
              title="Organizations"
              metrics={[
                { label: 'Total orgs', value: tenants.orgStats.total, onClick: () => navigate('/reporting') },
                { label: 'Active today', value: tenants.orgStats.activeToday },
                { label: 'New this week', value: tenants.orgStats.newThisWeek },
                { label: 'Disabled orgs', value: tenants.orgStats.disabled },
              ]}
              isLoading={loading.tenants}
            />
            <MetricGrid
              title="Users"
              metrics={[
                { label: 'Total users', value: tenants.userStats.total, onClick: () => navigate('/users') },
                { label: 'Active (24h)', value: tenants.userStats.active24h },
                { label: 'Active (7d)', value: tenants.userStats.active7d },
                { label: 'Failed logins', value: tenants.userStats.failedLogins },
                { label: 'Locked accounts', value: tenants.userStats.lockedAccounts },
              ]}
              isLoading={loading.tenants}
            />
            <MetricGrid
              title="Usage Volume"
              metrics={[
                { label: 'Messages sent', value: usage.messagesSent.toLocaleString(), onClick: () => navigate('/reporting') },
                { label: 'Calls placed', value: usage.callsPlaced.toLocaleString() },
                { label: 'AI agent runs', value: usage.aiAgentRuns.toLocaleString() },
              ]}
              isLoading={loading.usage}
            />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-hud-cream-dim mb-4">Security & Compliance</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Security Metrics</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-hud-bg-mid/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Lock className="h-4 w-4 text-hud-plum" />
                    <span className="text-xs text-hud-cream-dim">Failed logins (24h)</span>
                  </div>
                  <span className="text-2xl font-semibold text-white">{security.failedLogins24h}</span>
                </div>
                <div className="bg-hud-bg-mid/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-4 w-4 text-hud-rust" />
                    <span className="text-xs text-hud-cream-dim">Suspicious IPs</span>
                  </div>
                  <span className="text-2xl font-semibold text-white">{security.suspiciousIps}</span>
                </div>
                <div className="bg-hud-bg-mid/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-4 w-4 text-hud-gold-soft" />
                    <span className="text-xs text-hud-cream-dim">Permission escalations</span>
                  </div>
                  <span className="text-2xl font-semibold text-white">{security.permissionEscalations}</span>
                </div>
                <div
                  onClick={() => navigate('/settings/secrets')}
                  className="bg-hud-bg-mid/50 rounded-lg p-4 cursor-pointer hover:bg-hud-bg-mid transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="h-4 w-4 text-hud-emerald" />
                    <span className="text-xs text-hud-cream-dim">Secrets rotated (30d)</span>
                  </div>
                  <span className="text-2xl font-semibold text-white">{security.secretsRotated30d}</span>
                </div>
              </div>
            </div>
            <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Compliance Status</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-hud-bg-mid/50 rounded-lg">
                  <span className="text-sm text-hud-cream-soft">SOC2</span>
                  <StatusBadge
                    status={compliance.soc2 === 'compliant' ? 'healthy' : 'degraded'}
                    label={compliance.soc2 === 'compliant' ? 'Compliant' : 'Non-compliant'}
                    size="md"
                  />
                </div>
                <div className="flex items-center justify-between p-3 bg-hud-bg-mid/50 rounded-lg">
                  <span className="text-sm text-hud-cream-soft">GDPR</span>
                  <StatusBadge
                    status={compliance.gdpr === 'enabled' ? 'healthy' : 'disconnected'}
                    label={compliance.gdpr === 'enabled' ? 'Enabled' : 'Disabled'}
                    size="md"
                  />
                </div>
                <div className="flex items-center justify-between p-3 bg-hud-bg-mid/50 rounded-lg">
                  <span className="text-sm text-hud-cream-soft">Audit Logging</span>
                  <StatusBadge
                    status={compliance.auditLogging === 'active' ? 'healthy' : 'critical'}
                    label={compliance.auditLogging === 'active' ? 'Active' : 'Inactive'}
                    size="md"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-hud-cream-dim mb-4">Background Jobs & Automations</h2>
          <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-5">
            {loading.jobs ? (
              <div className="animate-pulse grid grid-cols-4 gap-6">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="h-20 bg-hud-bg-elev rounded" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 bg-hud-emerald/10 rounded-xl mb-3">
                    <CheckCircle className="h-6 w-6 text-hud-emerald" />
                  </div>
                  <div className="text-2xl font-semibold text-white mb-1">{jobs.pendingApprovals}</div>
                  <div className="text-xs text-hud-cream-dim">Pending approvals</div>
                </div>
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 bg-hud-gold/10 rounded-xl mb-3">
                    <Clock className="h-6 w-6 text-hud-gold-soft" />
                  </div>
                  <div className="text-2xl font-semibold text-white mb-1">{jobs.jobsWaiting}</div>
                  <div className="text-xs text-hud-cream-dim">Jobs waiting</div>
                </div>
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 bg-hud-rust/10 rounded-xl mb-3">
                    <AlertTriangle className="h-6 w-6 text-hud-rust" />
                  </div>
                  <div className="text-2xl font-semibold text-white mb-1">{jobs.stuckJobs}</div>
                  <div className="text-xs text-hud-cream-dim">Stuck jobs</div>
                </div>
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-12 h-12 bg-hud-plum/10 rounded-xl mb-3">
                    <AlertTriangle className="h-6 w-6 text-hud-plum" />
                  </div>
                  <div className="text-2xl font-semibold text-white mb-1">{jobs.failedJobs24h}</div>
                  <div className="text-xs text-hud-cream-dim">Failed (24h)</div>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 mt-6 pt-4 border-t border-hud-bg-elev">
              <button className="px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute rounded-lg text-sm font-medium text-white transition-colors">
                Retry Failed Jobs
              </button>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-hud-cream-dim mb-4">System Actions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Quick Actions</h3>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => navigate('/settings/integrations?tab=logs')}
                  className="flex items-center gap-2 px-4 py-3 bg-hud-bg-elev hover:bg-hud-cream-mute rounded-lg text-sm font-medium text-white transition-colors"
                >
                  <Zap className="h-4 w-4 text-hud-cream-dim" />
                  Integration Logs
                </button>
                <button
                  className="flex items-center gap-2 px-4 py-3 bg-hud-bg-elev hover:bg-hud-cream-mute rounded-lg text-sm font-medium text-white transition-colors"
                >
                  <Cog className="h-4 w-4 text-hud-cream-dim" />
                  Feature Flags
                </button>
                <button
                  onClick={handleRefresh}
                  className="flex items-center gap-2 px-4 py-3 bg-hud-bg-elev hover:bg-hud-cream-mute rounded-lg text-sm font-medium text-white transition-colors"
                >
                  <Activity className="h-4 w-4 text-hud-cream-dim" />
                  Run Health Check
                </button>
              </div>
            </div>
            <div className="bg-hud-bg-card rounded-xl border border-hud-plum/20 p-5">
              <h3 className="text-sm font-semibold text-hud-plum mb-4">Danger Zone</h3>
              <div className="space-y-3">
                <button
                  onClick={() => setClearCacheModal(true)}
                  className="flex items-center gap-2 w-full px-4 py-3 bg-hud-plum/10 hover:bg-hud-plum/20 border border-hud-plum/30 rounded-lg text-sm font-medium text-hud-plum transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear System Cache
                </button>
                <p className="text-xs text-hud-cream-mute">
                  This will clear all cached data across the platform. Use with caution.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>

      <ConfirmDangerModal
        isOpen={clearCacheModal}
        onClose={() => setClearCacheModal(false)}
        onConfirm={handleClearCache}
        title="Clear System Cache"
        description="This action will clear all cached data across the platform. This may temporarily impact performance while caches are rebuilt. This action is logged."
        confirmText="CLEAR CACHE"
      />
    </div>
  );
}
