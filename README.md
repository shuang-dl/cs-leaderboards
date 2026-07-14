# CS Leaderboard

A simple leaderboard for the Customer Support team, built from Intercom conversation data.

## What it does

A single page lets you pick a start/end date and click **Generate Leaderboard**. The
server calls the Intercom API for conversations closed in that window, groups them by
the teammate who closed them, and reports:

- Closed conversations
- CSAT requested (a rating survey was sent)
- CSAT received (the customer responded)
- CSAT response rate
- Average CSAT score

Each run is also persisted to Postgres (`leaderboard_runs` / `leaderboard_agent_stats`)
so history isn't lost, even though the UI only shows the latest query for now.

## How stats are derived from Intercom

- **Closed conversations**: conversations with `state = closed` whose
  `statistics.last_close_at` falls in the selected range, attributed to
  `statistics.last_closed_by_id` (the admin who performed the close).
- **CSAT requested**: the conversation has a `conversation_rating` object (a survey was
  sent after close).
- **CSAT received**: that `conversation_rating.rating` is non-null (the customer
  actually rated it).
- Optionally set `INTERCOM_TEAM_ID` to restrict the leaderboard to a specific team's
  admins (find the id via `GET /teams`). Without it, every admin who closed a
  conversation shows up.

## Setup

```bash
npm install
cp .env.example .env
# fill in INTERCOM_ACCESS_TOKEN, DATABASE_URL, optionally INTERCOM_TEAM_ID
npm start
```

Open http://localhost:3000.

## Environment variables

| Variable                | Required | Notes                                             |
|--------------------------|----------|----------------------------------------------------|
| `INTERCOM_ACCESS_TOKEN`  | yes      | Intercom API access token                          |
| `INTERCOM_TEAM_ID`       | no       | Restrict results to one team's admins              |
| `DATABASE_URL`           | no       | Postgres connection string (Deploybay-provisioned) |
| `PORT`                   | no       | Defaults to 3000                                   |

If `DATABASE_URL` is unset, the app still works — it just skips persistence.

## Deploying to Deploybay

The included `Dockerfile` builds and runs the app (`npm start`), reading all
configuration from environment variables. Set the same env vars above in Deploybay's
service configuration, and point `DATABASE_URL` at the provisioned Postgres instance.
Migrations (`server/db/schema.sql`) run automatically on boot.

## Next iterations (not built yet)

- Persisted history view (leaderboard over time, not just the latest query)
- Scheduled automatic pulls instead of manual button click
- Per-agent drill-down (individual conversation list)
