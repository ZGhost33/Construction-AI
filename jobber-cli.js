#!/usr/bin/env node
/**
 * Jobber CLI — used by Hermes Agent to interact with Jobber from Telegram.
 *
 * CLIENTS
 *   node jobber-cli.js clients
 *   node jobber-cli.js create-client "Full Name" "Address, City ST"
 *   node jobber-cli.js client-update "Name" phone|email|address "new value"
 *
 * JOBS
 *   node jobber-cli.js jobs "Client Name"
 *   node jobber-cli.js job-status "Client Name" close|reopen
 *   node jobber-cli.js note "Client Name" "Note text"
 *
 * QUOTES
 *   node jobber-cli.js quote-list "Client Name"
 *   node jobber-cli.js quote-create "Client Name" "Title" amount
 *
 * INVOICES
 *   node jobber-cli.js invoice-list "Client Name"
 *   node jobber-cli.js invoice-create "Client Name" amount ["note"]
 *   node jobber-cli.js invoice-paid "Client Name" [invoice#]
 *
 * EXPENSES
 *   node jobber-cli.js expense "Client Name" amount "description"
 *
 * PIPELINE
 *   node jobber-cli.js run
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const TOKENS_PATH = path.join(__dirname, 'jobber-tokens.json');
const TOKEN_URL   = 'https://api.getjobber.com/api/oauth/token';
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const API_VERSION = '2026-05-12';

const config       = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
const jobberConfig = config.businesses[0].jobber;

// ── Token management ──────────────────────────────────────────────────────────

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { return null; }
}
function __computeExpiry(accessToken, expiresInSec) {
  try { const p = JSON.parse(Buffer.from(String(accessToken).split(".")[1], "base64").toString()); if (p && p.exp) return p.exp * 1000; } catch (e) {}
  if (expiresInSec) return Date.now() + expiresInSec * 1000;
  return Date.now() + 50 * 60 * 1000;
}
function saveTokens(t) { const tmp = TOKENS_PATH + ".tmp-" + process.pid; fs.writeFileSync(tmp, JSON.stringify(t, null, 2)); fs.renameSync(tmp, TOKENS_PATH); }

async function getToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Not authorized — run: node jobber-setup.js');
  if (Date.now() > tokens.expires_at - 300000) {
    const body = new URLSearchParams({
      client_id: jobberConfig.client_id, client_secret: jobberConfig.client_secret,
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    });
    const res = await axios.post(TOKEN_URL, body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    tokens = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token || tokens.refresh_token,
      expires_at: __computeExpiry(res.data.access_token, res.data.expires_in),
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

// ── Shared helpers ────────────────────────────────────────────────────────────

async function findClient(token, clientName) {
  const data = await gql(token, `
    query($term: String!) {
      clients(searchTerm: $term, first: 5) {
        nodes { id name properties { id } }
      }
    }
  `, { term: clientName });
  const clients = data?.clients?.nodes || [];
  if (!clients.length) throw new Error(`No client found matching "${clientName}"`);
  const lower = clientName.toLowerCase();
  return clients.find(c =>
    c.name.toLowerCase().includes(lower) ||
    lower.includes(c.name.toLowerCase().split(' ')[0].toLowerCase())
  ) || clients[0];
}

async function findActiveJob(token, clientId, clientName) {
  const data = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) { jobs(filter: { status: active }, first: 5) { nodes { id jobNumber title } } }
    }
  `, { id: clientId });
  const jobs = data?.client?.jobs?.nodes || [];
  if (!jobs.length) throw new Error(`No active job found for "${clientName}"`);
  return jobs[0];
}

// ── Note job routing (content-aware) ────────────────────────────────────────
// When a client has more than one active job, route a note to the job whose
// title + scope best matches the note text. Never guess on a toss-up — throw an
// "ambiguous" error listing the options so the caller can ask which job.

function loadClientScope(clientName) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'client-scopes.json'), 'utf8'));
    return (all[config.businesses[0].name] || {})[clientName] || '';
  } catch { return ''; }
}

// Slice out the part of a client's combined scope string for one job title.
function jobScopeSegment(scopeStr, jobTitle, allTitles) {
  if (!scopeStr || !jobTitle) return '';
  const idx = scopeStr.indexOf(jobTitle);
  if (idx === -1) return '';
  let end = scopeStr.length;
  for (const t of allTitles) {
    if (t === jobTitle) continue;
    const j = scopeStr.indexOf(t, idx + jobTitle.length);
    if (j !== -1 && j < end) end = j;
  }
  return scopeStr.slice(idx, end);
}

// Generic words that carry no routing signal — function words plus
// construction/business boilerplate that shows up in many scopes.
const ROUTE_STOPWORDS = new Set(`the and for with from that this these those they them their our your you and not but
about into over under out off back again then than too very just only also more most some any all each both
today tomorrow yesterday morning afternoon evening night week month year day days time soon now later when while
client clients customer customers job jobs note notes call called calling follow update status message
provide provided provides install installs installed installation materials material supply supplied
service services existing change changed remove removed general admin per according layout includes include included
house home property place site visit went going come came delivered delivery deliver bring brought sent
hello thanks thank please okay yeah yes sure done need needs needed want wants get got let make made
have has had will would should could been being are was were that's its it's`.split(/\s+/));

function tokenize(text) {
  return [...new Set(
    (text.toLowerCase().match(/[a-z]{3,}/g) || [])
      .map(w => w.replace(/s$/, ''))
      .filter(w => w.length >= 3 && !ROUTE_STOPWORDS.has(w) && !ROUTE_STOPWORDS.has(w + 's'))
  )];
}

// Decide which active job a note attaches to. Returns the job, or throws an
// error with .ambiguous = true (message lists the options) when unsure.
async function routeNoteJob(token, clientId, clientName, noteText, explicitJobNumber) {
  const data = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) { jobs(filter: { status: active }, first: 10) { nodes { id jobNumber title } } }
    }
  `, { id: clientId });
  const jobs = data?.client?.jobs?.nodes || [];
  if (!jobs.length) throw new Error(`No active job found for "${clientName}"`);

  // Explicit override: --job N
  if (explicitJobNumber != null) {
    const match = jobs.find(j => String(j.jobNumber) === String(explicitJobNumber));
    if (!match) throw new Error(
      `No active job #${explicitJobNumber} for "${clientName}". Active: ` +
      jobs.map(j => '#' + j.jobNumber + ' ' + j.title).join(', ')
    );
    return match;
  }

  if (jobs.length === 1) return jobs[0];

  // Multiple active jobs — route by content match against title + scope.
  // Only DISCRIMINATING tokens count: a word that appears in exactly one job's
  // title+scope. Words shared across jobs (or in none) carry no signal. Title
  // hits are weighted ×2 over scope-only hits.
  const scopeStr  = loadClientScope(clientName);
  const allTitles = jobs.map(j => j.title);
  const bags = jobs.map(j => ({
    job:   j,
    title: j.title.toLowerCase(),
    bag:   (j.title + ' ' + jobScopeSegment(scopeStr, j.title, allTitles)).toLowerCase(),
  }));

  const scores = bags.map(() => 0);
  for (const tok of tokenize(noteText)) {
    const hits = [];
    bags.forEach((b, i) => { if (b.bag.includes(tok)) hits.push(i); });
    if (hits.length === 1) {                       // discriminating
      const i = hits[0];
      scores[i] += bags[i].title.includes(tok) ? 2 : 1;
    }
  }

  const scored = bags
    .map((b, i) => ({ job: b.job, score: scores[i] }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0], second = scored[1];

  if (best.score > 0 && best.score > second.score) return best.job; // clear winner

  // Toss-up or no match — surface the choice instead of guessing.
  const list = jobs.map(j => `  #${j.jobNumber} — ${j.title}`).join('\n');
  const err = new Error(
    `AMBIGUOUS: "${clientName}" has ${jobs.length} active jobs and the note didn't clearly match one.\n` +
    `${list}\n` +
    `Re-run with the job number, e.g.: note "${clientName}" "<text>" --job ${jobs[0].jobNumber}`
  );
  err.ambiguous = true;
  throw err;
}

async function findAnyJob(token, clientId) {
  const data = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) { jobs(first: 1) { nodes { id jobNumber title } } }
    }
  `, { id: clientId });
  return data?.client?.jobs?.nodes?.[0] || null;
}

function today() { return new Date().toISOString().split('T')[0]; }

function checkErrors(payload, mutName) {
  const errors = payload?.userErrors;
  if (errors?.length) throw new Error(errors.map(e => e.message).join(', '));
}

// ── CLIENTS ───────────────────────────────────────────────────────────────────

async function cmdClients() {
  const token = await getToken();
  const data  = await gql(token, `{ clients(first: 50) { nodes { id name } } }`);
  const clients = data?.clients?.nodes || [];
  console.log(`Clients (${clients.length}):`);
  clients.forEach(c => console.log(`  ${c.name}`));
}

async function cmdCreateClient(fullName, address, confirm = false) {
  if (!fullName) { console.error('Usage: jobber-cli.js create-client "Full Name" "Address, City ST" [--confirm]'); process.exit(1); }

  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName  = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  let addressInput = null;
  if (address) {
    const parts = address.split(',').map(s => s.trim());
    const street1 = parts[0] || '';
    let city = '', province = '', postalCode = '';
    if (parts[1]) {
      const m = parts[1].match(/^(.+?)\s+([A-Z]{2})(?:\s+(\d{5}))?$/);
      if (m) { city = m[1]; province = m[2]; postalCode = m[3] || ''; } else { city = parts[1]; }
    }
    if (parts[2]) province = parts[2].trim();
    addressInput = { street1, city, province, postalCode, country: 'US' };
  }

  // Preview-first: a new client is a live record in Jobber + Notion + config.json.
  // Show exactly what will be created and write nothing unless --confirm is passed.
  if (!confirm) {
    console.log('PREVIEW — would create client (nothing written yet):');
    console.log(`  Name:    ${firstName}${lastName ? ' ' + lastName : ''}`);
    console.log(`  Address: ${address || '(none)'}`);
    console.log('  Syncs:   Jobber + Notion + config.json');
    console.log('\nRe-run with --confirm to create it.');
    return;
  }

  const token = await getToken();
  const input = { firstName, lastName };
  if (addressInput) input.properties = [{ address: addressInput }];

  const data   = await gql(token, `
    mutation($input: ClientCreateInput!) {
      clientCreate(input: $input) { client { id name } userErrors { message } }
    }
  `, { input });
  checkErrors(data?.clientCreate, 'clientCreate');
  const client = data?.clientCreate?.client;
  console.log(`✓ Jobber: client created — ${client.name} (ID: ${client.id})`);
  if (addressInput) console.log(`  Address: ${address}`);

  // Also create in Notion + config.json
  const biz         = config.businesses[0];
  const notionToken = biz.notion_token;
  const clientsDbId = biz.notion_databases?.clients;
  if (notionToken && clientsDbId && !notionToken.startsWith('secret_REPLACE')) {
    try {
      const findRes = await axios.post(
        `https://api.notion.com/v1/databases/${clientsDbId}/query`,
        { filter: { property: 'Name', title: { equals: client.name } }, page_size: 1 },
        { headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      if (findRes.data.results?.length > 0) {
        console.log(`  Notion: already exists — skipped`);
      } else {
        const toRt = t => [{ type: 'text', text: { content: t || '' } }];
        const props = { Name: { title: toRt(client.name) }, Status: { status: { name: 'Active' } } };
        if (address) props.Address = { rich_text: toRt(address) };
        await axios.post('https://api.notion.com/v1/pages',
          { parent: { database_id: clientsDbId }, properties: props },
          { headers: { Authorization: `Bearer ${notionToken}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        console.log(`  Notion: ✓ created`);
      }
    } catch (err) { console.log(`  Notion: ✗ ${err.message}`); }
    try {
      const configPath = path.join(__dirname, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const b = cfg.businesses.find(b => b.name === biz.name);
      if (b && !b.clients.some(c => c.name.toLowerCase() === client.name.toLowerCase())) {
        b.clients.push({ name: client.name, address: address || '' });
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
        console.log(`  config.json: ✓ added`);
      } else { console.log(`  config.json: already exists — skipped`); }
    } catch (err) { console.log(`  config.json: ✗ ${err.message}`); }
  }
}

async function cmdClientUpdate(clientName, field, value) {
  if (!clientName || !field || !value) {
    console.error('Usage: jobber-cli.js client-update "Client Name" phone|email|address "new value"');
    process.exit(1);
  }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const f      = field.toLowerCase();
  let input    = {};

  if (f === 'phone') {
    input.phonesToAdd = [{ number: value, primary: true }];
  } else if (f === 'email') {
    input.emailsToAdd = [{ address: value, primary: true }];
  } else if (f === 'address') {
    const parts  = value.split(',').map(s => s.trim());
    const street = parts[0] || '';
    let city = '', province = '', postalCode = '';
    if (parts[1]) {
      const m = parts[1].match(/^(.+?)\s+([A-Z]{2})(?:\s+(\d{5}))?$/);
      if (m) { city = m[1]; province = m[2]; postalCode = m[3] || ''; } else { city = parts[1]; }
    }
    if (parts[2]) province = parts[2].trim();
    input.billingAddress = { street, city, province, postalCode, country: 'US' };
  } else {
    console.error(`Unknown field "${field}" — use: phone, email, address`);
    process.exit(1);
  }

  const data   = await gql(token, `
    mutation($id: EncodedId!, $input: ClientEditInput!) {
      clientEdit(id: $id, input: $input) { client { id name } userErrors { message } }
    }
  `, { id: client.id, input });
  checkErrors(data?.clientEdit, 'clientEdit');
  console.log(`✓ Updated ${field} for ${client.name} → ${value}`);
}

// ── JOBS ──────────────────────────────────────────────────────────────────────

async function cmdJobs(clientName) {
  if (!clientName) { console.error('Usage: jobber-cli.js jobs "Client Name"'); process.exit(1); }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const data   = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) { jobs(first: 10) { nodes { id jobNumber title jobStatus completedAt } } }
    }
  `, { id: client.id });
  const jobs = data?.client?.jobs?.nodes || [];
  console.log(`Jobs for ${client.name} (${jobs.length}):`);
  if (!jobs.length) { console.log('  (none)'); return; }
  jobs.forEach(j => {
    const status = j.completedAt ? 'COMPLETED' : j.jobStatus.toUpperCase();
    console.log(`  #${j.jobNumber} [${status}] — ${j.title}`);
  });
}

async function cmdJobStatus(clientName, action) {
  if (!clientName || !action) {
    console.error('Usage: jobber-cli.js job-status "Client Name" close|reopen');
    console.error('  close  — close/complete the active job');
    console.error('  reopen — reopen a closed job');
    process.exit(1);
  }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const a      = action.toLowerCase();

  if (a === 'close' || a === 'complete' || a === 'done') {
    const job  = await findActiveJob(token, client.id, client.name);
    const data = await gql(token, `
      mutation($jobId: EncodedId!, $input: JobCloseInput!) {
        jobClose(jobId: $jobId, input: $input) { job { id jobNumber } userErrors { message } }
      }
    `, { jobId: job.id, input: { modifyIncompleteVisitsBy: 'COMPLETE_PAST_DESTROY_FUTURE' } });
    checkErrors(data?.jobClose, 'jobClose');
    console.log(`✓ Job #${job.jobNumber} closed — ${client.name}`);

  } else if (a === 'reopen' || a === 'open') {
    // Find most recent job (may be closed)
    const data1 = await gql(token, `
      query($id: EncodedId!) { client(id: $id) { jobs(first: 5) { nodes { id jobNumber title completedAt } } } }
    `, { id: client.id });
    const jobs   = data1?.client?.jobs?.nodes || [];
    const closed = jobs.find(j => j.completedAt);
    if (!closed) { console.log(`No closed job found for ${client.name}`); return; }

    const data2 = await gql(token, `
      mutation($jobId: EncodedId!) {
        jobReopen(jobId: $jobId) { job { id jobNumber } userErrors { message } }
      }
    `, { jobId: closed.id });
    checkErrors(data2?.jobReopen, 'jobReopen');
    console.log(`✓ Job #${closed.jobNumber} reopened — ${client.name}`);

  } else {
    console.error(`Unknown action "${action}" — use: close, reopen`);
    process.exit(1);
  }
}

async function cmdNote(clientName, noteParts) {
  if (!clientName || !noteParts || !noteParts.length) {
    console.error('Usage: jobber-cli.js note "Client Name" "Note text" [--job N]');
    process.exit(1);
  }
  // Pull an optional --job N / --job=N out of the args; the rest is note text.
  let explicitJobNumber = null;
  const textParts = [];
  for (let i = 0; i < noteParts.length; i++) {
    const a = noteParts[i];
    if (a === '--job' || a === '--job-id') { explicitJobNumber = noteParts[++i]; continue; }
    const m = /^--job(?:-id)?=(.+)$/.exec(a);
    if (m) { explicitJobNumber = m[1]; continue; }
    textParts.push(a);
  }
  const noteText = textParts.join(' ');
  if (!noteText) { console.error('Note text is empty.'); process.exit(1); }

  const token  = await getToken();
  const client = await findClient(token, clientName);

  let job;
  try {
    job = await routeNoteJob(token, client.id, client.name, noteText, explicitJobNumber);
  } catch (e) {
    if (e.ambiguous) { console.error(e.message); process.exit(3); }
    throw e;
  }

  const data   = await gql(token, `
    mutation($jobId: EncodedId!, $message: String!) {
      jobCreateNote(jobId: $jobId, input: { message: $message }) {
        jobNote { id } userErrors { message }
      }
    }
  `, { jobId: job.id, message: noteText });
  checkErrors(data?.jobCreateNote, 'jobCreateNote');
  console.log(`✓ Note added to job #${job.jobNumber} — ${client.name} (${job.title})`);
}

// ── QUOTES ────────────────────────────────────────────────────────────────────

async function cmdQuoteList(clientName) {
  if (!clientName) { console.error('Usage: jobber-cli.js quote-list "Client Name"'); process.exit(1); }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const data   = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) {
        quotes(first: 10) { nodes { id quoteNumber title quoteStatus amounts { total } } }
      }
    }
  `, { id: client.id });
  const quotes = data?.client?.quotes?.nodes || [];
  console.log(`Quotes for ${client.name} (${quotes.length}):`);
  if (!quotes.length) { console.log('  (none)'); return; }
  quotes.forEach(q => console.log(`  #${q.quoteNumber} [${q.quoteStatus}] — ${q.title} — $${q.amounts?.total}`));
}

async function cmdQuoteCreate(clientName, title, amountStr, confirm = false) {
  if (!clientName || !title || !amountStr) {
    console.error('Usage: jobber-cli.js quote-create "Client Name" "Title" amount [--confirm]');
    console.error('  Example: jobber-cli.js quote-create "Brian Harris" "Kitchen Reno" 15000 --confirm');
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) { console.error('Amount must be a number'); process.exit(1); }

  const token  = await getToken();
  const client = await findClient(token, clientName);

  if (!client.properties?.length) throw new Error(`No property found for "${client.name}" — add an address first`);
  const propertyId = client.properties[0].id;

  // Preview-first: creating a quote writes a live record to Jobber. Show what
  // would be created and write nothing unless --confirm is passed (mirrors quote-edit).
  if (!confirm) {
    console.log('PREVIEW — would create quote (nothing written yet):');
    console.log(`  Client: ${client.name}`);
    console.log(`  Title:  ${title}`);
    console.log(`  Line item: ${title} — ${money(amount)} (qty 1)`);
    console.log(`  Total:  ${money(amount)}`);
    console.log('\nRe-run with --confirm to create it. (For multi-line estimates, see the SKILL — single-line only here.)');
    return;
  }

  const data   = await gql(token, `
    mutation($attrs: QuoteCreateAttributes!) {
      quoteCreate(attributes: $attrs) { quote { id quoteNumber amounts { total } } userErrors { message } }
    }
  `, {
    attrs: {
      clientId:   client.id,
      propertyId,
      title,
      lineItems:  [{ name: title, quantity: 1, unitPrice: amount }],
    }
  });
  checkErrors(data?.quoteCreate, 'quoteCreate');
  const q = data?.quoteCreate?.quote;
  console.log(`✓ Quote #${q.quoteNumber} created — ${client.name} — $${q.amounts?.total}`);
  console.log(`  Title: ${title}`);
  console.log(`  Open Jobber to review and send to client`);
}

// quote-edit — change a DRAFT/unsent quote's title, prices, or line items.
// Hard rule (Luis): only quotes that are NOT yet approved/converted. Once a quote
// is approved it has become a job's contract, and editing it would silently
// rewrite a live financial record — we never touch that here.
//
// Always previews and writes NOTHING unless --confirm is passed. One operation
// per call. The whole line-item set is fetched, the change applied in-memory,
// the before/after shown, then on --confirm the full set is sent back (Jobber's
// quoteEdit replaces all line items, so we always send the complete list).

// Jobber returns quoteStatus lower-case (e.g. "converted", "draft"). Normalize
// before comparing so the lock can never be bypassed by casing.
const QUOTE_LOCKED = new Set(['APPROVED', 'CONVERTED', 'ARCHIVED']);
function quoteIsLocked(q) { return QUOTE_LOCKED.has(String(q.quoteStatus || '').toUpperCase()); }

const QUOTE_FIELDS = `
  id quoteNumber title quoteStatus amounts { total }
  lineItems(first: 50) { nodes { id name description quantity unitPrice totalPrice taxable } }
`;

function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function renderLineItems(items) {
  if (!items.length) return '  (no line items)';
  return items.map((li, i) =>
    `  ${i + 1}. ${li.name} — ${money(li.unitPrice)}` +
    (Number(li.quantity) !== 1 ? ` × ${li.quantity} = ${money((Number(li.unitPrice) || 0) * (Number(li.quantity) || 0))}` : '') +
    (li.description ? `\n       ${li.description}` : '')
  ).join('\n');
}

// Normalize a fetched line item into a clean quoteEdit input object.
function toInputItem(li) {
  const qty  = Number(li.quantity) || 1;
  const unit = Number(li.unitPrice) || 0;
  return {
    name: li.name || '',
    description: li.description || '',
    quantity: qty,
    unitPrice: unit,
    totalPrice: Math.round(qty * unit * 100) / 100,
    taxable: !!li.taxable,
    saveToProductsAndServices: false,
  };
}

async function findQuoteForEdit(token, clientId, clientName, quoteNumberArg) {
  const data = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) { quotes(first: 20) { nodes { ${QUOTE_FIELDS} } } }
    }
  `, { id: clientId });
  const quotes = data?.client?.quotes?.nodes || [];
  if (!quotes.length) throw new Error(`No quotes found for "${clientName}". Create one first with quote-create.`);

  if (quoteNumberArg != null) {
    const q = quotes.find(x => String(x.quoteNumber) === String(quoteNumberArg));
    if (!q) throw new Error(
      `No quote #${quoteNumberArg} for "${clientName}". Quotes: ` +
      quotes.map(x => `#${x.quoteNumber} [${x.quoteStatus}]`).join(', ')
    );
    if (quoteIsLocked(q)) throw new Error(
      `Quote #${q.quoteNumber} is ${q.quoteStatus} — it's already locked in as the job's contract, so I won't edit it. ` +
      `Quote edits are only allowed before a quote is approved.`
    );
    return q;
  }

  const editable = quotes.filter(q => !quoteIsLocked(q));
  if (!editable.length) throw new Error(
    `"${clientName}" has no editable (un-approved) quotes. ` +
    quotes.map(x => `#${x.quoteNumber} [${x.quoteStatus}]`).join(', ') +
    ` — approved/converted quotes can't be edited here.`
  );
  if (editable.length > 1) throw new Error(
    `"${clientName}" has ${editable.length} editable quotes — say which one with --quote N:\n` +
    editable.map(x => `  #${x.quoteNumber} [${x.quoteStatus}] — ${x.title} — ${money(x.amounts?.total)}`).join('\n')
  );
  return editable[0];
}

async function cmdQuoteEdit(allArgs) {
  // Parse: client name (first non-flag) + flags.
  const a = allArgs.slice();
  let clientName = null, quoteNumber = null, confirm = false;
  let op = null, opVal = null, qty = null, desc = null;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--confirm')       { confirm = true; continue; }
    if (t === '--quote')         { quoteNumber = a[++i]; continue; }
    if (t === '--qty')           { qty = a[++i]; continue; }
    if (t === '--desc')          { desc = a[++i]; continue; }
    if (t === '--title')         { op = 'title';  opVal = a[++i]; continue; }
    if (t === '--add')           { op = 'add';    opVal = a[++i]; continue; }
    if (t === '--remove')        { op = 'remove'; opVal = a[++i]; continue; }
    if (t === '--price')         { op = 'price';  opVal = a[++i]; continue; }
    if (t.startsWith('--'))      { throw new Error(`Unknown flag "${t}"`); }
    if (clientName == null)      { clientName = t; continue; }
  }

  if (!clientName || !op) {
    console.error('Usage: jobber-cli.js quote-edit "Client Name" [--quote N] <operation> [--confirm]');
    console.error('  Operations (one per call):');
    console.error('    --title "New Title"               Rename the quote');
    console.error('    --add "Item name" [--qty Q] [--desc "..."]   ...with a price:  --add "Item name" --price AMOUNT');
    console.error('    --add "Item name" AMOUNT          Add a line item (shorthand; AMOUNT after name)');
    console.error('    --remove N                        Remove line item #N');
    console.error('    --price N AMOUNT                  Set line item #N unit price to AMOUNT');
    console.error('  Previews by default — nothing is written until you add --confirm.');
    console.error('  Only un-approved quotes can be edited (approved/converted are locked).');
    process.exit(1);
  }

  const token  = await getToken();
  const client = await findClient(token, clientName);
  const quote  = await findQuoteForEdit(token, client.id, client.name, quoteNumber);

  // raw keeps each line item's Jobber id so edits/removes are SURGICAL — we
  // touch only the one item, never rewrite the whole set. `after` is an
  // in-memory copy used solely to render the resulting preview + new total.
  const raw    = quote.lineItems?.nodes || [];
  const before = raw.map(toInputItem);
  let after    = before.map(x => ({ ...x }));
  let newTitle = null;
  let summary;
  let plan;   // { kind, ... } — the surgical mutation to run on --confirm

  if (op === 'title') {
    if (!opVal) throw new Error('--title needs a value');
    newTitle = opVal;
    plan = { kind: 'title', title: opVal };
    summary = `Rename quote #${quote.quoteNumber}:\n  "${quote.title}"  →  "${newTitle}"`;

  } else if (op === 'add') {
    // Name is opVal; price from --price, or a bare number right after the name.
    let name = opVal, amount = null;
    const addIdx = a.indexOf('--add');
    if (addIdx !== -1 && a[addIdx + 2] != null && !String(a[addIdx + 2]).startsWith('--') && !isNaN(parseFloat(a[addIdx + 2]))) {
      amount = parseFloat(a[addIdx + 2]);
    }
    const priceIdx = a.indexOf('--price');
    if (priceIdx !== -1 && a[priceIdx + 1] != null) amount = parseFloat(a[priceIdx + 1]);
    if (!name) throw new Error('--add needs an item name');
    if (amount == null || isNaN(amount)) throw new Error('--add needs a price (use: --add "Name" AMOUNT  or  --add "Name" --price AMOUNT)');
    const q = qty != null ? Number(qty) : 1;
    if (isNaN(q) || q <= 0) throw new Error('--qty must be a positive number');
    const item = toInputItem({ name, description: desc || '', quantity: q, unitPrice: amount, taxable: false });
    after.push(item);
    plan = { kind: 'add', item };
    summary = `Add line item to quote #${quote.quoteNumber}:\n  + ${name} — ${money(amount)}${q !== 1 ? ` × ${q} = ${money(amount * q)}` : ''}${desc ? `\n      ${desc}` : ''}`;

  } else if (op === 'remove') {
    const idx = parseInt(opVal, 10);
    if (isNaN(idx) || idx < 1 || idx > raw.length) throw new Error(`--remove needs a line item number 1–${raw.length}`);
    const removed = before[idx - 1];
    if (raw.length === 1) throw new Error('That would leave the quote with no line items — add a replacement first, or remove the quote in Jobber instead.');
    after.splice(idx - 1, 1);
    plan = { kind: 'remove', id: raw[idx - 1].id };
    summary = `Remove line item from quote #${quote.quoteNumber}:\n  − ${idx}. ${removed.name} — ${money(removed.unitPrice)}`;

  } else if (op === 'price') {
    const idx = parseInt(opVal, 10);
    if (isNaN(idx) || idx < 1 || idx > raw.length) throw new Error(`--price needs a line item number 1–${raw.length}`);
    // amount is the token right after the index in the original args
    const priceIdx = a.indexOf('--price');
    const amount = parseFloat(a[priceIdx + 2]);
    if (isNaN(amount)) throw new Error('--price needs an amount, e.g.: --price 2 12000');
    const oldPrice = after[idx - 1].unitPrice;
    const q = after[idx - 1].quantity || 1;
    after[idx - 1].unitPrice  = amount;
    after[idx - 1].totalPrice = Math.round(q * amount * 100) / 100;
    plan = { kind: 'price', id: raw[idx - 1].id, unitPrice: amount, totalPrice: Math.round(q * amount * 100) / 100 };
    summary = `Change price on quote #${quote.quoteNumber}, line ${idx} (${after[idx - 1].name}):\n  ${money(oldPrice)}  →  ${money(amount)}`;
  }

  const newTotal = after.reduce((s, li) => s + (Number(li.totalPrice) || 0), 0);

  // ── Preview ──
  console.log(`📝 Quote #${quote.quoteNumber} — ${client.name}  [${quote.quoteStatus}]`);
  console.log(summary);
  console.log('');
  console.log('Result:');
  console.log(`  Title: ${newTitle || quote.title}`);
  console.log(renderLineItems(after));
  console.log(`  ${'─'.repeat(34)}`);
  console.log(`  New total (est.): ${money(newTotal)}   (was ${money(quote.amounts?.total)})`);

  if (!confirm) {
    console.log('');
    console.log('🔍 Preview only — nothing was changed. Re-run with --confirm to apply.');
    return;
  }

  // ── Apply — one surgical mutation, touching only what changed ──
  let payload, qOut;
  if (plan.kind === 'title') {
    const data = await gql(token, `
      mutation($id: EncodedId!, $attrs: QuoteEditAttributes!) {
        quoteEdit(quoteId: $id, attributes: $attrs) {
          quote { id quoteNumber title amounts { total } } userErrors { message }
        }
      }
    `, { id: quote.id, attrs: { title: plan.title } });
    payload = data?.quoteEdit; checkErrors(payload, 'quoteEdit'); qOut = payload?.quote;

  } else if (plan.kind === 'add') {
    const data = await gql(token, `
      mutation($id: EncodedId!, $items: [QuoteCreateLineItemAttributes!]!) {
        quoteCreateLineItems(quoteId: $id, lineItems: $items) {
          quote { id quoteNumber title amounts { total } } userErrors { message }
        }
      }
    `, { id: quote.id, items: [plan.item] });
    payload = data?.quoteCreateLineItems; checkErrors(payload, 'quoteCreateLineItems'); qOut = payload?.quote;

  } else if (plan.kind === 'remove') {
    const data = await gql(token, `
      mutation($id: EncodedId!, $ids: [EncodedId!]!) {
        quoteDeleteLineItems(quoteId: $id, lineItemIds: $ids) {
          quote { id quoteNumber title amounts { total } } userErrors { message }
        }
      }
    `, { id: quote.id, ids: [plan.id] });
    payload = data?.quoteDeleteLineItems; checkErrors(payload, 'quoteDeleteLineItems'); qOut = payload?.quote;

  } else if (plan.kind === 'price') {
    const data = await gql(token, `
      mutation($id: EncodedId!, $items: [QuoteEditLineItemAttributes!]!) {
        quoteEditLineItems(quoteId: $id, lineItems: $items) {
          quote { id quoteNumber title amounts { total } } userErrors { message }
        }
      }
    `, { id: quote.id, items: [{ lineItemId: plan.id, unitPrice: plan.unitPrice, totalPrice: plan.totalPrice }] });
    payload = data?.quoteEditLineItems; checkErrors(payload, 'quoteEditLineItems'); qOut = payload?.quote;
  }

  console.log('');
  console.log(`✓ Quote #${qOut.quoteNumber} updated — ${client.name} — now ${money(qOut.amounts?.total)}`);
  console.log(`  Open Jobber to review and send to the client.`);
}

// ── INVOICES ──────────────────────────────────────────────────────────────────

async function cmdInvoiceList(clientName) {
  if (!clientName) { console.error('Usage: jobber-cli.js invoice-list "Client Name"'); process.exit(1); }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const data   = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) {
        invoices(first: 10) { nodes { id invoiceNumber subject invoiceStatus amounts { total invoiceBalance } } }
      }
    }
  `, { id: client.id });
  const invoices = data?.client?.invoices?.nodes || [];
  console.log(`Invoices for ${client.name} (${invoices.length}):`);
  if (!invoices.length) { console.log('  (none)'); return; }
  invoices.forEach(i =>
    console.log(`  #${i.invoiceNumber} [${i.invoiceStatus}] — $${i.amounts?.total} (balance: $${i.amounts?.invoiceBalance}) — ${i.subject || ''}`)
  );
}

async function cmdInvoiceCreate(clientName, amountStr, note) {
  if (!clientName || !amountStr) {
    console.error('Usage: jobber-cli.js invoice-create "Client Name" amount ["description"]');
    console.error('  Example: jobber-cli.js invoice-create "Brian Harris" 5000 "50% deposit"');
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) { console.error('Amount must be a number'); process.exit(1); }

  const token  = await getToken();
  const client = await findClient(token, clientName);

  let jobId = null;
  try { const job = await findActiveJob(token, client.id, client.name); jobId = job.id; } catch {}

  const subject     = note || 'Services';
  const invoiceInput = {
    clientId:   client.id,
    subject,
    dueDetails: { dueDate: today() },
    tax:        { taxCalculationMethod: 'EXCLUSIVE' },
    lineItems:  [{ name: subject, quantity: 1, unitPrice: amount }],
  };
  if (jobId) invoiceInput.jobId = jobId;

  const data   = await gql(token, `
    mutation($input: InvoiceCreateInput!) {
      invoiceCreate(input: $input) { invoice { id invoiceNumber amounts { total } } userErrors { message } }
    }
  `, { input: invoiceInput });
  checkErrors(data?.invoiceCreate, 'invoiceCreate');
  const inv = data?.invoiceCreate?.invoice;
  console.log(`✓ Invoice #${inv.invoiceNumber} created — ${client.name} — $${inv.amounts?.total}`);
  if (note) console.log(`  Description: ${note}`);
  if (jobId) console.log(`  Linked to active job`);
}

async function cmdInvoicePaid(clientName, invoiceNumArg) {
  if (!clientName) { console.error('Usage: jobber-cli.js invoice-paid "Client Name" [invoice#]'); process.exit(1); }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const data   = await gql(token, `
    query($id: EncodedId!) {
      client(id: $id) {
        invoices(first: 10) { nodes { id invoiceNumber total balance invoiceStatus } }
      }
    }
  `, { id: client.id });
  const invoices = data?.client?.invoices?.nodes || [];

  let invoice;
  if (invoiceNumArg) {
    invoice = invoices.find(i => String(i.invoiceNumber) === String(invoiceNumArg));
    if (!invoice) { console.error(`Invoice #${invoiceNumArg} not found for ${client.name}`); process.exit(1); }
  } else {
    invoice = invoices.find(i => parseFloat(i.amounts?.invoiceBalance) > 0 &&
      (i.invoiceStatus === 'AWAITING_PAYMENT' || i.invoiceStatus === 'OVERDUE' || i.invoiceStatus === 'SENT'));
    if (!invoice) { console.log(`No outstanding invoices found for ${client.name}`); return; }
  }

  const res    = await gql(token, `
    mutation($id: EncodedId!, $input: InvoiceCloseInput!) {
      invoiceClose(id: $id, input: $input) { invoice { id invoiceNumber invoiceStatus } userErrors { message } }
    }
  `, { id: invoice.id, input: { closeOption: 'MARK_RECEIVED' } });
  checkErrors(res?.invoiceClose, 'invoiceClose');
  console.log(`✓ Invoice #${invoice.invoiceNumber} marked as paid — ${client.name} — $${invoice.amounts?.total}`);
}

// ── EXPENSES ──────────────────────────────────────────────────────────────────

async function cmdExpense(clientName, amountStr, description) {
  if (!clientName || !amountStr || !description) {
    console.error('Usage: jobber-cli.js expense "Client Name" amount "description"');
    console.error('  Example: jobber-cli.js expense "Brian Harris" 245.50 "lumber from Home Depot"');
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) { console.error('Amount must be a number'); process.exit(1); }

  const token  = await getToken();
  const client = await findClient(token, clientName);
  const job    = await findActiveJob(token, client.id, client.name);

  const data   = await gql(token, `
    mutation($input: ExpenseCreateInput!) {
      expenseCreate(input: $input) { expense { id total title } userErrors { message } }
    }
  `, { input: { title: description, description, date: today(), total: amount, linkedJobId: job.id } });
  checkErrors(data?.expenseCreate, 'expenseCreate');
  const exp = data?.expenseCreate?.expense;
  console.log(`✓ Expense logged — ${client.name} job #${job.jobNumber}`);
  console.log(`  $${exp.total} — ${exp.title}`);
}

async function cmdExpenseList(clientName) {
  if (!clientName) {
    console.error('Usage: jobber-cli.js expense-list "Client Name"');
    console.error('  Example: jobber-cli.js expense-list "Lisa & Joe Gallan"');
    process.exit(1);
  }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const query = `
    query($id: EncodedId!) {
      client(id: $id) {
        jobs(first: 25) {
          nodes {
            jobNumber title
            expenses(first: 50) { nodes { id date total title description } }
          }
        }
      }
    }
  `;
  let data;
  for (let attempt = 0; ; attempt++) {
    try { data = await gql(token, query, { id: client.id }); break; }
    catch (e) {
      if (/throttl/i.test(e.message) && attempt < 2) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }

  const jobs = data?.client?.jobs?.nodes || [];
  const rows = [];
  jobs.forEach(j => (j.expenses?.nodes || []).forEach(e =>
    rows.push({ date: e.date, total: Number(e.total) || 0, title: e.title || e.description || '', jobNumber: j.jobNumber, jobTitle: j.title })
  ));
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const total = rows.reduce((s, e) => s + e.total, 0);
  const fmt = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log(`Expenses for ${client.name} (${rows.length}) — total ${fmt(total)}:`);
  if (!rows.length) { console.log('  (none logged)'); return; }
  rows.forEach(e => {
    const d = String(e.date || '').slice(0, 10);
    console.log(`  ${d} — ${fmt(e.total)} — ${e.title}  (job #${e.jobNumber}${e.jobTitle ? ' ' + e.jobTitle : ''})`);
  });
}

// ── JOB P&L ───────────────────────────────────────────────────────────────────
// One combined query (expenses + quotes + invoices) keeps the API cost — and the
// throttle risk — to a single round-trip. Client-level rollup with a per-job
// expense breakdown. "Profit" here is billed revenue minus logged costs; it's a
// running snapshot, not accounting-grade.
async function cmdJobPnl(clientName) {
  if (!clientName) {
    console.error('Usage: jobber-cli.js job-pnl "Client Name"');
    console.error('  Example: jobber-cli.js job-pnl "Lisa & Joe Gallan"');
    process.exit(1);
  }
  const token  = await getToken();
  const client = await findClient(token, clientName);
  const query = `
    query($id: EncodedId!) {
      client(id: $id) {
        jobs(first: 25) {
          nodes { jobNumber title expenses(first: 50) { nodes { total } } }
        }
        quotes(first: 50)   { nodes { quoteStatus   amounts { total } } }
        invoices(first: 50) { nodes { invoiceStatus amounts { total invoiceBalance } } }
      }
    }
  `;
  let data;
  for (let attempt = 0; ; attempt++) {
    try { data = await gql(token, query, { id: client.id }); break; }
    catch (e) {
      if (/throttl/i.test(e.message) && attempt < 2) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
      throw e;
    }
  }

  const jobs     = data?.client?.jobs?.nodes     || [];
  const quotes   = data?.client?.quotes?.nodes   || [];
  const invoices = data?.client?.invoices?.nodes || [];
  const num = n => Number(n) || 0;
  const fmt = n => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';

  // Expenses, with a per-job breakdown.
  const perJob = jobs.map(j => ({
    jobNumber: j.jobNumber, title: j.title,
    expenses: (j.expenses?.nodes || []).reduce((s, e) => s + num(e.total), 0),
  }));
  const totalExpenses = perJob.reduce((s, j) => s + j.expenses, 0);

  // Quotes — total of all, plus the subset that's approved/converted (won work).
  const wonStatuses = new Set(['APPROVED', 'CONVERTED']);
  const totalQuoted = quotes.reduce((s, q) => s + num(q.amounts?.total), 0);
  const approvedQuoted = quotes.filter(q => wonStatuses.has(q.quoteStatus))
                               .reduce((s, q) => s + num(q.amounts?.total), 0);

  // Invoices — billed, collected, outstanding.
  const totalInvoiced = invoices.reduce((s, i) => s + num(i.amounts?.total), 0);
  const outstanding   = invoices.reduce((s, i) => s + num(i.amounts?.invoiceBalance), 0);
  const collected     = totalInvoiced - outstanding;

  const profit = totalInvoiced - totalExpenses;

  console.log(`📊 P&L — ${client.name}`);
  console.log(`  Quoted (contract):  ${fmt(totalQuoted)} across ${quotes.length} quote${quotes.length === 1 ? '' : 's'}` +
    (approvedQuoted ? `  (approved/won: ${fmt(approvedQuoted)})` : ''));
  console.log(`  Invoiced (billed):  ${fmt(totalInvoiced)} across ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`);
  console.log(`     ├ collected:     ${fmt(collected)}`);
  console.log(`     └ outstanding:   ${fmt(outstanding)}`);
  console.log(`  Expenses (cost):    ${fmt(totalExpenses)} across ${perJob.length} job${perJob.length === 1 ? '' : 's'}`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Gross profit:       ${fmt(profit)}  (margin ${pct(profit, totalInvoiced)} of billed)`);
  if (totalQuoted) console.log(`  Spent vs quoted:    ${fmt(totalExpenses)} of ${fmt(totalQuoted)}  (${pct(totalExpenses, totalQuoted)})`);
  if (perJob.length > 1 && totalExpenses) {
    console.log(`  By job:`);
    perJob.filter(j => j.expenses).sort((a, b) => b.expenses - a.expenses)
      .forEach(j => console.log(`     • #${j.jobNumber} ${j.title || ''} — ${fmt(j.expenses)}`));
  }
  if (!quotes.length && !invoices.length && !totalExpenses) {
    console.log(`  (no quotes, invoices, or expenses logged yet)`);
  }
}

// ── PIPELINE ──────────────────────────────────────────────────────────────────

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
  } catch { console.log('Pipeline restart triggered (check pm2 logs for results)'); }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

(async () => {
  try {
    switch (cmd) {
      // Clients
      case 'clients':        await cmdClients(); break;
      case 'create-client':  { const c = args.includes('--confirm'); const r = args.filter(a => a !== '--confirm'); await cmdCreateClient(r[0], r.slice(1).join(' '), c); break; }
      case 'client-update':  await cmdClientUpdate(args[0], args[1], args.slice(2).join(' ')); break;
      // Jobs
      case 'jobs':           await cmdJobs(args[0]); break;
      case 'job-status':     await cmdJobStatus(args[0], args[1]); break;
      case 'note':           await cmdNote(args[0], args.slice(1)); break;
      // Quotes
      case 'quote-list':     await cmdQuoteList(args[0]); break;
      case 'quote-create':   { const c = args.includes('--confirm'); const r = args.filter(a => a !== '--confirm'); await cmdQuoteCreate(r[0], r[1], r[2], c); break; }
      case 'quote-edit':     await cmdQuoteEdit(args); break;
      // Invoices
      case 'invoice-list':   await cmdInvoiceList(args[0]); break;
      case 'invoice-create': await cmdInvoiceCreate(args[0], args[1], args.slice(2).join(' ')); break;
      case 'invoice-paid':   await cmdInvoicePaid(args[0], args[1]); break;
      // Expenses
      case 'expense':        await cmdExpense(args[0], args[1], args.slice(2).join(' ')); break;
      case 'expense-list':   await cmdExpenseList(args[0]); break;
      // Reports
      case 'job-pnl':        await cmdJobPnl(args[0]); break;
      // Pipeline
      case 'run':            await cmdRun(); break;
      default:
        console.log(`Jobber CLI — construction-bi-pipeline

CLIENTS
  clients                                           List all clients
  create-client "Full Name" "Address, City ST" [--confirm]
                                                    Create client (Jobber + Notion + config). Preview unless --confirm.
  client-update "Name" phone|email|address "value"  Update client contact info

JOBS
  jobs "Client Name"                                List all jobs for a client
  job-status "Client Name" close|reopen             Close or reopen a job
  note "Client Name" "Note text" [--job N]          Add note; auto-routes by scope, --job N to target

QUOTES
  quote-list "Client Name"                          List all quotes
  quote-create "Client Name" "Title" amount [--confirm]
                                                    Create a single-line quote. Preview unless --confirm.
  quote-edit "Client Name" [--quote N] <op> [--confirm]
                                                    Edit an UN-APPROVED quote (preview unless --confirm).
                                                    ops: --title "T" | --add "Name" AMOUNT [--qty Q] [--desc D]
                                                         | --remove N | --price N AMOUNT

INVOICES
  invoice-list "Client Name"                        List all invoices
  invoice-create "Client Name" amount ["desc"]      Create an invoice
  invoice-paid "Client Name" [invoice#]             Mark invoice as paid

EXPENSES
  expense "Client Name" amount "description"        Log an expense to active job
  expense-list "Client Name"                        List expenses + total for a client

REPORTS
  job-pnl "Client Name"                             P&L: quoted vs invoiced vs expenses + margin

PIPELINE
  run                                               Trigger a pipeline run now
`);
    }
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  }
})();
