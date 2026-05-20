const http = require('http');
const { setLocation, getAllLocations } = require('./location-cache');
const { log } = require('./logger');

function startLocationServer(port = 3456) {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // POST /set-location — called by iPhone Shortcut or Tasker when arriving at a job site
    if (req.method === 'POST' && req.url === '/set-location') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const { pocket_api_key, client } = JSON.parse(body);
          if (!pocket_api_key || !client) {
            return send(400, { error: 'pocket_api_key and client are required' });
          }
          setLocation(pocket_api_key, client);
          log(`[Location] Check-in: ${pocket_api_key.slice(0, 16)}... → "${client}"`);
          send(200, { ok: true, client });
        } catch {
          send(400, { error: 'Invalid JSON body' });
        }
      });

    // GET /status — health check, also shows current check-ins (useful for debugging)
    } else if (req.method === 'GET' && req.url === '/status') {
      send(200, { ok: true, locations: getAllLocations() });

    } else {
      send(404, { error: 'Not found' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log(`[Location] Webhook server listening on port ${port}`);
    log(`[Location] Test with: curl http://localhost:${port}/status`);
  });

  server.on('error', err => {
    log(`[Location] Server error: ${err.message}`);
  });

  return server;
}

module.exports = { startLocationServer };
