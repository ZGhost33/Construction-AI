#!/usr/bin/env node
/**
 * Jobber CLI — used by Hermes Agent to interact with Jobber from Telegram.
 *
 * Usage:
 *   node jobber-cli.js note "Brian Harris" "Tile delivery confirmed for Friday"
 *   node jobber-cli.js jobs "Brian Harris"
 *   node jobber-cli.js clients
 *   node jobber-cli.js run
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKENS_PATH = path.join(__dirname, 'jobber-tokens.json');
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const API_VERSION = '2026-05-12';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
const jobberConfig = config.businesses[0].jobber;

// ── Token management ──────────────────────────────────────────────────────────

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { return null; }
}

function saveTokens(t) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(t, null, 2));
}

async function getToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Not authorized — run: node jobber-setup.js');
  if (Date.now() > tokens.expires_at - 300000) {
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

async function gql(token, query, variables = {}) {
  const res = await axios.post(GRAPHQL_URL, { query, variables }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': API_VERSION,
    },
    timeout: 15000,
  });
  if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join(', '));
  return res.data.data;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdNote(clientName, noteText) {
  if (!clientName || !noteText) {
    console.error('Usage: node jobber-cli.js note "Client Name" "Note text"');
    process.exit(1);
  }

  const token = await getToken();

  // Find client
  const clientData = await gql(token, `
    query($term: String!) { clients(searchTerm: $term, first: 5) { nodes { id name } } }
  `, { term: clientName });

  const clients = clientData?.clients?.nodes || [];
  if (clients.length === 0) {
    console.error(`✗ No client found matching "${clientName}"`);
    process.exit(1);
  }

  const lower = clientName.toLowerCase();
  const match = clients.find(c =>
    c.name.toLowerCase().includes(lower) ||
    lower.includes(c.name.toLowerCase().split(' ')[0].toLowerCase())
  ) || clients[0];

  // Find active job
  const jobsData = await gql(token, `
    query($id: EncodedId!) { client(id: $id) { jobs(filter: { status: active }, first: 5) { nodes { id jobNumber title } } } }
  `, { id: match.id });

  const jobs = jobsData?.client?.jobs?.nodes || [];
  if (jobs.length === 0) {
    console.error(`✗ No active job found for "${match.name}"`);
    process.exit(1);
  }

  const job = jobs[0];

  // Add note
  await gql(token, `
    mutation($jobId: EncodedId!, $message: String!) {
      jobCreateNote(jobId: $jobId, input: { message: $message }) {
        jobNote { id }
        userErrors { message }
      }
    }
  `, { jobId: job.id, message: noteText });

  console.log(`✓ Note added to job #${job.jobNumber} — ${match.name} (${job.title})`);
}

async function cmdJobs(clientName) {
  if (!clientName) {
    console.error('Usage: node jobber-cli.js jobs "Client Name"');
    process.exit(1);
  }

  const token = await getToken();

  const clientData = await gql(token, `
    query($term: String!) { clients(searchTerm: $term, first: 5) { nodes { id name } } }
  `, { term: clientName });

  const clients = clientData?.clients?.nodes || [];
  if (clients.length === 0) {
    console.log(`No clients found matching "${clientName}"`);
    return;
  }

  const lower = clientName.toLowerCase();
  const match = clients.find(c =>
    c.name.toLowerCase().includes(lower) ||
    lower.includes(c.name.toLowerCase().split(' ')[0].toLowerCase())
  ) || clients[0];

  const jobsData = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) {
        jobs(first: 10) {
          nodes { id jobNumber title }
        }
      }
    }
  `, { id: match.id });

  const jobs = jobsData?.client?.jobs?.nodes || [];
  console.log(`Jobs for ${match.name}:`);
  if (jobs.length === 0) {
    console.log('  (none)');
  } else {
    jobs.forEach(j => console.log(`  #${j.jobNumber} — ${j.title}`));
  }
}

async function cmdClients() {
  const token = await getToken();
  const data = await gql(token, `{ clients(first: 50) { nodes { id name } } }`);
  const clients = data?.clients?.nodes || [];
  console.log(`Clients (${clients.length}):`);
  clients.forEach(c => console.log(`  ${c.name}`));
}

async function cmdCreateClient(fullName, address) {
  if (!fullName) {
    console.error('Usage: node jobber-cli.js create-client "Full Name" "123 Street, City FL"');
    process.exit(1);
  }

  // Split name into first / last (handle "and", "&", "+")
  const nameParts = fullName.trim().split(/\s+/);
  let firstName, lastName;
  if (nameParts.length === 1) {
    firstName = nameParts[0]; lastName = '';
  } else {
    firstName = nameParts[0];
    lastName = nameParts[nameParts.length - 1];
  }

  // Parse address string: "123 SE Main St, Stuart FL 34994" or "123 SE Main St, Stuart, FL"
  let addressInput = null;
  if (address) {
    const parts = address.split(',').map(s => s.trim());
    const street1 = parts[0] || '';
    let city = '', province = '', postalCode = '';
    if (parts[1]) {
      // "Stuart FL 34994" or "Stuart FL"
      const cityPart = parts[1].trim();
      const cityMatch = cityPart.match(/^(.+?)\s+([A-Z]{2})(?:\s+(\d{5}))?$/);
      if (cityMatch) {
        city = cityMatch[1]; province = cityMatch[2]; postalCode = cityMatch[3] || '';
      } else {
        city = cityPart;
      }
    }
    if (parts[2]) province = parts[2].trim();
    addressInput = { street1, city, province, postalCode, country: 'US' };
  }

  const token = await getToken();

  const mutation = `
    mutation CreateClient($input: ClientCreateInput!) {
      clientCreate(input: $input) {
        client { id name }
        userErrors { message }
      }
    }
  `;

  const input = { firstName, lastName };
  if (addressInput) {
    input.properties = [{ address: addressInput }];
  }

  const data = await gql(token, mutation, { input });
  const errors = data?.clientCreate?.userErrors;
  if (errors && errors.length > 0) {
    console.error('✗ Error:', errors.map(e => e.message).join(', '));
    process.exit(1);
  }

  const client = data?.clientCreate?.client;
  console.log(`✓ Jobber: client created — ${client.name} (ID: ${client.id})`);
  if (addressInput) console.log(`  Address: ${address}`);

  // ── Also create in Notion + config.json immediately ──────────────────────────
  const biz = config.businesses[0]; // Cruz Services
  const notionToken = biz.notion_token;
  const clientsDbId = biz.notion_databases?.clients;

  if (notionToken && clientsDbId && !notionToken.startsWith('secret_REPLACE')) {
    try {
      // Check if already in Notion
      const findRes = await axios.post(
        'https://api.notion.com/v1/databases/' + clientsDbId + '/query',
        { filter: { property: 'Name', title: { equals: client.name } }, page_size: 1 },
        { headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      if (findRes.data.results?.length > 0) {
        console.log(`  Notion: already exists — skipped`);
      } else {
        const toRt = t => [{ type: 'text', text: { content: t || '' } }];
        const props = { Name: { title: toRt(client.name) }, Status: { status: { name: 'Active' } } };
        if (address) props.Address = { rich_text: toRt(address) };
        await axios.post(
          'https://api.notion.com/v1/pages',
          { parent: { database_id: clientsDbId }, properties: props },
          { headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        console.log(`  Notion: ✓ created`);
      }
    } catch (err) {
      console.log(`  Notion: ✗ ${err.message}`);
    }

    // Add to config.json
    try {
      const configPath = path.join(__dirname, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const b = cfg.businesses.find(b => b.name === biz.name);
      if (b && !b.clients.some(c => c.name.toLowerCase() === client.name.toLowerCase())) {
        b.clients.push({ name: client.name, address: address || '' });
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
        console.log(`  config.json: ✓ added`);
      } else {
        console.log(`  config.json: already exists — skipped`);
      }
    } catch (err) {
      console.log(`  config.json: ✗ ${err.message}`);
    }
  }
}

async function cmdRun() {
  const { execSync } = require('child_process');
  console.log('Triggering pipeline run...');
  try {
    const out = execSync(
      'node /root/construction-bi-pipeline/src/index.js --once 2>&1 || ' +
      '/root/.hermes/node/bin/node /root/.hermes/node/lib/node_modules/pm2/bin/pm2 restart construction-bi',
      { timeout: 30000 }
    ).toString();
    console.log(out.slice(0, 500));
  } catch (err) {
    console.log('Pipeline restart triggered (check pm2 logs for results)');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case 'note':          await cmdNote(args[0], args.slice(1).join(' ')); break;
      case 'jobs':          await cmdJobs(args[0]); break;
      case 'clients':       await cmdClients(); break;
      case 'create-client': await cmdCreateClient(args[0], args.slice(1).join(' ')); break;
      case 'run':           await cmdRun(); break;
      default:
        console.log(`Jobber CLI — construction-bi-pipeline

Commands:
  note "Client Name" "Note text"              Add a note to client's active job
  jobs "Client Name"                          List jobs for a client
  clients                                     List all clients
  create-client "Full Name" "Address, City ST" Create a new client
  run                                         Trigger a pipeline run now
`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
