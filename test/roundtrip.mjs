#!/usr/bin/env node
// Real MCP client handshake against ./server.mjs over stdio: initialize ->
// notifications/initialized -> tools/list -> tools/call (list_platforms, then a
// LIVE search_jobs + detect_ats). Asserts spec-conformant framing and live data.
// Run: node test/roundtrip.mjs   (exit 0 = pass, non-zero = fail)

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'server.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { console.error('NON-JSON line from server:', t); process.exit(1); }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params, { notify = false } = {}) {
  if (notify) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return Promise.resolve(null);
  }
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); } }, 40000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); }
  else { console.log(`  FAIL ${label}`); failures++; }
}

function parseToolJSON(res) {
  const txt = res?.result?.content?.[0]?.text;
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

(async () => {
  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'roundtrip-test', version: '0' },
  });
  assert(init.result?.protocolVersion === '2025-06-18', 'initialize echoes supported protocolVersion');
  assert(init.result?.serverInfo?.name === 'greyridge-jobs-mcp', 'initialize returns serverInfo');
  assert(!!init.result?.capabilities?.tools, 'initialize advertises tools capability');

  // 2. initialized notification (no reply expected)
  await rpc('notifications/initialized', {}, { notify: true });

  // 3. ping
  const pong = await rpc('ping', {});
  assert(pong.result && typeof pong.result === 'object', 'ping -> empty result');

  // 4. tools/list
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['detect_ats', 'list_platforms', 'search_jobs']), 'tools/list returns 3 tools');
  assert((list.result.tools || []).every((t) => t.inputSchema?.type === 'object'), 'every tool has an object inputSchema');

  // 5. list_platforms (offline)
  const plats = parseToolJSON(await rpc('tools/call', { name: 'list_platforms', arguments: {} }));
  assert(plats.count === 8 && plats.platforms.includes('greenhouse') && plats.platforms.includes('bamboohr'), 'list_platforms -> 8 platforms (incl bamboohr)');

  // 6. detect_ats LIVE
  const det = parseToolJSON(await rpc('tools/call', { name: 'detect_ats', arguments: { company: 'bunq' } }));
  assert(det.detected === true && det.platform === 'recruitee', `detect_ats(bunq) -> recruitee (got ${det.platform})`);

  // 7. search_jobs LIVE (explicit platform:token, fast + stable canary)
  const search = parseToolJSON(await rpc('tools/call', { name: 'search_jobs', arguments: { companies: ['greenhouse:stripe'], maxPerCompany: 5 } }));
  assert(search.count >= 1, `search_jobs(greenhouse:stripe) -> ${search.count} live jobs`);
  const j = (search.jobs || [])[0] || {};
  assert(!!j.title && !!j.url && j.source_platform === 'greenhouse', 'live job has title+url+source_platform');

  // 7b. search_jobs LIVE on BambooHR (the new 8th platform, keyless detail-enriched)
  const bh = parseToolJSON(await rpc('tools/call', { name: 'search_jobs', arguments: { companies: ['bamboohr:greenhousejuice'], maxPerCompany: 3 } }));
  assert(bh.count >= 1, `search_jobs(bamboohr:greenhousejuice) -> ${bh.count} live jobs`);
  const bj = (bh.jobs || [])[0] || {};
  assert(!!bj.title && /\.bamboohr\.com\/careers\//.test(bj.url || '') && bj.source_platform === 'bamboohr', 'live BambooHR job has title + careers URL + source_platform');

  // 8. error path: unknown method -> JSON-RPC -32601
  const bad = await rpc('does/not/exist', {});
  assert(bad.error?.code === -32601, 'unknown method -> -32601');

  // 9. tool error surfaces as isError tool result, not protocol error
  const toolErr = await rpc('tools/call', { name: 'search_jobs', arguments: { companies: [] } });
  assert(toolErr.result?.isError === true, 'empty companies -> isError tool result');

  child.stdin.end();
  console.log(failures === 0 ? `\nALL PASS (${nextId - 1} roundtrips)` : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
