const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const TOKENS_PATH = path.join(__dirname, '..', 'jobber-tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';

// ── Token management ──────────────────────────────────────────────────────────

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { return null; }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

async function getAccessToken(jobberConfig) {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Jobber not authorized — run: node jobber-setup.js');

  // Refresh if expired or expiring within 5 minutes
  if (Date.now() > tokens.expires_at - 300000) {
    log('[Jobber] Refreshing access token...');
    const body = new URLSearchParams({
      client_id: jobberConfig.client_id,
      client_secret: jobberConfig.client_secret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    const res = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    tokens = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (res.data.expires_in * 1000),
    };
    saveTokens(tokens);
  }

  return tokens.access_token;
}

// ── GraphQL client ─────────────────────────────────────────────────────────────

async function graphql(accessToken, query, variables = {}) {
  const res = await axios.post(
    GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-JOBBER-GRAPHQL-VERSION': '2026-05-12',
      },
      timeout: 15000,
    }
  );
  if (res.data.errors) {
    throw new Error('Jobber GraphQL error: ' + JSON.stringify(res.data.errors));
  }
  return res.data.data;
}

// ── Find active job for a client by name ──────────────────────────────────────

async function findActiveJobForClient(accessToken, clientName) {
  // Step 1: find the client (cheap query, no nested objects)
  const clientQuery = `
    query FindClient($term: String!) {
      clients(searchTerm: $term, first: 5) {
        nodes {
          id
          name
        }
      }
    }
  `;

  const clientData = await graphql(accessToken, clientQuery, { term: clientName });
  const clients = clientData?.clients?.nodes || [];
  if (clients.length === 0) return null;

  // Find closest name match
  const lower = clientName.toLowerCase();
  const match = clients.find(c =>
    c.name.toLowerCase().includes(lower) ||
    lower.includes(c.name.toLowerCase().split(' ')[0].toLowerCase())
  ) || clients[0];

  // Step 2: fetch active jobs for that specific client (cheap — single client)
  const jobsQuery = `
    query GetClientJobs($id: EncodedId!) {
      client(id: $id) {
        jobs(filter: { status: active }, first: 5) {
          nodes {
            id
            jobNumber
            title
          }
        }
      }
    }
  `;

  const jobsData = await graphql(accessToken, jobsQuery, { id: match.id });
  const jobs = jobsData?.client?.jobs?.nodes || [];
  if (jobs.length === 0) return null;

  return { clientId: match.id, clientName: match.name, job: jobs[0] };
}

// ── Add a note to a job ───────────────────────────────────────────────────────

async function addNoteToJob(accessToken, jobId, noteText) {
  const mutation = `
    mutation AddJobNote($jobId: EncodedId!, $message: String!) {
      jobCreateNote(jobId: $jobId, input: { message: $message }) {
        jobNote {
          id
        }
        userErrors {
          message
          path
        }
      }
    }
  `;

  const data = await graphql(accessToken, mutation, { jobId, message: noteText });
  const errors = data?.jobCreateNote?.userErrors;
  if (errors && errors.length > 0) {
    throw new Error('Jobber note error: ' + errors.map(e => e.message).join(', '));
  }
  return data?.jobCreateNote?.jobNote?.id;
}

// ── Format note text ──────────────────────────────────────────────────────────

