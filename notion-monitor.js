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
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error: ${data.slice(0,200)}`));
        }
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

function getRichText(props, name) {
  const key = Object.keys(props).find(k => k.toLowerCase().includes(name.toLowerCase()));
  if (!key) return '';
  const pt = props[key];
  if (pt.type === 'rich_text') return pt.rich_text?.[0]?.plain_text || '';
  if (pt.type === 'select') return pt.select?.name || '';
  if (pt.type === 'multi_select') return pt.multi_select?.map(s => s.name).join(', ') || '';
  if (pt.type === 'date') return pt.date?.start || '';
  if (pt.type === 'relation') return pt.relation?.map(r => r.id).join(', ') || '';
  return '';
}

function getProp(props, name) {
  const key = Object.keys(props).find(k => k.toLowerCase() === name.toLowerCase());
  if (!key) return props[key];
  return props[key];
}

async function queryDatabase(dbId, filter) {
  const body = {
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: 100
  };
  // Only include filter if it has actual conditions
  if (filter && Object.keys(filter).length > 0) {
    body.filter = filter;
  }
  const result = await notionFetch(`https://api.notion.com/v1/databases/${dbId}/query`, body);
  console.log(`  [DEBUG] Query response for ${dbId.slice(0,8)}: has_more=${result.has_more}, results_count=${(result.results||[]).length}, next_cursor=${result.next_cursor}`);
  if ((result.results||[]).length === 0) {
    console.log(`  [DEBUG] Full response keys: ${Object.keys(result).join(', ')}`);
    if (result.object) console.log(`  [DEBUG] object=${result.object}`);
    if (result.status) console.log(`  [DEBUG] error status=${result.status}`);
    if (result.message) console.log(`  [DEBUG] error message=${result.message}`);
    if (result.code) console.log(`  [DEBUG] error code=${result.code}`);
  }
  return result.results || [];
}

async function archivePage(pageId) {
  return new Promise((resolve, reject) => {
    const url = `https://api.notion.com/v1/pages/${pageId}`;
    const postData = JSON.stringify({ archived: true });
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
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  console.log(`=== Notion Monitor — ${new Date().toISOString()} ===`);
  console.log(`Looking for entries since: ${thirtyMinsAgo}`);
  console.log(`Today's date: ${today}`);
  console.log('');

  let totalDeduped = 0;
  const allDBs = ['conversation_log', 'client_details', 'commitments', 'open_questions'];

  for (const dbName of allDBs) {
    const dbId = DBS[dbName];
    console.log(`\n--- ${dbName.replace('_', ' ').toUpperCase()} ---`);
    
    try {
      const entries = await queryDatabase(dbId, {});
      console.log(`Total entries: ${entries.length}`);

      // DEDUP: find exact title matches
      const titles = entries.map(e => ({ id: e.id, title: getTitle(e.properties), created: e.created_time }));
      const seen = {};
      const dupes = [];
      for (const t of titles) {
        const short = t.title.toLowerCase().slice(0, 60);
        if (seen[short]) {
          dupes.push({ newer: t, older: seen[short] });
        } else {
          seen[short] = t;
        }
      }

      if (dupes.length > 0) {
        console.log(`Found ${dupes.length} duplicate(s). Archiving newer copies...`);
        for (const d of dupes) {
          const newerCreated = new Date(d.newer.created).getTime() > new Date(d.older.created).getTime();
          const toArchive = newerCreated ? d.newer : d.older;
          try {
            await archivePage(toArchive.id);
            totalDeduped++;
            console.log(`  Archived: "${toArchive.title.slice(0,50)}..." (${toArchive.id.slice(0,8)})`);
          } catch (err) {
            console.log(`  Failed to archive ${toArchive.id}: ${err.message}`);
          }
        }
      } else {
        console.log('No duplicates found.');
      }

      // Recent entries (last 30 mins)
      const recent = entries.filter(e => new Date(e.created_time) > new Date(thirtyMinsAgo));
      if (recent.length > 0) {
        console.log(`\nRecent entries (${recent.length}):`);
        for (const r of recent) {
          const title = getTitle(r.properties);
          const created = new Date(r.created_time).toLocaleString();
          console.log(`  • [${created}] ${title}`);
          // Print some details based on DB type
          if (dbName === 'commitments') {
            const status = getRichText(r.properties, 'Status') || getRichText(r.properties, 'status');
            console.log(`    Status: ${status || 'N/A'}`);
          }
          if (dbName === 'open_questions') {
            const answer = getRichText(r.properties, 'Answer') || getRichText(r.properties, 'answer');
            if (!answer) console.log(`    ⚠ No answer yet`);
          }
        }
      } else {
        console.log('No entries in the last 30 minutes.');
      }
    } catch (err) {
      console.log(`ERROR querying ${dbName}: ${err.message}`);
    }
  }

  // Check Open commitments
  console.log('\n--- OPEN COMMITMENTS CHECK ---');
  try {
    const allCommitments = await queryDatabase(DBS.commitments, {});
    // Look for a status property that indicates OPEN
    const openStatuses = allCommitments.filter(entry => {
      const statusKey = Object.keys(entry.properties).find(k => 
        entry.properties[k].type === 'select' || entry.properties[k].type === 'status'
      );
      if (!statusKey) return false;
      const status = entry.properties[statusKey];
      return status.select?.name?.toUpperCase() === 'OPEN' || status.status?.name?.toUpperCase() === 'OPEN';
    });

    if (openStatuses.length === 0) {
      // Maybe they don't have a status field or all are non-OPEN
      console.log('No items with explicit OPEN status found.');
      // Print last 5 commitments for context
      if (allCommitments.length > 0) {
        console.log('Last 5 commitments:');
        for (const c of allCommitments.slice(0, 5)) {
          const title = getTitle(c.properties);
          const created = new Date(c.created_time).toLocaleString();
          console.log(`  • [${created}] ${title}`);
        }
      }
    } else {
      console.log(`Found ${openStatuses.length} OPEN commitment(s):`);
      for (const c of openStatuses) {
        const title = getTitle(c.properties);
        const who = getRichText(c.properties, 'who') || getRichText(c.properties, 'Who');
        const client = getRichText(c.properties, 'client') || '';
        console.log(`  • ${title} (assigned to: ${who || 'unassigned'}, client: ${client || 'unknown'})`);
      }
    }
  } catch (err) {
    console.log(`ERROR checking commitments: ${err.message}`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Duplicates cleaned: ${totalDeduped}`);
}

run().catch(console.error);
