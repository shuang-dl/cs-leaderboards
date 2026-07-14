# CS Leaderboard

A simple leaderboard for the Customer Support team, built from Intercom conversation data.

## Architecture

This is a zero-dependency Node app, matching the pattern used by every other working
Intercom-backed tool deployed on Deploybay in this account (e.g. `support-tickets`):

- `server.js` — plain Node `http`/`https`, no npm packages, no build step. Serves
  `index.html` and implements one route, `/proxy-standalone?url=<encoded Intercom URL>`,
  which injects the Intercom API key server-side and forwards only to
  `https://api.intercom.io`.
- `index.html` — the whole UI and all the logic (pagination, grouping by teammate,
  CSAT math) runs client-side in the browser. The server never sees or computes any
  of it — it's a dumb, safe proxy.

This intentionally does **not** use Express or Postgres. An earlier version of this
app did, and consistently hit `502` errors on Deploybay that turned out to trace back
to that mismatch with the platform's proven setup, not a bug in the business logic
itself.

## What it does

Pick a team (defaults to Customer Support), a start/end date, and click
**Generate Leaderboard**. For each teammate it shows:

- Closed conversations
- CSAT requested (a rating survey was sent)
- CSAT received (the customer responded)
- CSAT response rate
- Average CSAT score

## How stats are derived from Intercom

- **Closed conversations**: conversations with `state = closed` whose
  `statistics.last_close_at` falls in the selected range, attributed to
  `statistics.last_closed_by_id` (the admin who performed the close).
- **CSAT requested**: the conversation has a `conversation_rating` object (a survey
  was sent after close).
- **CSAT received**: that `conversation_rating.rating` is non-null (the customer
  actually rated it).
- **Team filter**: uses `team_assignee_id` on the conversation (who the conversation
  belongs to), not team membership of the admin who closed it.

## Running it locally

```bash
PORT=8099 INTERCOM_API_KEY=<your token> node server.js
```

Open http://localhost:8099.

## Environment variables

| Variable              | Required | Notes                                                        |
|------------------------|----------|----------------------------------------------------------------|
| `INTERCOM_API_KEY`     | yes      | Intercom API access token, injected server-side by the proxy   |
| `PORT`                 | no       | Defaults to 8080                                                |
| `BASIC_AUTH_PASSWORD`  | no       | If set, gates the whole site behind HTTP Basic Auth             |
| `BASIC_AUTH_USER`      | no       | Defaults to `admin`, only used if `BASIC_AUTH_PASSWORD` is set  |

## Deploying to Deploybay

1. Push this repo as-is (root has `Dockerfile`, `server.js`, `index.html` — no build step).
2. Set `INTERCOM_API_KEY` in the Deploybay service's environment variables.
3. Container listens on **8080**.
4. Redeploy/restart — env var changes don't hot-reload.

## Next iterations (not built yet)

- Persisted history across runs (currently every run is live/on-demand only, nothing
  is stored)
- Export to CSV
- Per-agent conversation drill-down
