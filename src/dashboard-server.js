/**
 * dashboard-server.js
 * CEO dashboard — all clients, commitments, field activity, financial overview.
 */

const http = require('http');
const url  = require('url');
const { loadConfig }        = require('./config');
const { fetchDashboardData } = require('./dashboard-data');

const PORT = process.env.DASHBOARD_PORT || 4000;

let cache = null, cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getData() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  const config = loadConfig();
  cache = await fetchDashboardData(config);
  cacheTime = Date.now();
  return cache;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jobBadge(status) {
  const map = {
    active:              ['#22c55e', 'Active'],
    requires_invoicing:  ['#f59e0b', 'Invoice'],
    late:                ['#ef4444', 'Late'],
    unscheduled:         ['#a855f7', 'Unscheduled'],
    action_required:     ['#f97316', 'Action Req.'],
    awaiting_response:   ['#3b82f6', 'Awaiting'],
    approved:            ['#22c55e', 'Approved'],
    draft:               ['#6b7280', 'Draft'],
    changes_requested:   ['#f97316', 'Changes Req.'],
  };
  const [color, label] = map[status] || ['#475569', status || '?'];
  return `<span class="badge" style="background:${color}22;color:${color};border-color:${color}44">${label}</span>`;
}

function clientStatusDot(jobs) {
  if (!jobs || jobs.length === 0) return '#475569';
  const statuses = jobs.map(j => j.status);
  if (statuses.includes('late'))               return '#ef4444';
  if (statuses.includes('action_required'))    return '#f97316';
  if (statuses.includes('requires_invoicing')) return '#f59e0b';
  if (statuses.includes('active'))             return '#22c55e';
  if (statuses.includes('unscheduled'))        return '#a855f7';
  return '#475569';
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  const mins  = Math.floor(diff / 60000);
  if (days > 0)  return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0)  return `${mins}m ago`;
  return 'just now';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 }).format(n || 0);
}

