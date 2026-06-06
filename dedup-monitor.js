// Comprehensive dedup + monitor script with pagination
const https = require('https');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const NOTION_TOKEN = cfg.notion_token || process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) { console.error('notion_token missing from config.json'); process.exit(1); }

const DBS = {
  conversation_log: '34d0b35e-5a9e-80a8-87e3-e45e2bfd5270',
  client_details: '34d0b35e-5a9e-80a1-b732-e7fd6d850caa',
  commitments: '34d0b35e-5a9e-80c7-b37a-fa02631bf146',
  open_questions: '34d0b35e-5a9e-80e9-949b-c5c857a06aaa'
};

function notionFetch(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(body);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function notionPatch(pageId, body) {
  return new Promise((resolve, reject) => {
    const url = `https://api.notion.com/v1/pages/${pageId}`;
    const postData = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getTitle(props) {
  const titleKey = Object.keys(props).find(k => props[k].type === 'title');
  if (!titleKey) return 'Untitled';
  return props[titleKey].title?.[0]?.plain_text || 'Untitled';
}

async function queryAll(dbId) {
  let all = [];
  let cursor = null;
  let pageCount = 0;
  do {
    const body = { page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
    if (cursor) body.start_cursor = cursor;
    const result = await notionFetch(`https://api.notion.com/v1/databases/${dbId}/query`, body);
    const results = result.results || [];
    all = all.concat(results);
    cursor = result.has_more ? result.next_cursor : null;
    pageCount++;
    console.log(`  Page ${pageCount}: fetched ${results.length} (total=${all.length}, has_more=${result.has_more})`);
    if (pageCount > 20) {
      console.log('  [WARN] Hit 20 page limit, stopping');
      break;
    }
  } while (cursor);
  return all;
}

async function run() {
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  let totalDeduped = 0;
  const recentEntries = [];
  const dbsToScan = ['conversation_log', 'client_details', 'commitments', 'open_questions'];

  for (const dbName of dbsToScan) {
    const dbId = DBS[dbName];
    console.log(`\n--- ${dbName.replace('_', ' ').toUpperCase()} ---`);

    try {
      const entries = await queryAll(dbId);
      console.log(`Total entries: ${entries.length}`);

      // DEDUP: find exact title matches (first 60 chars, case-insensitive)
      const titleMap = {};  // shortTitle -> {id, created, title}
      const dupesToArchive = [];

      for (const entry of entries) {
        const title = getTitle(entry.properties);
        const short = title.toLowerCase().slice(0, 60);
        if (titleMap[short]) {
          // This is a duplicate - archive the newer one
          const existing = titleMap[short];
          const existingTime = new Date(existing.created).getTime();
          const entryTime = new Date(entry.created_time).getTime();

          if (entryTime > existingTime) {
            dupesToArchive.push({ id: entry.id, title, short });
          } else {
            // The existing one is newer, archive it instead and keep this one
            dupesToArchive.push({ id: existing.id, title: existing.title, short });
            titleMap[short] = { id: entry.id, created: entry.created_time, title };
          }
        } else {
          titleMap[short] = { id: entry.id, created: entry.created_time, title };
        }
      }

      if (dupesToArchive.length > 0) {
        console.log(`Found ${dupesToArchive.length} duplicate(s). Archiving...`);
        for (const d of dupesToArchive) {
          try {
            await notionPatch(d.id, { archived: true });
            totalDeduped++;
            console.log(`  ✅ Archived: "${d.title.slice(0, 60)}" (${d.id.slice(0, 8)})`);
          } catch (err) {
            console.log(`  ❌ Failed: ${err.message}`);
          }
        }
      } else {
        console.log('No duplicates found.');
      }

      // Track recent entries
      const recent = entries.filter(e => new Date(e.created_time) > new Date(thirtyMinsAgo));
      for (const r of recent) {
        recentEntries.push({ db: dbName, title: getTitle(r.properties), created: r.created_time });
      }

    } catch (err) {
      console.log(`ERROR querying ${dbName}: ${err.message}`);
    }
  }

  // Report recent entries
  if (recentEntries.length > 0) {
    console.log(`\n=== RECENT ENTRIES (last 30 min) ===`);
    for (const e of recentEntries) {
      console.log(`  [${e.created}] [${e.db}] ${e.title}`);
    }
  } else {
    console.log('\nNo entries in the last 30 minutes.');
  }

  // Check OPEN commitments
  console.log('\n--- OPEN COMMITMENTS CHECK ---');
  try {
    const allCommitments = await queryAll(DBS.commitments);
    const openOnes = [];
    for (const entry of allCommitments) {
      const props = entry.properties;
      for (const key of Object.keys(props)) {
        const p = props[key];
        if (p.type === 'status' && p.status?.name?.toUpperCase() === 'OPEN') {
          openOnes.push({ title: getTitle(props), key });
          break;
        }
        if (p.type === 'select' && p.select?.name?.toUpperCase() === 'OPEN') {
          openOnes.push({ title: getTitle(props), key });
          break;
        }
      }
    }
    if (openOnes.length === 0) {
      console.log('No items with explicit OPEN status found.');
    } else {
      console.log(`Found ${openOnes.length} OPEN commitments`);
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Duplicates cleaned: ${totalDeduped}`);
  console.log(`Recent entries (30 min): ${recentEntries.length}`);

  // Exit code for silence check
  if (totalDeduped === 0 && recentEntries.length === 0) {
    console.log('[SILENT-ELIGIBLE]');
  }
}

run().catch(console.error);
