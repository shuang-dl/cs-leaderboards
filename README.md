# CS Leaderboard

A simple leaderboard for the Customer Support team, built from Intercom conversation data.

## Architecture

This is a minimal-dependency Node app, matching the pattern used by every other working
Intercom-backed tool deployed on Deploybay in this account (e.g. `support-tickets`):
plain Node `http`/`https` (no Express), `node:20-slim`, listening on `0.0.0.0:8080`.
The only npm dependency is `pg`, for Postgres.

- `server.js` — serves `index.html` and implements three routes:
  - `GET /proxy-standalone?url=<encoded Intercom URL>` — generic proxy for the
    browser's own Intercom calls (loading admins/teams for the UI). Injects the API
    key server-side, forwards only to `https://api.intercom.io`.
  - `POST /sync-conversations?start=&end=` — server fetches closed conversations from
    Intercom for that date range and upserts them into Postgres.
  - `GET /leaderboard-data?start=&end=&team=` — reads the leaderboard straight out of
    Postgres (aggregated via SQL), no live Intercom call.
- `db.js` — schema setup, upsert, and the leaderboard aggregation query.
- `index.html` — UI. Loads admins/teams via the proxy for names and the team filter;
  **Sync from Intercom** and **Generate Leaderboard** are separate actions.

An earlier version of this app used Express + custom `/api/*` routes and consistently
hit `502`s on Deploybay that traced back to a mismatch with the platform's proven
setup, not a bug in the business logic. This rewrite matches that proven shape while
still storing data in Postgres.

## What it does

1. Pick a team filter — Customer Support, Inbound Calls Team, or Both (default) — and
   a date range (defaults to the last 90 days, or use the **Yesterday** / **Week to
   Date** / **Month to Date** quick-select buttons — week starts Monday). These are
   the only two teams the dropdown offers; team names are resolved to Intercom team
   ids at page load, so if either team is renamed in Intercom this needs updating
   (`ALLOWED_TEAM_NAMES` in `index.html`).
2. Click **Sync from Intercom** to pull closed conversations for that range into
   Postgres. Re-running it for an overlapping range just updates existing rows
   (upsert on conversation id), so it's safe to re-sync.
3. Click **Generate Leaderboard** to read the leaderboard for that range straight from
   Postgres — instant, no live Intercom call. If you pick a range that hasn't been
   synced yet, it'll just show no data; sync it first.

For each teammate: closed conversations, CSAT requested, CSAT received, CSAT response
rate, average CSAT score, average first response time (FRT), average time to close
(TTC). The summary cards show the same set aggregated across the whole team.

**Membership allowlist**: an agent only appears in the leaderboard if they're an
actual member of the selected team(s) (via `admin_ids` on Intercom's `/teams`
response), regardless of which team the conversation itself belonged to. This keeps
out anyone from another team (Onboarding, Risk, Merchant Processing, etc.) whose
close happened to get attributed to Customer Support or Inbound Calls Team. Runs
client-side, checked at page load.

**Clear Database**: wipes every row from `cs_leaderboard_conversations` (a
`TRUNCATE`, so it's instant, but irreversible). Requires confirming a browser dialog
first — "Are you sure you want to clear all the data in the database?"

## How stats are derived from Intercom

- **Closed conversations**: conversations with `state = closed` whose
  `statistics.last_close_at` falls in the selected range, attributed to
  `statistics.last_closed_by_id` (the admin who performed the close). Conversations
  with no closing admin (shouldn't normally happen) are skipped and counted as
  "skipped" in the sync result.
- **CSAT requested**: the conversation has a `conversation_rating` object (a survey
  was sent after close).
- **CSAT received**: that `conversation_rating.rating` is non-null (the customer
  actually rated it).
- **Team filter**: uses `team_assignee_id` on the conversation (who the conversation
  belongs to), stored per row so filtering by team at leaderboard time doesn't require
  re-syncing.
- **Avg FRT (first response time)**: `statistics.first_admin_reply_at` minus
  `statistics.first_assignment_at` — time from when a human/team was first assigned
  (i.e. once it leaves the bot inbox) to the first admin reply. Deliberately *not*
  `time_to_admin_reply`, which is measured from conversation start and would include
  bot/Fin triage time. Null (excluded from the average) if either timestamp is
  missing, or if the computed delta is negative.
- **Avg TTC (time to close)**: average of `statistics.time_to_last_close` (seconds to
  the same last-close event used for attribution above). This does **not** exclude
  snooze time — doing so would require fetching each conversation's full
  `conversation_parts` history individually (Intercom doesn't expose total-snoozed-time
  as a precomputed statistic), which would add one extra API call per conversation to
  every sync. Deferred for now; revisit if TTC accuracy becomes a priority worth that
  cost.

## Running it locally

Requires network access to your Postgres instance (e.g. via VPN if it's in a private
VPC — Deploybay's own Postgres instances typically aren't reachable from an arbitrary
laptop, only from within Deploybay's network).

```bash
PORT=8099 INTERCOM_API_KEY=<your token> DATABASE_URL=<your connection string> node server.js
```

Open http://localhost:8099.

## Environment variables

| Variable              | Required | Notes                                                                 |
|------------------------|----------|--------------------------------------------------------------------------|
| `INTERCOM_API_KEY`     | yes      | Intercom API access token                                               |
| `DATABASE_URL`         | yes      | Postgres connection string (Deploybay-provisioned)                     |
| `PORT`                 | no       | Defaults to 8080                                                        |
| `BASIC_AUTH_PASSWORD`  | no       | If set, gates the whole site behind HTTP Basic Auth                     |
| `BASIC_AUTH_USER`      | no       | Defaults to `admin`, only used if `BASIC_AUTH_PASSWORD` is set          |

Without `DATABASE_URL`, the page still loads and the proxy still works, but
**Sync from Intercom** and **Generate Leaderboard** will return an error.

## Deploying to Deploybay

1. Push this repo (root has `Dockerfile`, `package.json`, `server.js`, `db.js`,
   `index.html`).
2. Set `INTERCOM_API_KEY` and `DATABASE_URL` in the Deploybay service's environment
   variables.
3. Container listens on **8080**.
4. Redeploy/restart — env var changes don't hot-reload. Schema (the
   `cs_leaderboard_conversations` table) is created automatically on startup if it
   doesn't exist.

## Next iterations (not built yet)

- Export to CSV
- Per-agent conversation drill-down
- Auto-sync missing ranges instead of requiring a manual sync first
