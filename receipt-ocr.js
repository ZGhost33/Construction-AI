#!/usr/bin/env node
'use strict';
// receipt-ocr.js — read a receipt/invoice image or PDF and extract the fields
// needed to pre-fill an expense (vendor, total, date, category). Uses the
// Anthropic vision API directly from Node (no Python, no OCR binary). The
// extraction is a SUGGESTION only — the office confirms/edits before anything
// is logged to Jobber.
//
// Usage:
//   receipt-ocr.js <path-to-image-or-pdf>        # prints JSON to stdout
//   receipt-ocr.js <path> --pretty               # human-readable
//
// Output JSON: { ok, vendor, total, date, currency, category, summary, error }

const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = '/root/construction-bi-pipeline';
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const API_KEY = cfg.anthropic_api_key || cfg.businesses?.[0]?.anthropic_api_key;
const MODEL = 'claude-sonnet-4-6';

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function fail(error) { process.stdout.write(JSON.stringify({ ok: false, error }) + '\n'); process.exit(0); }

function anthropic(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: r.statusCode, json: null, raw: d }); } }); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const PROMPT = `You are reading a construction-business receipt or invoice. Extract ONLY these fields and respond with a single JSON object, no prose, no code fences:
{
  "vendor": string|null,      // merchant/supplier name, e.g. "The Home Depot"
  "total": number|null,       // grand total actually paid, in dollars, as a number (no $ or commas)
  "date": "YYYY-MM-DD"|null,  // purchase date
  "currency": string|null,    // e.g. "USD"
  "category": string|null,    // 1-2 words: lumber, hardware, tools, electrical, plumbing, fuel, permit, etc.
  "summary": string           // short expense description, e.g. "Home Depot - lumber & fasteners"
}
If the image is not a readable receipt/invoice, set vendor/total/date to null and summary to a brief note of what you see. Use the GRAND TOTAL (after tax), not the subtotal.`;

(async () => {
  const args = process.argv.slice(2);
  const pretty = args.includes('--pretty');
  const file = args.find(a => !a.startsWith('--'));
  if (!file) fail('usage: receipt-ocr.js <path> [--pretty]');
  if (!API_KEY) fail('anthropic_api_key not found in config.json');
  if (!fs.existsSync(file)) fail('file not found: ' + file);

  const ext = path.extname(file).toLowerCase();
  const b64 = fs.readFileSync(file).toString('base64');
  let mediaBlock;
  if (ext === '.pdf') mediaBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (IMAGE_TYPES[ext]) mediaBlock = { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: b64 } };
  else fail('unsupported file type: ' + ext + ' (need jpg/png/webp/gif/pdf)');

  let res;
  try {
    res = await anthropic({ model: MODEL, max_tokens: 500, temperature: 0, messages: [{ role: 'user', content: [mediaBlock, { type: 'text', text: PROMPT }] }] });
  } catch (e) { fail('api request failed: ' + e.message); }

  if (res.status !== 200 || !res.json) {
    const msg = res.json?.error?.message || res.raw?.slice(0, 200) || ('HTTP ' + res.status);
    fail('api error: ' + msg);
  }
  const text = (res.json.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  // Extract the first JSON object even if wrapped in prose/fences.
  let parsed;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch { fail('could not parse model output: ' + text.slice(0, 200)); }

  const out = {
    ok: true,
    vendor: parsed.vendor ?? null,
    total: (parsed.total === null || parsed.total === undefined) ? null : Number(parsed.total),
    date: parsed.date ?? null,
    currency: parsed.currency ?? null,
    category: parsed.category ?? null,
    summary: parsed.summary || '',
    readable: parsed.vendor != null && parsed.total != null,
  };
  if (pretty) {
    console.log(`Vendor:   ${out.vendor ?? '—'}`);
    console.log(`Total:    ${out.total != null ? '$' + out.total.toFixed(2) : '—'} ${out.currency || ''}`);
    console.log(`Date:     ${out.date ?? '—'}`);
    console.log(`Category: ${out.category ?? '—'}`);
    console.log(`Summary:  ${out.summary}`);
    console.log(`Readable: ${out.readable}`);
  } else {
    process.stdout.write(JSON.stringify(out) + '\n');
  }
})();
