'use strict';

const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cs_leaderboard_conversations (
    conversation_id TEXT PRIMARY KEY,
    closed_by_admin_id TEXT NOT NULL,
    team_id TEXT,
    last_close_at TIMESTAMPTZ NOT NULL,
    csat_requested BOOLEAN NOT NULL DEFAULT false,
    csat_received BOOLEAN NOT NULL DEFAULT false,
    csat_rating SMALLINT,
    frt_seconds INTEGER,
    ttc_seconds INTEGER,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE cs_leaderboard_conversations ADD COLUMN IF NOT EXISTS frt_seconds INTEGER;
  ALTER TABLE cs_leaderboard_conversations ADD COLUMN IF NOT EXISTS ttc_seconds INTEGER;
  CREATE INDEX IF NOT EXISTS idx_cslb_last_close_at ON cs_leaderboard_conversations (last_close_at);
  CREATE INDEX IF NOT EXISTS idx_cslb_team_id ON cs_leaderboard_conversations (team_id);
`;

async function ensureSchema() {
  if (!pool) return;
  await pool.query(SCHEMA);
}

async function upsertConversations(rows) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  if (!rows.length) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO cs_leaderboard_conversations
           (conversation_id, closed_by_admin_id, team_id, last_close_at, csat_requested, csat_received, csat_rating, frt_seconds, ttc_seconds, synced_at)
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, now())
         ON CONFLICT (conversation_id) DO UPDATE SET
           closed_by_admin_id = EXCLUDED.closed_by_admin_id,
           team_id = EXCLUDED.team_id,
           last_close_at = EXCLUDED.last_close_at,
           csat_requested = EXCLUDED.csat_requested,
           csat_received = EXCLUDED.csat_received,
           csat_rating = EXCLUDED.csat_rating,
           frt_seconds = EXCLUDED.frt_seconds,
           ttc_seconds = EXCLUDED.ttc_seconds,
           synced_at = now()`,
        [
          row.conversationId,
          row.closedByAdminId,
          row.teamId,
          row.lastCloseAtUnix,
          row.csatRequested,
          row.csatReceived,
          row.csatRating,
          row.frtSeconds,
          row.ttcSeconds,
        ]
      );
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function queryLeaderboard({ startUnix, endUnix, teamIds }) {
  if (!pool) throw new Error('DATABASE_URL is not set');

  const result = await pool.query(
    `SELECT
       closed_by_admin_id AS admin_id,
       COUNT(*)::int AS closed_conversations,
       COUNT(*) FILTER (WHERE csat_requested)::int AS csat_requested,
       COUNT(*) FILTER (WHERE csat_received)::int AS csat_received,
       AVG(csat_rating) FILTER (WHERE csat_received) AS avg_csat,
       AVG(frt_seconds) AS avg_frt_seconds,
       COUNT(frt_seconds)::int AS frt_count,
       AVG(ttc_seconds) AS avg_ttc_seconds,
       COUNT(ttc_seconds)::int AS ttc_count
     FROM cs_leaderboard_conversations
     WHERE last_close_at >= to_timestamp($1)
       AND last_close_at <= to_timestamp($2)
       AND ($3::text[] IS NULL OR team_id = ANY($3::text[]))
     GROUP BY closed_by_admin_id
     ORDER BY closed_conversations DESC`,
    [startUnix, endUnix, teamIds && teamIds.length ? teamIds : null]
  );

  return result.rows.map((r) => ({
    adminId: r.admin_id,
    closedConversations: r.closed_conversations,
    csatRequested: r.csat_requested,
    csatReceived: r.csat_received,
    csatResponseRate: r.csat_requested > 0 ? r.csat_received / r.csat_requested : null,
    avgCsat: r.avg_csat != null ? Number(r.avg_csat) : null,
    avgFrtSeconds: r.avg_frt_seconds != null ? Number(r.avg_frt_seconds) : null,
    frtCount: r.frt_count,
    avgTtcSeconds: r.avg_ttc_seconds != null ? Number(r.avg_ttc_seconds) : null,
    ttcCount: r.ttc_count,
  }));
}

module.exports = { pool, ensureSchema, upsertConversations, queryLeaderboard };
