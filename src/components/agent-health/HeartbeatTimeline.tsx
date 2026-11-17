import type { AgentDetail } from '../../services/agentOps';
import { fmtDateTime, HUD } from './format';

const BUCKET_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 144 ten-minute cells for the last 24h: filled = the agent polled in that window. */
export function HeartbeatStrip({ detail, now }: { detail: AgentDetail; now: number }) {
  const polled = new Map(detail.timeline_24h.map((b) => [Math.floor(Date.parse(b.t) / BUCKET_MS), b.polls]));
  const since = detail.history_since ? Date.parse(detail.history_since) : null;
  const end = Math.floor(now / BUCKET_MS);
  const cells = Array.from({ length: 144 }, (_, i) => end - 143 + i);
  const up = cells.filter((c) => (polled.get(c) ?? 0) > 0).length;
  return (
    <div>
      <div className="flex h-8 items-stretch gap-px" role="img" aria-label={`Polled in ${up} of the last 144 ten-minute windows`}>
        {cells.map((c) => {
          const polls = polled.get(c) ?? 0;
          const before = since === null || c * BUCKET_MS + BUCKET_MS <= since;
          const color = polls > 0 ? HUD.emerald : before ? 'rgba(160, 210, 245, 0.06)' : HUD.plum;
          return (
            <div
              key={c}
              className="flex-1 rounded-[1px]"
              style={{ backgroundColor: color, opacity: polls > 0 ? Math.min(1, 0.45 + polls / 10) : 1 }}
              title={`${fmtDateTime(new Date(c * BUCKET_MS).toISOString())}: ${polls ? `${polls} poll${polls === 1 ? '' : 's'}` : before ? 'no history yet' : 'no poll'}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-hud-cream-mute">
        <span>24h ago</span>
        <span>
          <span className="mr-2"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: HUD.emerald }} />polled</span>
          <span className="mr-2"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: HUD.plum }} />silent</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-hud-bg-elev" />before history</span>
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

/** One bar per hour over the selected window: height = share of the hour's six windows with a poll. */
export function HourlyUptime({ detail, now }: { detail: AgentDetail; now: number }) {
  const byHour = new Map(detail.timeline.map((h) => [Math.floor(Date.parse(h.t) / HOUR_MS), h.up_buckets]));
  const since = detail.history_since ? Date.parse(detail.history_since) : null;
  const hours = Math.min(detail.days * 24, 24 * 90);
  const end = Math.floor(now / HOUR_MS);
  const cols = Array.from({ length: hours }, (_, i) => end - hours + 1 + i);
  return (
    <div>
      <div className={`flex h-16 items-end overflow-hidden ${hours > 200 ? '' : 'gap-px'}`} role="img" aria-label="Hourly heartbeat coverage">
        {cols.map((h) => {
          const up = byHour.get(h) ?? 0;
          const before = since === null || (h + 1) * HOUR_MS <= since;
          const share = Math.min(1, up / 6);
          return (
            <div
              key={h}
              className="flex-1"
              style={{
                height: before ? '100%' : `${Math.max(8, share * 100)}%`,
                backgroundColor: before ? 'rgba(160, 210, 245, 0.05)' : share >= 0.99 ? HUD.emerald : share > 0 ? HUD.rust : HUD.plum,
              }}
              title={`${fmtDateTime(new Date(h * HOUR_MS).toISOString())}: ${before ? 'no history yet' : `${up}/6 windows polled`}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-hud-cream-mute">
        <span>{detail.days}d ago</span>
        <span>{detail.history_since ? `history since ${fmtDateTime(detail.history_since)}` : 'heartbeat history starts when the dashboard migration is applied'}</span>
        <span>now</span>
      </div>
    </div>
  );
}
