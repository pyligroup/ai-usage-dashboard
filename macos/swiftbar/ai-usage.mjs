#!/usr/local/bin/node
// AI Usage — SwiftBar plugin body (invoked by ai-usage.30s.sh).
// Polls http://127.0.0.1:4317/api/usage (dashboard must be running).
// Uses ../shared/summary.mjs via import.meta.url.
//
// Menu: "AI" in the bar → Claude/Codex/Cursor open official product pages;
// nested lines show local % (never use bare "|" in titles — SwiftBar treats
// that as a param separator); "Open dashboard" opens localhost.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const summaryUrl = pathToFileURL(join(__dirname, '../shared/summary.mjs')).href;
const {
  USAGE_URL,
  DASHBOARD_URL,
  PRODUCT_URLS,
  compactLine,
  providerSummaries,
  fmtPct,
} = await import(summaryUrl);

function printOffline(err) {
  console.log('AI');
  console.log('---');
  console.log('Dashboard offline — run npm start');
  if (err) console.log(String(err).slice(0, 120));
  console.log(`Open dashboard | href=${DASHBOARD_URL}`);
}

/** Nested detail lines — no bare "|" in the title (SwiftBar param syntax). */
function printProviderRows(row) {
  const href = PRODUCT_URLS[row.key];
  console.log(href ? `${row.label} | href=${href}` : row.label);
  console.log(`--${row.headlineLabel}: ${fmtPct(row.headlinePct)}`);
  console.log(`--${row.secondaryLabel}: ${fmtPct(row.secondaryPct)}`);
  console.log(`--${row.caption}`);
}

try {
  const res = await fetch(USAGE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  console.log(compactLine(data));
  console.log('---');

  for (const row of providerSummaries(data)) {
    printProviderRows(row);
  }

  console.log('---');
  console.log(`Open dashboard | href=${DASHBOARD_URL}`);
} catch (err) {
  printOffline(err?.message || err);
}
