const https = require('https');
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const QUESTIONS_DB = '34d0b35e-5a9e-80e9-949b-c5c857a06aaa';

function notionRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.notion.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  
  const filter = {
    filter: {
      and: [
        { property: 'Status', select: { equals: 'OPEN' } },
        { property: 'Created', date: { before: twoDaysAgo.toISOString() } }
      ]
    },
    sorts: [{ property: 'Created', direction: 'ascending' }]
  };
  
  const response = await notionRequest(`/v1/databases/${QUESTIONS_DB}/query`, 'POST', filter);
  
  if (response.results && response.results.length > 0) {
    console.log(`Found ${response.results.length} question(s) open for 2+ days:`);
    response.results.slice(0, 5).forEach(page => {
      const question = page.properties.Question?.title?.[0]?.plain_text || 'Untitled';
      const client = page.properties.Client?.title?.[0]?.plain_text || 'Unknown';
      const created = page.properties.Created?.created_time || 'N/A';
      console.log(`  - ${client}: ${question.substring(0, 60)}... (${created.split('T')[0]})`);
    });
    if (response.results.length > 5) console.log(`  ... and ${response.results.length - 5} more`);
  } else {
    console.log('No stale open questions.');
  }
})();
