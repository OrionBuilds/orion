# Teams transcripts for every company meeting

`teams-meeting-processor` (cron, every 5 min) files Teams meeting transcripts for CLARA: digest,
then tasks, FRIDAY handoffs, follow-up drafts and an owner SMS. It runs in one of two modes:

| Mode | When | Covers |
|---|---|---|
| **app** | `MS_TRANSCRIPTS_CLIENT_ID` + `MS_TRANSCRIPTS_CLIENT_SECRET` are set | Every meeting organized by an enabled member of the tenant |
| delegated (fallback) | app secrets unset | Only meetings each connected user organizes, found through the calendar mirror |

App mode needs the Microsoft 365 setup below. Until it's done the processor stays in delegated mode.

## 1. Entra app registration

Entra admin center → **App registrations → New registration**: "Orion – Meeting Transcripts",
single tenant, no redirect URI. Keep it separate from the sign-in app (`MS_OAUTH_*`): these
permissions are tenant-wide and should sit behind their own credential.

**API permissions → Microsoft Graph → Application permissions**, then **Grant admin consent**:

| Permission | Used for |
|---|---|
| `OnlineMeetingTranscript.Read.All` | `getAllTranscripts` delta + transcript content |
| `OnlineMeetings.Read.All` | Meeting subject, times, invitees |
| `User.Read.All` | Listing the organizers to check |
| `OnlineMeetingArtifact.Read.All` *(recommended)* | Attendance reports (who actually joined) for contact matching |

**Certificates & secrets → New client secret** (6-month expiry; set a reminder). Then:

```bash
supabase secrets set --project-ref <your-project-ref> MS_TRANSCRIPTS_CLIENT_ID=<app id> MS_TRANSCRIPTS_CLIENT_SECRET=<secret>
```

`MS_TRANSCRIPTS_TENANT_ID` is optional (defaults to `MS_OAUTH_TENANT_ID`). Meetings are filed under
the org of `OWNER_USER_ID` (override with `MS_TRANSCRIPTS_ORG_ID`).

## 2. Teams admin: transcript API access (off by default)

Teams admin center → **Meetings → Meeting settings → Transcript API access**: turn **Microsoft Graph
access** on, then **Configure → Include speaker attribution** on (without it transcripts have no
speaker names and CLARA can't tell who owns an action item). Or:

```powershell
Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true -Identity Global
```

This switch applies to every app in the tenant; review Entra → Enterprise apps for others holding
transcript permissions.

## 3. Application access policy

Teams PowerShell module, as a Teams admin (takes up to 30 min to apply):

```powershell
Connect-MicrosoftTeams
New-CsApplicationAccessPolicy -Identity "Orion-Transcripts" -AppIds "<app id>" -Description "Clara meeting transcripts"
Grant-CsApplicationAccessPolicy -PolicyName "Orion-Transcripts" -Global
```

Use `-Identity <user object id>` instead of `-Global` to limit it to specific organizers.

## 4. Transcription has to happen

Transcription must be allowed by the meeting policy and actually running in the meeting (started by
someone, or via the meeting option "Record and transcribe automatically" where licensing allows).
No transcript → nothing to file.

## Limits

- Channel meetings aren't returned by `getAllTranscripts`.
- Meetings organized outside the tenant aren't reachable.
- Ad hoc calls / "Meet now" use separate APIs (not covered).
- First sync per organizer looks back 48h; transcripts older than 7 days are ignored.

## When something is wrong

The processor pages the owner once a day per problem (`teams.transcripts` notification) and stops
early when Microsoft blocks the whole tenant:

| Kind | Fix |
|---|---|
| `transcripts_disabled` | Step 2 |
| `no_access_policy` | Step 3 (every organizer refused) |
| `forbidden` | Step 1: permissions, admin consent, or an expired secret |

Per-organizer state is in `teams_transcript_cursors` (`last_error`, `last_synced_at`); per-meeting
state is in `meeting_sessions` (`source = 'app'`, `status`, `processing_error`).
