CREATE TABLE IF NOT EXISTS leaderboard_runs (
  id SERIAL PRIMARY KEY,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaderboard_agent_stats (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES leaderboard_runs(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  closed_conversations INTEGER NOT NULL DEFAULT 0,
  csat_requested INTEGER NOT NULL DEFAULT 0,
  csat_received INTEGER NOT NULL DEFAULT 0,
  avg_csat NUMERIC(4,2)
);