function trunc(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function renderDashboard(data) {
  const { clients, commitments, activity, openQuestions, quotes, pendingRevenue, fetchedAt } = data;

  const activeJobs   = clients.reduce((n, c) => n + c.jobs.length, 0);
  const totalCommits = commitments.length;
  const openQCount   = openQuestions.length;
  const pendingQ     = quotes.filter(q => q.status !== 'draft');
  const pendingQVal  = pendingQ.reduce((s, q) => s + q.total, 0);

  // Group commitments by client for the commitments section
  const commitsByClient = {};
  for (const c of commitments) {
    const k = c.client || 'Unassigned';
    if (!commitsByClient[k]) commitsByClient[k] = [];
    commitsByClient[k].push(c);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Cruz Services — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}

/* Header */
.header{background:#1a1a2e;border-bottom:1px solid #2d2d44;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.logo{display:flex;align-items:center;gap:12px}
.logo-mark{width:34px;height:34px;background:#e94560;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0}
.logo-text{font-size:17px;font-weight:700;color:#fff;line-height:1.2}
.logo-sub{font-size:10px;color:#64748b;letter-spacing:1px;text-transform:uppercase}
.hdr-right{display:flex;align-items:center;gap:12px}
.refresh-btn{background:#2d2d44;border:1px solid #3d3d54;color:#94a3b8;padding:5px 12px;border-radius:7px;font-size:12px;text-decoration:none;transition:all .15s}
.refresh-btn:hover{background:#3d3d54;color:#fff}
.updated{font-size:11px;color:#475569}

/* Layout */
.main{padding:20px 24px;max-width:1440px;margin:0 auto}

/* KPI */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.kpi{background:#1a1a2e;border:1px solid #2d2d44;border-radius:10px;padding:18px 20px}
.kpi-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.kpi-val{font-size:30px;font-weight:700;color:#fff;line-height:1}
.kpi-sub{font-size:11px;color:#64748b;margin-top:5px}
.kpi-red   {border-top:3px solid #e94560}
.kpi-green {border-top:3px solid #22c55e}
.kpi-blue  {border-top:3px solid #3b82f6}
.kpi-amber {border-top:3px solid #f59e0b}

/* Section header */
.sec{margin-bottom:22px}
.sec-title{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.9px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.cnt{background:#2d2d44;color:#94a3b8;padding:1px 7px;border-radius:9px;font-size:11px}

/* Client cards grid */
.clients-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.client-card{background:#1a1a2e;border:1px solid #2d2d44;border-radius:10px;padding:14px 16px;transition:border-color .15s;position:relative}
.client-card:hover{border-color:#4d4d64}
.cc-dot{width:8px;height:8px;border-radius:50%;position:absolute;top:14px;right:14px;flex-shrink:0}
.cc-name{font-size:14px;font-weight:600;color:#e2e8f0;margin-bottom:3px;padding-right:20px}
.cc-addr{font-size:11px;color:#475569;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-jobs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;min-height:20px}
.cc-footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #1e1e32;padding-top:8px;margin-top:4px}
.cc-commits{font-size:11px;color:#e94560}
.cc-activity{font-size:11px;color:#475569}
.cc-activity.fresh{color:#22c55e}
.no-job{font-size:11px;color:#2d2d44;font-style:italic}

/* Badge */
.badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;letter-spacing:.3px;border:1px solid transparent}

/* Two col */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:22px}

/* Commitments */
.client-group{background:#1a1a2e;border:1px solid #2d2d44;border-radius:9px;margin-bottom:10px;overflow:hidden}
.cg-header{padding:8px 14px;background:#16162a;border-bottom:1px solid #2d2d44;font-size:12px;font-weight:600;color:#94a3b8;display:flex;justify-content:space-between}
.commit-row{padding:9px 14px;border-bottom:1px solid #1e1e32;display:flex;align-items:flex-start;gap:9px}
.commit-row:last-child{border-bottom:none}
.cdot{width:5px;height:5px;border-radius:50%;background:#e94560;margin-top:5px;flex-shrink:0}
.commit-name{font-size:12px;color:#e2e8f0;flex:1}
.commit-meta{font-size:10px;color:#475569;margin-top:1px}
.commit-due{font-size:11px;color:#f59e0b;flex-shrink:0;margin-left:8px}

/* Activity */
.act-list{background:#1a1a2e;border:1px solid #2d2d44;border-radius:9px;overflow:hidden}
.act-row{padding:11px 14px;border-bottom:1px solid #1e1e32;display:grid;grid-template-columns:70px 110px 1fr;gap:10px;align-items:start}
.act-row:last-child{border-bottom:none}
.act-row:hover{background:#16162a}
.act-date{font-size:11px;color:#475569}
.act-client{font-size:12px;font-weight:600;color:#cbd5e1}
.act-summary{font-size:11px;color:#64748b;line-height:1.5}

/* Quotes */
.quote-list{background:#1a1a2e;border:1px solid #2d2d44;border-radius:9px;overflow:hidden}
.quote-row{padding:10px 14px;border-bottom:1px solid #1e1e32;display:flex;align-items:center;gap:10px}
.quote-row:last-child{border-bottom:none}
.q-client{font-size:12px;font-weight:600;color:#cbd5e1;flex:1}
.q-title{font-size:11px;color:#475569}
.q-amt{font-size:13px;font-weight:600;color:#22c55e;flex-shrink:0}

/* Open questions */
.oq-list{background:#1a1a2e;border:1px solid #2d2d44;border-radius:9px;overflow:hidden}
.oq-row{padding:9px 14px;border-bottom:1px solid #1e1e32;display:flex;align-items:center;gap:8px}
.oq-row:last-child{border-bottom:none}
.oq-dot{width:5px;height:5px;border-radius:50%;background:#3b82f6;flex-shrink:0}
.oq-name{font-size:12px;color:#e2e8f0}

/* Empty */
.empty{padding:20px;text-align:center;color:#2d2d44;font-size:12px;background:#1a1a2e;border:1px solid #2d2d44;border-radius:9px}

@media(max-width:900px){
  .kpi-row{grid-template-columns:repeat(2,1fr)}
  .two-col{grid-template-columns:1fr}
  .act-row{grid-template-columns:70px 1fr}
}
@media(max-width:600px){
  .main{padding:12px}
  .kpi-row{gap:10px}
  .kpi-val{font-size:24px}
  .clients-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-mark">C</div>
    <div>
      <div class="logo-text">Cruz Services</div>
      <div class="logo-sub">Operations Dashboard</div>
    </div>
  </div>
  <div class="hdr-right">
    <span class="updated">Updated ${timeAgo(fetchedAt)}</span>
    <a class="refresh-btn" href="/refresh">↻ Refresh</a>
  </div>
</div>

<div class="main">

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi kpi-red">
      <div class="kpi-label">Active Clients</div>
      <div class="kpi-val">${clients.length}</div>
      <div class="kpi-sub">${activeJobs} jobs in Jobber</div>
    </div>
    <div class="kpi kpi-green">
      <div class="kpi-label">Pending Quotes</div>
      <div class="kpi-val">${pendingQ.length}</div>
      <div class="kpi-sub">${fmtCurrency(pendingQVal)} total value</div>
    </div>
    <div class="kpi kpi-blue">
      <div class="kpi-label">Open Commitments</div>
      <div class="kpi-val">${totalCommits}</div>
      <div class="kpi-sub">across all clients</div>
    </div>
    <div class="kpi kpi-amber">
      <div class="kpi-label">Open Questions</div>
      <div class="kpi-val">${openQCount}</div>
      <div class="kpi-sub">${activity.length} field recordings this week</div>
    </div>
  </div>

  <!-- All Clients -->
  <div class="sec">
    <div class="sec-title">All Clients <span class="cnt">${clients.length}</span></div>
    <div class="clients-grid">
      ${clients.map(c => {
        const dot = clientStatusDot(c.jobs);
        const hasActivity = c.lastActivity;
        const isFresh = hasActivity && (Date.now() - new Date(c.lastActivity.date).getTime()) < 3 * 86400000;
        return `
        <div class="client-card">
          <div class="cc-dot" style="background:${dot}"></div>
          <div class="cc-name">${c.name}</div>
          <div class="cc-addr">${c.address || '&nbsp;'}</div>
          <div class="cc-jobs">
            ${c.jobs.length > 0
              ? c.jobs.map(j => jobBadge(j.status)).join(' ')
              : `<span class="no-job">No active job</span>`}
          </div>
          <div class="cc-footer">
            <span class="cc-commits">
              ${c.commitmentCount > 0 ? `${c.commitmentCount} commitment${c.commitmentCount > 1 ? 's' : ''}` : ''}
            </span>
            <span class="cc-activity${isFresh ? ' fresh' : ''}">
              ${hasActivity ? `● ${timeAgo(c.lastActivity.date)}` : 'No recent activity'}
            </span>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <div class="two-col">

    <!-- Open Commitments -->
    <div class="sec">
      <div class="sec-title">Open Commitments <span class="cnt">${totalCommits}</span></div>
      ${totalCommits === 0
        ? `<div class="empty">No open commitments ✓</div>`
        : Object.entries(commitsByClient).map(([client, items]) => `
          <div class="client-group">
            <div class="cg-header">${client} <span class="cnt">${items.length}</span></div>
            ${items.map(c => `
            <div class="commit-row">
              <div class="cdot"></div>
              <div style="flex:1">
                <div class="commit-name">${c.name}</div>
                <div class="commit-meta">${[c.whoPromised, c.status].filter(Boolean).join(' · ')}</div>
              </div>
              ${c.byWhen ? `<div class="commit-due">${fmtDate(c.byWhen)}</div>` : ''}
            </div>`).join('')}
          </div>`).join('')}
    </div>

    <!-- Right col -->
    <div>

      <!-- Open Questions -->
      <div class="sec">
        <div class="sec-title">Open Questions <span class="cnt">${openQCount}</span></div>
        ${openQCount === 0
          ? `<div class="empty">No open questions ✓</div>`
          : `<div class="oq-list">
              ${openQuestions.slice(0, 15).map(q => `
              <div class="oq-row">
                <div class="oq-dot"></div>
                <div class="oq-name">${q.name}</div>
              </div>`).join('')}
              ${openQCount > 15 ? `<div style="padding:8px 14px;font-size:11px;color:#475569">+${openQCount - 15} more</div>` : ''}
            </div>`}
      </div>

      <!-- Pending Quotes -->
      <div class="sec">
        <div class="sec-title">Pending Quotes <span class="cnt">${pendingQ.length}</span></div>
        ${pendingQ.length === 0
          ? `<div class="empty">No pending quotes</div>`
          : `<div class="quote-list">
              ${pendingQ.map(q => `
              <div class="quote-row">
                <div>
                  <div class="q-client">${q.client}</div>
                  <div class="q-title">${trunc(q.title, 42)}</div>
                </div>
                ${jobBadge(q.status)}
                <div class="q-amt">${fmtCurrency(q.total)}</div>
              </div>`).join('')}
            </div>`}
      </div>

    </div>
  </div>

  <!-- Recent Field Activity -->
  <div class="sec">
    <div class="sec-title">Recent Field Activity <span class="cnt">Last 7 days — ${activity.length} recordings</span></div>
    ${activity.length === 0
      ? `<div class="empty">No field activity this week</div>`
      : `<div class="act-list">
          ${activity.map(a => `
          <div class="act-row">
            <div class="act-date">${fmtDate(a.date)}</div>
            <div class="act-client">${a.client}</div>
            <div class="act-summary">${trunc(a.summary, 130)}</div>
          </div>`).join('')}
        </div>`}
  </div>

</div>

<script>setTimeout(() => location.reload(), 5 * 60 * 1000);</script>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (pathname === '/api/data') {
    try {
      const data = await getData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/refresh') {
    cache = null;
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  if (pathname === '/') {
    try {
      const data = await getData();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderDashboard(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Dashboard error: ${err.message}`);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function startDashboard(port = PORT) {
  server.listen(port, () => {
    console.log(`[Dashboard] CEO dashboard running at http://localhost:${port}`);
  });
}

module.exports = { startDashboard };
