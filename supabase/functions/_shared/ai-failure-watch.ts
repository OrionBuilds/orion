/** Message for the daily "AI sources failing" notification (pure; the function does the I/O). */
export interface FailingSource {
  source: string;
  agent: string | null;
  calls: number;
  errors: number;
  error_rate: number | string;
  last_error_at: string | null;
  last_error_message: string | null;
}

export function buildFailureDigest(rows: FailingSource[], now = new Date()): { title: string; body: string; dedupe: string } | null {
  if (rows.length === 0) return null;
  const lines = rows.slice(0, 8).map((r) => {
    const why = r.last_error_message ? ` — ${r.last_error_message.slice(0, 140)}` : " — reason not recorded yet";
    return `${r.source}${r.agent ? ` (${r.agent})` : ""}: ${r.errors} of ${r.calls} calls failed${why}`;
  });
  if (rows.length > 8) lines.push(`…and ${rows.length - 8} more`);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const key = rows.map((r) => r.source).sort().join(",");
  return {
    title: rows.length === 1 ? "An AI agent function is failing" : `${rows.length} AI agent functions are failing`,
    body: lines.join("\n"),
    dedupe: `ai-failing:${day}:${key}`,
  };
}
