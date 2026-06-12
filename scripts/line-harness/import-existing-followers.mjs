#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const getArgValue = (name, fallback) => {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
};

const baseUrl = (process.env.LINE_HARNESS_URL || 'https://csa-line-harness.paison0357.workers.dev').replace(/\/$/, '');
const apiKey = process.env.LINE_HARNESS_API_KEY || process.env.API_KEY;
const dryRun = args.has('--dry-run');
const skipEnrich = args.has('--skip-enrich');
const enrichLimit = Number(getArgValue('--enrich-limit', '50'));
const maxEnrichBatches = Number(getArgValue('--max-enrich-batches', '40'));

if (!apiKey) {
  console.error('Missing LINE_HARNESS_API_KEY or API_KEY.');
  process.exit(1);
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.success === false) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const before = await request('/api/friends/count');
  console.log(`before_count=${before.data.count}`);

  const importResult = await request('/api/friends/import-followers', {
    method: 'POST',
    body: JSON.stringify({ dryRun }),
  });
  console.log(`import=${JSON.stringify(importResult.data)}`);

  if (!dryRun && !skipEnrich) {
    for (let i = 0; i < maxEnrichBatches; i += 1) {
      const result = await request('/api/friends/enrich-profiles', {
        method: 'POST',
        body: JSON.stringify({ limit: enrichLimit }),
      });
      console.log(`enrich_batch_${i + 1}=${JSON.stringify(result.data)}`);
      if (!result.data.remaining || result.data.scanned === 0) break;
    }
  }

  const after = await request('/api/friends/count');
  console.log(`after_count=${after.data.count}`);
}

main().catch((err) => {
  console.error(`error=${err.message}`);
  process.exitCode = 1;
});
