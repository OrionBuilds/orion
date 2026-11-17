import type { DashboardAnalytics } from './userDashboardAnalytics';
import { formatDateLong, formatWholeCurrency } from '../utils/formatters';


interface PDFStyles {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  lineHeight: number;
  fontSize: {
    title: number;
    heading: number;
    subheading: number;
    body: number;
    small: number;
  };
  colors: {
    primary: string;
    secondary: string;
    text: string;
    muted: string;
    success: string;
    danger: string;
    border: string;
  };
}

const defaultStyles: PDFStyles = {
  pageWidth: 612,
  pageHeight: 792,
  margin: 50,
  lineHeight: 1.4,
  fontSize: {
    title: 24,
    heading: 16,
    subheading: 12,
    body: 10,
    small: 8,
  },
  colors: {
    primary: '#1e40af',
    secondary: '#3b82f6',
    text: '#1f2937',
    muted: '#6b7280',
    success: '#059669',
    danger: '#dc2626',
    border: '#e5e7eb',
  },
};

function formatDelta(value: number): string {
  if (value > 0) return `+${value}%`;
  if (value < 0) return `${value}%`;
  return '0%';
}

function getTrendSymbol(trend: 'up' | 'down' | 'stable'): string {
  switch (trend) {
    case 'up': return '(up)';
    case 'down': return '(down)';
    default: return '(-)';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateDashboardHTML(
  data: DashboardAnalytics,
  organizationName: string,
  timeRangeLabel: string
): string {
  const styles = defaultStyles;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Dashboard Analytics Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: ${styles.colors.text};
      line-height: ${styles.lineHeight};
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
    }
    .header {
      border-bottom: 2px solid ${styles.colors.primary};
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .header h1 {
      font-size: ${styles.fontSize.title}px;
      color: ${styles.colors.primary};
      margin-bottom: 8px;
    }
    .header .subtitle {
      color: ${styles.colors.muted};
      font-size: ${styles.fontSize.body}px;
    }
    .section {
      margin-bottom: 30px;
    }
    .section h2 {
      font-size: ${styles.fontSize.heading}px;
      color: ${styles.colors.primary};
      margin-bottom: 15px;
      padding-bottom: 8px;
      border-bottom: 1px solid ${styles.colors.border};
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
    }
    .metric-card {
      background: #f9fafb;
      border: 1px solid ${styles.colors.border};
      border-radius: 8px;
      padding: 15px;
    }
    .metric-card .label {
      font-size: ${styles.fontSize.small}px;
      color: ${styles.colors.muted};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .metric-card .value {
      font-size: ${styles.fontSize.heading}px;
      font-weight: 600;
      color: ${styles.colors.text};
    }
    .metric-card .delta {
      font-size: ${styles.fontSize.small}px;
      margin-top: 5px;
    }
    .delta.positive { color: ${styles.colors.success}; }
    .delta.negative { color: ${styles.colors.danger}; }
    .delta.neutral { color: ${styles.colors.muted}; }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    .summary-table th,
    .summary-table td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid ${styles.colors.border};
      font-size: ${styles.fontSize.body}px;
    }
    .summary-table th {
      background: #f3f4f6;
      font-weight: 600;
      color: ${styles.colors.text};
    }
    .summary-table td.number {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid ${styles.colors.border};
      font-size: ${styles.fontSize.small}px;
      color: ${styles.colors.muted};
      text-align: center;
    }
    @media print {
      body { padding: 20px; }
      .section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Dashboard Analytics Report</h1>
    <div class="subtitle">
      ${escapeHtml(organizationName)} | ${escapeHtml(timeRangeLabel)} | Generated ${formatDateLong(new Date())}
    </div>
  </div>

  <div class="section">
    <h2>Contacts</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Total Contacts</div>
        <div class="value">${data.contacts.total.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="label">New This Period</div>
        <div class="value">${data.contacts.newInPeriod.current.toLocaleString()}</div>
        <div class="delta ${data.contacts.newInPeriod.trend === 'up' ? 'positive' : data.contacts.newInPeriod.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.contacts.newInPeriod.deltaPercent)} ${getTrendSymbol(data.contacts.newInPeriod.trend)}
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Conversations</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Active Conversations</div>
        <div class="value">${data.conversations.active.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="label">Messages Sent</div>
        <div class="value">${data.conversations.messagesSent.current.toLocaleString()}</div>
        <div class="delta ${data.conversations.messagesSent.trend === 'up' ? 'positive' : data.conversations.messagesSent.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.conversations.messagesSent.deltaPercent)} ${getTrendSymbol(data.conversations.messagesSent.trend)}
        </div>
      </div>
      <div class="metric-card">
        <div class="label">Response Rate</div>
        <div class="value">${data.conversations.responseRate.current}%</div>
        <div class="delta ${data.conversations.responseRate.trend === 'up' ? 'positive' : data.conversations.responseRate.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.conversations.responseRate.deltaPercent)} ${getTrendSymbol(data.conversations.responseRate.trend)}
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Opportunities</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Open Opportunities</div>
        <div class="value">${data.opportunities.open.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="label">Pipeline Value</div>
        <div class="value">${formatWholeCurrency(data.opportunities.pipelineValue.current)}</div>
        <div class="delta ${data.opportunities.pipelineValue.trend === 'up' ? 'positive' : data.opportunities.pipelineValue.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.opportunities.pipelineValue.deltaPercent)} ${getTrendSymbol(data.opportunities.pipelineValue.trend)}
        </div>
      </div>
      <div class="metric-card">
        <div class="label">Win Rate</div>
        <div class="value">${data.opportunities.winRate.current}%</div>
        <div class="delta ${data.opportunities.winRate.trend === 'up' ? 'positive' : data.opportunities.winRate.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.opportunities.winRate.deltaPercent)} ${getTrendSymbol(data.opportunities.winRate.trend)}
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Appointments</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Upcoming</div>
        <div class="value">${data.appointments.upcoming.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="label">Completed This Period</div>
        <div class="value">${data.appointments.completedInPeriod.current.toLocaleString()}</div>
        <div class="delta ${data.appointments.completedInPeriod.trend === 'up' ? 'positive' : data.appointments.completedInPeriod.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.appointments.completedInPeriod.deltaPercent)} ${getTrendSymbol(data.appointments.completedInPeriod.trend)}
        </div>
      </div>
      <div class="metric-card">
        <div class="label">No-Show Rate</div>
        <div class="value">${data.appointments.noShowRate.current}%</div>
        <div class="delta ${data.appointments.noShowRate.trend === 'down' ? 'positive' : data.appointments.noShowRate.trend === 'up' ? 'negative' : 'neutral'}">
          ${formatDelta(data.appointments.noShowRate.deltaPercent)} ${getTrendSymbol(data.appointments.noShowRate.trend)}
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Revenue</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Invoiced This Period</div>
        <div class="value">${formatWholeCurrency(data.revenue.invoicedInPeriod.current)}</div>
        <div class="delta ${data.revenue.invoicedInPeriod.trend === 'up' ? 'positive' : data.revenue.invoicedInPeriod.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.revenue.invoicedInPeriod.deltaPercent)} ${getTrendSymbol(data.revenue.invoicedInPeriod.trend)}
        </div>
      </div>
      <div class="metric-card">
        <div class="label">Paid This Period</div>
        <div class="value">${formatWholeCurrency(data.revenue.paidInPeriod.current)}</div>
        <div class="delta ${data.revenue.paidInPeriod.trend === 'up' ? 'positive' : data.revenue.paidInPeriod.trend === 'down' ? 'negative' : 'neutral'}">
          ${formatDelta(data.revenue.paidInPeriod.deltaPercent)} ${getTrendSymbol(data.revenue.paidInPeriod.trend)}
        </div>
      </div>
      <div class="metric-card">
        <div class="label">Outstanding</div>
        <div class="value">${formatWholeCurrency(data.revenue.outstanding)}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    Report generated automatically. Data reflects the selected time period.
  </div>
</body>
</html>
  `.trim();
}

export async function exportDashboardToPDF(
  data: DashboardAnalytics,
  organizationName: string,
  timeRangeLabel: string
): Promise<void> {
  const html = generateDashboardHTML(data, organizationName, timeRangeLabel);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    throw new Error('Unable to open print window. Please allow popups for this site.');
  }

  printWindow.document.write(html);
  printWindow.document.close();

  printWindow.onload = () => {
    setTimeout(() => {
      printWindow.print();
    }, 250);
  };
}

export function downloadHTMLAsFile(
  html: string,
  filename: string
): void {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function generateDashboardReportHTML(
  data: DashboardAnalytics,
  organizationName: string,
  timeRangeLabel: string
): string {
  return generateDashboardHTML(data, organizationName, timeRangeLabel);
}
