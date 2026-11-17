/** GitHub REST helpers shared by edge functions. Pure, so they're unit-testable. */

export interface GithubRepo {
  full_name: string;
  html_url: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  owner: { login: string };
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface RepoChoice {
  full_name: string;
  url: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  role: "owner" | "write" | "read";
}

/**
 * Matches every whitespace-separated term against owner/name and description (case-insensitive),
 * most recently pushed first, capped at `limit`. An empty query returns the most recent repos.
 */
export function filterRepos(repos: GithubRepo[], query: string, limit = 50): RepoChoice[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  return repos
    .filter((r) => {
      const key = r.full_name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      const hay = `${key} ${(r.description ?? "").toLowerCase()}`;
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""))
    .slice(0, limit)
    .map((r) => ({
      full_name: r.full_name,
      url: `https://github.com/${r.full_name}`,
      private: r.private,
      description: r.description,
      pushed_at: r.pushed_at,
      role: r.permissions?.admin ? "owner" : r.permissions?.push ? "write" : "read",
    }));
}
