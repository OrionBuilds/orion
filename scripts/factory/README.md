# Factory role library

Roles are reviewed expert personas (Deal Strategist, SEO Specialist, Chief of Staff...) that the named
agents (Clara, FRIDAY, Harvey, Jason) load per task. They live in `agent_roles`
(migration `20261104100000_factory_roles.sql`); agents read them with the MCP tools `role_list` /
`role_get` and Clara with `use_role`.

Source: a pinned, reviewed clone of [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
(MIT). Nothing from it is executed. `build_roles.py` drops "act without asking" and package-runner lines,
prepends the factory operating rules, and writes `roles.json` + `seed.sql`:

    git clone --filter=blob:none https://github.com/msitarzewski/agency-agents.git /tmp/aa && git -C /tmp/aa checkout <sha>
    python3 -I scripts/factory/build_roles.py /tmp/aa scripts/factory/roles.tsv /tmp/factory-out
    # review /tmp/factory-out/report.txt, then apply /tmp/factory-out/seed.sql

`roles.tsv` is the allowlist: `<agent>\t<path in the repo>`. Re-seeding only rewrites a role whose upstream
file changed, so edits made to a role in the OS survive.
