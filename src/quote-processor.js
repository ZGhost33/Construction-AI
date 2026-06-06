/**
 * quote-processor.js
 *
 * Detects newly converted Jobber quotes and automatically generates:
 *   1. A week-by-week project schedule (PDF)
 *   2. A trade-categorized materials list (PDF)
 *
 * Both PDFs are uploaded to the client's Google Drive folder and
 * a note is added to the Jobber job with links to both files.
 *
 * Processed quote IDs are tracked in converted-quotes.json to
 * avoid reprocessing on every pipeline run.
 */

const fs = require('fs');
const path = require('path');
const { getAccessToken } = require('./jobber');
const axios = require('axios');
const { generateSchedule, generateMaterials } = require('./docs-generator');
const { generateSchedulePDF, generateMaterialsPDF } = require('./pdf-generator');
const { uploadFile } = require('./drive');
const { log } = require('./logger');

const PROCESSED_PATH = path.join(__dirname, '..', 'converted-quotes.json');
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const API_VERSION = '2026-05-12';

function loadProcessed() {
  try { return JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')); } catch { return {}; }
}
function markProcessed(quoteId, data) {
  const p = loadProcessed();
  p[quoteId] = { processed_at: new Date().toISOString(), ...data };
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify(p, null, 2));
}

async function gql(accessToken, query, variables = {}) {
  const res = await axios.post(GRAPHQL_URL, { query, variables }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': API_VERSION,
    },
    timeout: 20000,
  });
  if (res.data.errors) throw new Error(res.data.errors.map(e => e.message).join(', '));
  return res.data.data;
}

// Fetch all converted quotes with full line item details
async function fetchConvertedQuotes(jobberConfig) {
  const accessToken = await getAccessToken(jobberConfig);

  const query = `
    query FetchConverted($cursor: String) {
      quotes(first: 20, after: $cursor) {
        nodes {
          id
          title
          quoteStatus
          client { id name }
          lineItems {
            nodes { name description unitPrice quantity }
          }
          job { id jobNumber title }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const quotes = [];
  let cursor = null;
  do {
    const data = await gql(accessToken, query, cursor ? { cursor } : {});
    const page = data?.quotes;
    for (const q of (page?.nodes || [])) {
      if (q.quoteStatus === 'converted') quotes.push(q);
    }
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return quotes;
}

// Add a note to a Jobber job
async function addJobberNote(jobberConfig, jobId, message) {
  const accessToken = await getAccessToken(jobberConfig);
  await gql(accessToken, `
    mutation($jobId: EncodedId!, $message: String!) {
      jobCreateNote(jobId: $jobId, input: { message: $message }) {
        jobNote { id }
        userErrors { message }
      }
    }
  `, { jobId, message });
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function processNewConvertedQuotes(anthropicApiKey, business, config = {}) {
  const { name: bizName, jobber, clients: configClients } = business;
  if (!jobber?.client_id) return;

  const rootFolderId = config.google_drive_root_folder_id;
  const processed = loadProcessed();

  let convertedQuotes;
  try {
    convertedQuotes = await fetchConvertedQuotes(jobber);
  } catch (err) {
    log(`[${bizName}] Quote processor skipped — ${err.message}`);
    return;
  }

  const newQuotes = convertedQuotes.filter(q => !processed[q.id]);
  if (newQuotes.length === 0) return;

  log(`[${bizName}] ${newQuotes.length} newly converted quote(s) to process`);

  for (const quote of newQuotes) {
    const clientName = quote.client?.name || 'Unknown Client';
    const jobTitle = quote.title || 'Untitled Job';
    const jobId = quote.job?.id;
    const jobNumber = quote.job?.jobNumber;

    log(`[${bizName}] Generating docs for "${jobTitle}" (${clientName})...`);

    // Build line items array for generators
    const lineItems = (quote.lineItems?.nodes || []).map(li => ({
      name: li.name || '',
      description: li.description || '',
      unitPrice: li.unitPrice,
      quantity: li.quantity,
    }));

    const quoteForGen = { title: jobTitle, lineItems };

    let schedulePath, materialsPath, scheduleLink, materialsLink;

    try {
      // ── Generate schedule ──
      log(`[${bizName}]   Generating schedule...`);
      const scheduleData = await generateSchedule(anthropicApiKey, quoteForGen, clientName);
      schedulePath = `/tmp/schedule_${quote.id}_${Date.now()}.pdf`;
      await generateSchedulePDF(scheduleData, clientName, jobTitle, schedulePath);
      log(`[${bizName}]   Schedule PDF created (${scheduleData.estimated_duration_weeks} weeks)`);

      // ── Generate materials ──
      log(`[${bizName}]   Generating materials list...`);
      const materialsData = await generateMaterials(anthropicApiKey, quoteForGen, clientName);
      materialsPath = `/tmp/materials_${quote.id}_${Date.now()}.pdf`;
      await generateMaterialsPDF(materialsData, clientName, jobTitle, materialsPath);
      const totalItems = (materialsData.categories || []).reduce((n, c) => n + (c.items?.length || 0), 0);
      log(`[${bizName}]   Materials PDF created (${materialsData.categories?.length} categories, ${totalItems} items)`);

    } catch (err) {
      log(`[${bizName}]   ERROR generating docs: ${err.message}`);
      markProcessed(quote.id, { error: err.message, client: clientName });
      continue;
    }

    // ── Upload to Drive ──
    if (rootFolderId && rootFolderId !== 'PASTE_FOLDER_ID_HERE') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const safeJob = jobTitle.replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 40);

        const scheduleFile = await uploadFile(
          rootFolderId, clientName, schedulePath,
          `${today} — ${safeJob} — Schedule.pdf`
        );
        scheduleLink = scheduleFile.webViewLink;
        log(`[${bizName}]   ✓ Schedule uploaded to Drive`);

        const materialsFile = await uploadFile(
          rootFolderId, clientName, materialsPath,
          `${today} — ${safeJob} — Materials List.pdf`
        );
        materialsLink = materialsFile.webViewLink;
        log(`[${bizName}]   ✓ Materials list uploaded to Drive`);
      } catch (err) {
        log(`[${bizName}]   Drive upload failed: ${err.message}`);
      }
    }

    // ── Add Jobber note ──
    if (jobId) {
      try {
        const noteLines = [
          `📋 PROJECT DOCUMENTS GENERATED`,
          `Job: #${jobNumber} — ${jobTitle}`,
          `Generated: ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}`,
          ``,
        ];
        if (scheduleLink)   noteLines.push(`📅 Project Schedule: ${scheduleLink}`);
        if (materialsLink)  noteLines.push(`📦 Materials List: ${materialsLink}`);
        if (!scheduleLink && !materialsLink) {
          noteLines.push('PDFs generated — check Drive for files.');
        }
        noteLines.push(``, `AI-generated estimates — review before distributing to client.`);

        await addJobberNote(business.jobber, jobId, noteLines.join('\n'));
        log(`[${bizName}]   ✓ Note added to Jobber job #${jobNumber}`);
      } catch (err) {
        log(`[${bizName}]   Jobber note failed: ${err.message}`);
      }
    } else {
      log(`[${bizName}]   WARNING: no job linked to quote — Jobber note skipped`);
    }

    // Cleanup temp files
    [schedulePath, materialsPath].forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });

    markProcessed(quote.id, {
      client: clientName,
      job: jobTitle,
      jobNumber,
      scheduleLink,
      materialsLink,
    });

    log(`[${bizName}] ✓ "${jobTitle}" docs complete`);

    // Brief pause between quotes to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }
}

module.exports = { processNewConvertedQuotes };
