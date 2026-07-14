const INTERCOM_API_BASE = "https://api.intercom.io";
const PAGE_SIZE = 150;

function authHeaders() {
  const token = process.env.INTERCOM_ACCESS_TOKEN;
  if (!token) {
    throw new Error("INTERCOM_ACCESS_TOKEN is not set");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Intercom-Version": "2.11",
  };
}

async function intercomRequest(path, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  let res;
  try {
    res = await fetch(`${INTERCOM_API_BASE}${path}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Intercom API ${path} unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Intercom API ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

async function fetchAdmins() {
  const data = await intercomRequest("/admins");
  return data.admins.map((a) => ({ id: String(a.id), name: a.name, email: a.email }));
}

async function fetchTeamAdminIds(teamId) {
  const data = await intercomRequest(`/teams/${teamId}`);
  return new Set((data.admin_ids || []).map(String));
}

async function searchClosedConversations(startTs, endTs) {
  const conversations = [];
  let pagination = null;

  do {
    const body = {
      query: {
        operator: "AND",
        value: [
          { field: "state", operator: "=", value: "closed" },
          { field: "statistics.last_close_at", operator: ">", value: startTs },
          { field: "statistics.last_close_at", operator: "<", value: endTs },
        ],
      },
      pagination: { per_page: PAGE_SIZE, ...(pagination ? { starting_after: pagination } : {}) },
    };

    const data = await intercomRequest("/conversations/search", {
      method: "POST",
      body: JSON.stringify(body),
    });

    conversations.push(...(data.conversations || []));
    pagination = data.pages && data.pages.next ? data.pages.next.starting_after : null;
  } while (pagination);

  return conversations;
}

/**
 * Builds one row per teammate: closed conversations, CSAT requested vs received, average CSAT.
 * "Closed by" is attributed via statistics.last_closed_by_id.
 * "CSAT requested" = conversation has a conversation_rating object (survey was sent).
 * "CSAT received" = that conversation_rating has a non-null rating (customer responded).
 */
function aggregateByAgent(conversations, adminsById) {
  const stats = new Map();

  const getRow = (adminId) => {
    if (!stats.has(adminId)) {
      stats.set(adminId, {
        adminId,
        name: adminsById.get(adminId)?.name || "Unknown",
        closedConversations: 0,
        csatRequested: 0,
        csatReceived: 0,
        csatRatingSum: 0,
      });
    }
    return stats.get(adminId);
  };

  for (const convo of conversations) {
    const closedById = convo.statistics && convo.statistics.last_closed_by_id;
    if (!closedById) continue;
    const adminId = String(closedById);
    const row = getRow(adminId);
    row.closedConversations += 1;

    const rating = convo.conversation_rating;
    if (rating) {
      row.csatRequested += 1;
      if (rating.rating != null) {
        row.csatReceived += 1;
        row.csatRatingSum += rating.rating;
      }
    }
  }

  return Array.from(stats.values()).map((row) => ({
    adminId: row.adminId,
    name: row.name,
    closedConversations: row.closedConversations,
    csatRequested: row.csatRequested,
    csatReceived: row.csatReceived,
    csatResponseRate: row.csatRequested > 0 ? row.csatReceived / row.csatRequested : null,
    avgCsat: row.csatReceived > 0 ? row.csatRatingSum / row.csatReceived : null,
  }));
}

async function getLeaderboard({ startTs, endTs }) {
  const [admins, conversations] = await Promise.all([
    fetchAdmins(),
    searchClosedConversations(startTs, endTs),
  ]);

  const adminsById = new Map(admins.map((a) => [a.id, a]));

  let allowedAdminIds = null;
  if (process.env.INTERCOM_TEAM_ID) {
    allowedAdminIds = await fetchTeamAdminIds(process.env.INTERCOM_TEAM_ID);
  }

  let agents = aggregateByAgent(conversations, adminsById);
  if (allowedAdminIds) {
    agents = agents.filter((a) => allowedAdminIds.has(a.adminId));
  }

  agents.sort((a, b) => b.closedConversations - a.closedConversations);
  return agents;
}

module.exports = { getLeaderboard };
