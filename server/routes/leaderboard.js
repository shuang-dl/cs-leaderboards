const express = require("express");
const { getLeaderboard } = require("../services/intercom");
const { saveRun } = require("../db");

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/leaderboard", async (req, res) => {
  const { start, end } = req.query;

  if (!DATE_RE.test(start || "") || !DATE_RE.test(end || "")) {
    return res.status(400).json({ error: "start and end are required as YYYY-MM-DD" });
  }

  const startTs = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
  const endTs = Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000);

  if (Number.isNaN(startTs) || Number.isNaN(endTs) || startTs >= endTs) {
    return res.status(400).json({ error: "Invalid date range" });
  }

  try {
    const agents = await getLeaderboard({ startTs, endTs });

    saveRun({ startDate: start, endDate: end, agents }).catch((err) => {
      console.error("Failed to persist leaderboard run:", err.message);
    });

    res.json({ start, end, agents });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to fetch leaderboard from Intercom", detail: err.message });
  }
});

module.exports = router;
