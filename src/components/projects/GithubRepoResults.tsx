/**
 * Live results under the Connections card's "Add repo" box: repos the signed-in user's GitHub
 * account can reach (owned, invited, organization), filtered by what's typed. Typing a URL or
 * owner/repo and pressing Save still works without GitHub connected.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { getErrorMessage } from '../../lib/errors';
import { GithubNotConnectedError, getGithubStatus, searchGithubRepos, type GithubRepoChoice } from '../../services/githubRepos';

export function GithubRepoResults({
  query,
  exclude,
  onPick,
}: {
  query: string;
  exclude: string[];
  onPick: (url: string) => void;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [reauth, setReauth] = useState(false);
  const [repos, setRepos] = useState<GithubRepoChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getGithubStatus()
      .then((s) => setConnected(s.connected))
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchGithubRepos(query.trim())
        .then((r) => live && setRepos(r))
        .catch((e) => {
          if (!live) return;
          if (e instanceof GithubNotConnectedError) {
            setConnected(false);
            setReauth(e.reauth);
          } else setError(getErrorMessage(e));
        })
        .finally(() => live && setLoading(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [connected, query]);

  if (connected === null) return null;
  if (!connected) {
    return (
      <p className="text-[11px] text-hud-cream-mute">
        {reauth ? 'GitHub needs reconnecting. ' : ''}
        <Link to="/settings/integrations" className="text-hud-gold-soft hover:underline">
          {reauth ? 'Reconnect GitHub' : 'Connect GitHub'}
        </Link>{' '}
        in Integrations to search your repos.
      </p>
    );
  }

  const taken = new Set(exclude.map((u) => u.toLowerCase()));
  const shown = repos.filter((r) => !taken.has(r.url.toLowerCase()));
  return (
    <div className="max-h-56 overflow-y-auto rounded-md border border-hud-bg-elev bg-hud-bg-mid">
      {loading && shown.length === 0 ? (
        <div className="flex justify-center py-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-hud-cream-dim" />
        </div>
      ) : error ? (
        <p className="px-2 py-2 text-[11px] text-hud-plum">{error}</p>
      ) : shown.length === 0 ? (
        <p className="px-2 py-2 text-[11px] text-hud-cream-mute">No matching repos. Paste a link above to add it anyway.</p>
      ) : (
        shown.map((r) => (
          <button
            key={r.full_name}
            onClick={() => onPick(r.url)}
            title={r.description ?? r.full_name}
            className="w-full text-left px-2 py-1.5 hover:bg-hud-bg-elev flex items-center gap-1.5"
          >
            {r.private && <Lock className="w-3 h-3 text-hud-cream-mute flex-none" />}
            <span className="text-xs text-hud-cream-soft truncate">{r.full_name}</span>
            {r.role !== 'owner' && <span className="ml-auto text-[10px] text-hud-cream-mute flex-none">{r.role}</span>}
          </button>
        ))
      )}
    </div>
  );
}
