const axios = require('axios');

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Notion rich text blocks cap at 2000 chars each; we chunk long text
function toRichText(text) {
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// Query a database for a page whose title property matches `name` (case-insensitive)
async function findClientPage(token, databaseId, clientName) {
  if (!clientName || clientName === 'UNKNOWN') return null;
  try {
    const res = await axios.post(
      `${NOTION_BASE}/databases/${databaseId}/query`,
      {
        filter: {
          property: 'Name',
          title: { equals: clientName },
        },
        page_size: 1,
      },
      { headers: notionHeaders(token), timeout: 15000 }
    );
    return res.data.results?.[0]?.id || null;
  } catch (err) {
    // Fallback: fetch all and match locally (case-insensitive)
    try {
      const all = await axios.post(
        `${NOTION_BASE}/databases/${databaseId}/query`,
        { page_size: 100 },
        { headers: notionHeaders(token), timeout: 15000 }
      );
      const lower = clientName.toLowerCase();
      const match = all.data.results?.find(p => {
        const title = p.properties?.Name?.title?.[0]?.text?.content || '';
        return title.toLowerCase() === lower;
      });
      return match?.id || null;
    } catch {
      return null;
    }
  }
}

async function createConversationLog(token, databaseId, { title, clientPageId, date, participants, summary, transcript, confidence }) {
  // Actual property names from the Notion database schema
  const properties = {
    Name: { title: toRichText(title) },
    Date: { date: { start: date } },
    Confidence: { select: { name: capitalize(confidence || 'low') } },
    Summary: { rich_text: toRichText(summary) },
    'Full Transcript': { rich_text: toRichText(transcript) },
  };

  if (Array.isArray(participants) && participants.length > 0) {
    properties.Participants = {
      multi_select: participants.map(p => ({ name: String(p).replace(/,/g, '/').slice(0, 100) })),
    };
  }

  if (clientPageId) {
    properties.Client = { relation: [{ id: clientPageId }] };
  }

  const res = await axios.post(
    `${NOTION_BASE}/pages`,
    { parent: { database_id: databaseId }, properties },
    { headers: notionHeaders(token), timeout: 15000 }
  );
  return res.data.id;
}

async function createClientDetail(token, databaseId, { detail, clientPageId, category, conversationPageId, date }) {
  const properties = {
    Name: { title: toRichText(detail) },             // title column is "Name"
    Category: { select: { name: category || 'Other' } },
    'Date Captured': { date: { start: date } },
  };
  if (clientPageId) properties.Client = { relation: [{ id: clientPageId }] };
  if (conversationPageId) properties['Conversation Log'] = { relation: [{ id: conversationPageId }] };

  await axios.post(
    `${NOTION_BASE}/pages`,
    { parent: { database_id: databaseId }, properties },
    { headers: notionHeaders(token), timeout: 15000 }
  );
}

async function createCommitment(token, databaseId, { what, clientPageId, who, promisedTo, conversationPageId }) {
  const properties = {
    Name: { title: toRichText(what) },               // title column is "Name"
    'Who Promised': { rich_text: toRichText(who) },
    'Promised To': { rich_text: toRichText(promisedTo) },
    Status: { select: { name: 'Open' } },
  };

  if (clientPageId) properties.Clients = { relation: [{ id: clientPageId }] };
  if (conversationPageId) properties['Source Conversation'] = { relation: [{ id: conversationPageId }] };

  await axios.post(
    `${NOTION_BASE}/pages`,
    { parent: { database_id: databaseId }, properties },
    { headers: notionHeaders(token), timeout: 15000 }
  );
}

async function createOpenQuestion(token, databaseId, { question, clientPageId, askedBy, conversationPageId }) {
  const properties = {
    Name: { title: toRichText(question) },           // title column is "Name"
    'Asked By': { rich_text: toRichText(askedBy) },
    Status: { select: { name: 'Open' } },
  };

  if (clientPageId) properties.Clients = { relation: [{ id: clientPageId }] };
  if (conversationPageId) properties['Source Conversation'] = { relation: [{ id: conversationPageId }] };

  await axios.post(
    `${NOTION_BASE}/pages`,
    { parent: { database_id: databaseId }, properties },
    { headers: notionHeaders(token), timeout: 15000 }
  );
}

async function createClient(token, databaseId, { name, address, contact }) {
  const properties = {
    Name: { title: toRichText(name) },
    Status: { status: { name: 'Active' } },
  };
  if (address) properties.Address = { rich_text: toRichText(address) };
  if (contact) properties['Primary Contact'] = { rich_text: toRichText(contact) };

  const res = await axios.post(
    `${NOTION_BASE}/pages`,
    { parent: { database_id: databaseId }, properties },
    { headers: notionHeaders(token), timeout: 15000 }
  );
  return res.data.id;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

module.exports = {
  findClientPage,
  createConversationLog,
  createClientDetail,
  createCommitment,
  createOpenQuestion,
  createClient,
};
