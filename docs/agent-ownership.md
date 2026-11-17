# Agent ownership map

Every OS module and every scheduled function belongs to exactly one agent. This is the
canonical map; it is enforced where enforcement is real — the per-agent tool allowlists in
`AGENTOS-CORE/src/osmcp/allowlists.ts` and the `agent_slug` column on every
`agent_task_schedules` row — and documented here so nobody has to reverse-engineer it from
grants.

Standing rule that overrides everything below: **only CLARA holds tools over the owner's email,
contacts, and calendar.** FRIDAY carries overlapping Google scopes for its own needs but must
never be granted tools for the owner's personal comms.

The company does engineering only. The former marketing agent was retired on 2026-10-09
(no paid ads or client marketing); its schedules are off and kept only as history.

## FRIDAY — engineering & delivery

| Surface | Function |
|---|---|
| Projects module | Project records, tasks, stages, progress write-back (`projects_*`, `project_tasks_*`, `project_agent_meta_*`) |
| Support tickets | Triage, internal notes, client replies (approval-gated), status flow, resolution (`project_support_tickets_*`, `project_ticket_comment_create`) — task `friday.project_ticket_triage` |
| Change requests | Review, impact vs `contract_scope_index`, client acks (approval-gated), approved-CR → tasks → code dispatch → completion (`project_change_requests_*`, `project_change_request_comments_*`) — task `friday.change_request_triage` |
| Client code delivery | Workspace clone → write run → branch/PR → QA → deliverable. Bypass (auto-merge/deploy) is per-client data (`bypassPolicy`), off by default; portal-originated work is never bypass-eligible |
| Websites | Uptime (`friday.website_system_monitoring`), security headers (`friday.site_security_sweep`) |
| DevOps | Dependency sweep (`friday.devops_housekeeping`) |
| OS data hygiene | Contact/integration defect scans, fixes via approval (`friday.os_data_hygiene`) |
| Cross-agent health | Run-ledger monitoring (`friday.cross_agent_orchestration`) |
| Client health | Weekly rollup (`friday.client_health_report`) |

## CLARA — owner communications

| Surface | Function |
|---|---|
| Inbox | Triage digest (`clara.inbox_triage_digest`), inbox-zero pass with `config.allowed_mutations` (`clara.inbox_zero`) |
| Calendar & meetings | Meeting prep (`clara.meeting_prep`), follow-ups (`clara.meeting_followups`) |
| Briefings | Daily owner briefing (`clara.daily_owner_briefing`), weekly planning (`clara.weekly_planning`) |
| Owner comms | Sole agent for the owner's email/contacts/calendar tools |

## Shared rails (no single owner; all agents)

`agent_whoami`, `agent_tasks_poll`, `agent_run_report`, `agent_run_deliver_confirm`,
`agent_run_extend_lease`, `agent_task_schedules_list`, `agent_task_runs_list`,
`team_message_send`, `team_channels_list`, `deliverable_publish`, the approvals mirror
(`agent_approval_*`), heartbeats, and the A3 inbox read.

## Change protocol

Adding a scheduled function = one catalog row (`agent_slug` names the owner) + one handler in
that agent's repo + the tool grants in that agent's allowlist + a row in the table above.
A task key must appear in exactly one agent's handler registry; the boot-time catalog log in
FRIDAY's `osTasks.ts` reports rows-without-handlers and handlers-without-rows.
