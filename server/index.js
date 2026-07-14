require("dotenv").config();
const path = require("path");
const express = require("express");
const { runMigrations } = require("./db");
const leaderboardRouter = require("./routes/leaderboard");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/api", leaderboardRouter);

runMigrations()
  .catch((err) => console.error("Migration failed:", err.message))
  .finally(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`cs-leaderboard listening on 0.0.0.0:${PORT}`));
  });
