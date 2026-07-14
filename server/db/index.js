const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

async function runMigrations() {
  if (!pool) return;
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

async function saveRun({ startDate, endDate, agents }) {
  if (!pool) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runResult = await client.query(
      "INSERT INTO leaderboard_runs (start_date, end_date) VALUES ($1, $2) RETURNING id",
      [startDate, endDate]
    );
    const runId = runResult.rows[0].id;

    for (const agent of agents) {
      await client.query(
        `INSERT INTO leaderboard_agent_stats
          (run_id, admin_id, name, closed_conversations, csat_requested, csat_received, avg_csat)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          runId,
          agent.adminId,
          agent.name,
          agent.closedConversations,
          agent.csatRequested,
          agent.csatReceived,
          agent.avgCsat,
        ]
      );
    }

    await client.query("COMMIT");
    return runId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations, saveRun };
