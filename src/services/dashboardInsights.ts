import { callEdgeFunction } from '../lib/edgeFunction';
import type { DashboardInsightResponse } from '../types/aiReports';

/**
 * Fetch the Dashboard AI Insights widget data.
 *
 * The 6 finance/sales KPI numbers are recomputed live from the DB on every call;
 * the Claude-generated narrative + per-card insight text is cached per org and
 * refreshed at most once per 24h. Pass `force` to regenerate the insight text now.
 */
export async function getDashboardInsights(force = false): Promise<DashboardInsightResponse> {
  const res = await callEdgeFunction('dashboard-insights', force ? { force: true } : {});
  const json = await res.json();

  if (!res.ok || !json?.success) {
    const message = json?.error?.message || `Failed to load dashboard insights (${res.status})`;
    throw new Error(message);
  }

  return json as DashboardInsightResponse;
}
