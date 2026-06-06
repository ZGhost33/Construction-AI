const https = require('https');
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const COMMITMENTS_DB = '34d0b35e-5a9e-80c7-b37a-fa02631bf146';

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
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  
  const filter = {
    filter: {
      and: [
        { property: 'Status', select: { equals: 'OPEN' } },
        { property: 'Due Date', date: { on_or_before: tomorrow.toISOString().split('T')[0] } }
      ]
    },
    sorts: [{ property: 'Due Date', direction: 'ascending' }]
  };
  
  const response = await notionRequest(`/v1/databases/${COMMITMENTS_DB}/query`, 'POST', filter);
  
  if (response.results && response.results.length > 0) {
    console.log(`Found ${response.results.length} commitment(s) due in next 48 hours:`);
    response.results.forEach(page => {
      const title = page.properties.Commitment?.title?.[0]?.plain_text || 'Untitled';
      const client = page.properties.Client?.title?.[0]?.plain_text || 'Unknown';
      const dueDate = page.properties['Due Date']?.date?.start || 'N/A';
      console.log(`  - ${client}: ${title} (due: ${dueDate})`);
    });
  } else {
    console.log('No commitments due in next 48 hours.');
  }
})();
