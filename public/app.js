const startInput = document.getElementById("start-date");
const endInput = document.getElementById("end-date");
const generateBtn = document.getElementById("generate-btn");
const statusEl = document.getElementById("status");
const table = document.getElementById("leaderboard-table");
const tbody = document.getElementById("leaderboard-body");

function formatPercent(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatAvg(value) {
  return value == null ? "—" : value.toFixed(2);
}

async function generateLeaderboard() {
  const start = startInput.value;
  const end = endInput.value;

  if (!start || !end) {
    statusEl.textContent = "Please choose both a start and end date.";
    return;
  }

  generateBtn.disabled = true;
  statusEl.textContent = "Fetching stats from Intercom…";
  table.hidden = true;

  try {
    const res = await fetch(`/api/leaderboard?start=${start}&end=${end}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Request failed");
    }

    tbody.innerHTML = "";
    for (const agent of data.agents) {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${agent.name}</td>
        <td>${agent.closedConversations}</td>
        <td>${agent.csatRequested}</td>
        <td>${agent.csatReceived}</td>
        <td>${formatPercent(agent.csatResponseRate)}</td>
        <td>${formatAvg(agent.avgCsat)}</td>
      `;
      tbody.appendChild(row);
    }

    table.hidden = false;
    statusEl.textContent = data.agents.length
      ? `Showing ${data.agents.length} agent(s) for ${start} to ${end}.`
      : "No closed conversations found for that range.";
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    generateBtn.disabled = false;
  }
}

generateBtn.addEventListener("click", generateLeaderboard);
