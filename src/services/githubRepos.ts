// The signed-in user's GitHub account (Settings → Integrations → GitHub), through `github-api`.
// The token never reaches the browser: the edge function decrypts it and calls GitHub.
import { fetchEdge } from '../lib/edgeFunction';

export interface GithubRepoChoice {
  full_name: string;
  url: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  role: 'owner' | 'write' | 'read';
}

export class GithubNotConnectedError extends Error {
  constructor(public reauth: boolean) {
    super(reauth ? 'GitHub needs to be reconnected' : 'GitHub is not connected');
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetchEdge('github-api', { body });
  const data = await r.json().catch(() => ({}));
  if (r.status === 409) throw new GithubNotConnectedError(data.code === 'reauth');
  if (!r.ok) throw new Error(data.error || 'GitHub request failed');
  return data as T;
}

export function getGithubStatus(): Promise<{ connected: boolean; login: string | null }> {
  return call({ action: 'status' });
}

/** Repos the account can reach (owned, invited, organization), filtered by `query`. */
export async function searchGithubRepos(query: string): Promise<GithubRepoChoice[]> {
  return (await call<{ repos: GithubRepoChoice[] }>({ action: 'search-repos', query })).repos;
}