function formatNote(analysis, recordingDate) {
  const { summary, commitments, open_questions, client_details } = analysis;
  const lines = [];

  lines.push(`📅 ${recordingDate} — Field Recording`);
  lines.push('');

  if (summary) {
    lines.push(summary);
    lines.push('');
  }

  if (Array.isArray(commitments) && commitments.length > 0) {
    lines.push('✅ COMMITMENTS');
    commitments.forEach(c => {
      const due = c.by_when ? ` by ${c.by_when}` : '';
      lines.push(`• ${c.who} → ${c.what}${due}`);
    });
    lines.push('');
  }

  if (Array.isArray(open_questions) && open_questions.length > 0) {
    lines.push('❓ OPEN QUESTIONS');
    open_questions.forEach(q => lines.push(`• ${q}`));
    lines.push('');
  }

  if (Array.isArray(client_details) && client_details.length > 0) {
    lines.push('📋 DETAILS DISCUSSED');
    client_details.forEach(d => lines.push(`• ${d}`));
  }

  return lines.join('\n').trim();
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function writeToJobber(jobberConfig, clientName, analysis, recordingDate) {
  if (!jobberConfig || !jobberConfig.client_id) return;
  if (!clientName || clientName === 'UNKNOWN') {
    log('[Jobber] Skipping — no confirmed client');
    return;
  }

  try {
    const accessToken = await getAccessToken(jobberConfig);
    const result = await findActiveJobForClient(accessToken, clientName);

    if (!result) {
      log(`[Jobber] No active job found for "${clientName}" — skipping note`);
      return;
    }

    const { job, clientName: matchedName } = result;
    const noteText = formatNote(analysis, recordingDate);
    await addNoteToJob(accessToken, job.id, noteText);
    log(`[Jobber] ✓ Note added to job #${job.jobNumber} (${matchedName})`);

  } catch (err) {
    log(`[Jobber] ERROR: ${err.message}`);
  }
}

// ── Fetch all clients from Jobber (paginated) ─────────────────────────────────

async function fetchAllClients(jobberConfig) {
  const accessToken = await getAccessToken(jobberConfig);
  const query = `
    query FetchClients($cursor: String) {
      clients(first: 50, after: $cursor) {
        nodes {
          id
          name
          billingAddress {
            street
            city
            province
            postalCode
          }
          phones { number }
          emails { address }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const clients = [];
  let cursor = null;
  do {
    const data = await graphql(accessToken, query, cursor ? { cursor } : {});
    const page = data?.clients;
    (page?.nodes || []).forEach(c => clients.push(c));
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return clients;
}

// ── Create a client in Jobber ─────────────────────────────────────────────────

async function createJobberClient(jobberConfig, { name, address, phone, email }) {
  const accessToken = await getAccessToken(jobberConfig);

  // Parse "FirstName LastName" — last word is last name
  const parts = (name || '').trim().split(/\s+/);
  const firstName = parts.slice(0, -1).join(' ') || parts[0];
  const lastName = parts.length > 1 ? parts[parts.length - 1] : '';

  // Parse "123 Street, City ST 12345"
  const addrMatch = (address || '').match(/^(.*?),\s*([^,]+?)\s+([A-Z]{2})?\s*(\d{5})?$/);
  const street1 = addrMatch?.[1]?.trim() || address || '';
  const city = addrMatch?.[2]?.trim() || '';
  const province = addrMatch?.[3]?.trim() || 'FL';
  const postalCode = addrMatch?.[4]?.trim() || '';

  const mutation = `
    mutation CreateClient($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { id name }
        userErrors { message path }
      }
    }
  `;

  const input = {
    firstName,
    lastName,
    ...(street1 && {
      billingAddress: { street1, city, province, postalCode, country: 'US' },
    }),
    ...(phone && { phones: [{ number: phone, primary: true }] }),
    ...(email && { emails: [{ address: email, primary: true }] }),
  };

  const data = await graphql(accessToken, mutation, { input });
  const errors = data?.clientCreate?.userErrors;
  if (errors?.length > 0) throw new Error('Jobber create error: ' + errors.map(e => e.message).join(', '));
  return data?.clientCreate?.client;
}

// ── Fetch all quotes (paginated) and build per-client scope summaries ──────────

async function fetchClientScopes(jobberConfig) {
  const accessToken = await getAccessToken(jobberConfig);

  // Fetch only line item names (not descriptions) to keep query cost low
  const query = `
    query FetchQuotes($cursor: String) {
      quotes(first: 20, after: $cursor) {
        nodes {
          title
          quoteStatus
          client { name }
          lineItems {
            nodes { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  // Statuses worth including — anything the client has seen or is active
  const ACTIVE_STATUSES = new Set(['approved', 'converted', 'changes_requested', 'awaiting_response']);

  const byClient = {}; // clientName → [{ quoteTitle, lineItems }]
  let cursor = null;

  do {
    const data = await graphql(accessToken, query, cursor ? { cursor } : {});
    const page = data?.quotes;
    for (const q of (page?.nodes || [])) {
      if (!ACTIVE_STATUSES.has(q.quoteStatus)) continue;
      const name = q.client?.name;
      if (!name) continue;
      if (!byClient[name]) byClient[name] = [];
      byClient[name].push({
        quoteTitle: q.title || '',
        lineItems: (q.lineItems?.nodes || []).map(li => ({
          name: li.name || '',
          desc: li.description || '',
        })),
      });
    }
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // Build compact scope text per client — line item names + first sentence of description
  const scopes = {};
  for (const [clientName, quotes] of Object.entries(byClient)) {
    const parts = [];
    for (const q of quotes) {
      const items = q.lineItems
        .filter(li => li.name && !li.name.toLowerCase().startsWith('scope note'))
        .map(li => li.name.trim());
      if (items.length > 0) {
        parts.push(q.quoteTitle ? `${q.quoteTitle}: ${items.join(', ')}` : items.join(', '));
      }
    }
    if (parts.length > 0) {
      // Cap at 600 chars to keep the Claude prompt manageable
      scopes[clientName] = parts.join(' | ').slice(0, 600);
    }
  }

  return scopes; // { "Deb Vivian": "Vivian Renovation: Guest Bath 1...", ... }
}

module.exports = { writeToJobber, fetchAllClients, createJobberClient, fetchClientScopes };
