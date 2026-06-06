/**
 * dashboard-data.js
 *
 * Fetches all data for the CEO dashboard from Notion + Jobber.
 */

const axios = require('axios');
const { getAccessToken } = require('./jobber');

const NOTION_VERSION = '2022-06-28';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const JOBBER_API_VERSION = '2026-05-12';

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function getProp(page, key) {
  const p = page.properties[key];
  if (!p) return '';
  switch (p.type) {
    case 'title':       return p.title.map(t => t.plain_text).join('');
    case 'rich_text':   return p.rich_text.map(t => t.plain_text).join('');
    case 'select':      return p.select?.name || '';
    case 'status':      return p.status?.name || '';
    case 'date':        return p.date?.start || '';
    case 'relation':    return p.relation.map(r => r.id);
    default:            return '';
  }
}

// ── Notion queries ────────────────────────────────────────────────────────────

async function fetchAllClients(token, dbId) {
  const res = await axios.post(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      sorts: [{ property: 'Name', direction: 'ascending' }],
      page_size: 100,
    },
    { headers: notionHeaders(token) }
  );

  return res.data.results.map(p => ({
    id: p.id,
    name: getProp(p, 'Name'),
    status: getProp(p, 'Status'),
    address: getProp(p, 'Address'),
    startDate: getProp(p, 'Start Date'),
    targetCompletion: getProp(p, 'Target Completion'),
    primaryContact: getProp(p, 'Primary Contact'),
  })).filter(c => c.name && !c.name.startsWith('Jan (last'));
}

async function fetchCommitments(token, dbId) {
  const res = await axios.post(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      filter: {
        property: 'Status',
        select: { equals: 'OPEN' },
      },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      page_size: 50,
    },
    { headers: notionHeaders(token) }
  );

  return res.data.results.map(p => ({
    id: p.id,
    name: getProp(p, 'Name'),
    client: getProp(p, 'Promised To'),
    byWhen: getProp(p, 'By When'),
    whoPromised: getProp(p, 'Who Promised'),
    status: getProp(p, 'Status'),
    createdAt: p.created_time,
  })).filter(c => c.name);
}

async function fetchRecentActivity(token, dbId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await axios.post(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      filter: {
        property: 'Date',
        date: { on_or_after: sevenDaysAgo },
      },
      sorts: [{ property: 'Date', direction: 'descending' }],
      page_size: 15,
    },
    { headers: notionHeaders(token) }
  );

  return res.data.results.map(p => ({
    id: p.id,
    name: getProp(p, 'Name'),
    client: getProp(p, 'Client'),
    summary: getProp(p, 'Summary'),
    date: getProp(p, 'Date'),
    participants: getProp(p, 'Participants'),
    confidence: getProp(p, 'Confidence'),
  })).filter(a => a.client);
}

async function fetchOpenQuestions(token, dbId) {
  const res = await axios.post(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      filter: {
        property: 'Status',
        select: { equals: 'OPEN' },
      },
      page_size: 50,
    },
    { headers: notionHeaders(token) }
  );

  return res.data.results.map(p => ({
    id: p.id,
    name: getProp(p, 'Name'),
    status: getProp(p, 'Status'),
    createdAt: p.created_time,
  })).filter(q => q.name);
}

// ── Jobber queries ────────────────────────────────────────────────────────────

async function fetchJobberData(jobberConfig) {
  const accessToken = await getAccessToken(jobberConfig);

  const query = `
    query DashboardData {
      jobs(first: 50) {
        nodes {
          id
          jobNumber
          title
          jobStatus
          createdAt
          client { name }
        }
      }
      quotes(first: 50) {
        nodes {
          id
          title
          quoteStatus
          client { name }
          amounts { total }
        }
      }
    }
  `;

  const res = await axios.post(
    GRAPHQL_URL,
    { query },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
      },
      timeout: 15000,
    }
  );

  if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join(', '));

  const allJobs = (res.data.data.jobs?.nodes || []);
  const jobs = allJobs
    .filter(j => j.jobStatus !== 'archived')
    .map(j => ({
      id: j.id,
      jobNumber: j.jobNumber,
      title: j.title,
      status: j.jobStatus,
      client: j.client?.name || 'Unknown',
      createdAt: j.createdAt,
    }));

  const allQuotes = (res.data.data.quotes?.nodes || []);
  const quotes = allQuotes
    .filter(q => ['draft', 'awaiting_response', 'approved', 'changes_requested'].includes(q.quoteStatus))
    .map(q => ({
      id: q.id,
      title: q.title,
      status: q.quoteStatus,
      client: q.client?.name || 'Unknown',
      total: q.amounts?.total || 0,
    }));

  const pendingRevenue = quotes.reduce((sum, q) => sum + (q.total || 0), 0);

  return { jobs, quotes, pendingRevenue };
}

// ── Main export ───────────────────────────────────────────────────────────────

// Normalize client names for fuzzy matching
function normName(s) {
  if (Array.isArray(s)) return '';      // relation fields return ID arrays — skip
  return String(s || '').toLowerCase()
    .replace(/[&+]/g, 'and').replace(/mrs?\.\s*/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchDashboardData(config) {
  const business = config.businesses.find(b => b.jobber?.client_id) || config.businesses[0];
  const { notion_token, notion_databases, jobber } = business;

  const [notionClients, commitments, activity, openQuestions, jobberData] = await Promise.allSettled([
    fetchAllClients(notion_token, notion_databases.clients),
    fetchCommitments(notion_token, notion_databases.commitments),
    fetchRecentActivity(notion_token, notion_databases.conversation_log),
    fetchOpenQuestions(notion_token, notion_databases.open_questions),
    fetchJobberData(jobber),
  ]);

  const clients = notionClients.status === 'fulfilled' ? notionClients.value : [];
  const jobs    = jobberData.status    === 'fulfilled' ? jobberData.value.jobs : [];
  const quotes  = jobberData.status    === 'fulfilled' ? jobberData.value.quotes : [];
  const allCommitments = commitments.status === 'fulfilled' ? commitments.value : [];
  const allActivity    = activity.status    === 'fulfilled' ? activity.value : [];

  // Build per-client job list (fuzzy match by name)
  const jobsByClient = {};
  for (const j of jobs) {
    const key = normName(j.client);
    if (!jobsByClient[key]) jobsByClient[key] = [];
    jobsByClient[key].push(j);
  }

  // Build per-client commitment count
  const commitCountByClient = {};
  for (const c of allCommitments) {
    const key = normName(c.client);
    commitCountByClient[key] = (commitCountByClient[key] || 0) + 1;
  }

  // Build per-client last activity
  const lastActivityByClient = {};
  for (const a of allActivity) {
    const key = normName(a.client);
    if (!lastActivityByClient[key]) lastActivityByClient[key] = a;
  }

  // Enrich each Notion client with Jobber + activity data
  const enrichedClients = clients.map(c => {
    const key = normName(c.name);
    return {
      ...c,
      jobs: jobsByClient[key] || [],
      commitmentCount: commitCountByClient[key] || 0,
      lastActivity: lastActivityByClient[key] || null,
    };
  });

  return {
    clients:       enrichedClients,
    commitments:   allCommitments,
    activity:      allActivity,
    openQuestions: openQuestions.status === 'fulfilled' ? openQuestions.value : [],
    jobs,
    quotes,
    pendingRevenue: jobberData.status === 'fulfilled' ? jobberData.value.pendingRevenue : 0,
    fetchedAt:     new Date().toISOString(),
    errors: [notionClients, commitments, activity, openQuestions, jobberData]
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message),
  };
}

module.exports = { fetchDashboardData };
