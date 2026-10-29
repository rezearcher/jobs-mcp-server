#!/usr/bin/env node
// Offline check for the HN "Who is hiring?" source orchestrator. Injects a recorded
// thread + item tree (no network) so the free-text header parser, salary clamp,
// remote/keyword filters, and degrade-open behavior are verifiable with plain `node`.
// Then one LIVE discovery call to prove the monthly-thread auto-advance still resolves.
// Run: node test/hn_check.mjs   (exit 0 = pass)

import { searchHnHiring } from '../src/hn/index.js';
import { discoverCurrentThread } from '../src/hn/fetch.js';

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  PASS ${label}`);
  else { console.log(`  FAIL ${label}`); failures++; }
}

// ---- fixture: a thread item tree with real-world header shapes ----------------
const items = {
  id: 99999,
  children: [
    // pipe-delimited, remote, salary
    { id: 1, author: 'a1', created_at: '2026-10-01T10:00:00Z',
      text: '<p>Acme Corp | Senior Backend Engineer | REMOTE (US) | Full-time | $170k to $230k | <a href="https://acme.example/jobs">apply</a></p>' },
    // em-dash delimited, onsite
    { id: 2, author: 'a2', created_at: '2026-10-01T11:00:00Z',
      text: '<p>Globex (Series B) — Staff Data Scientist — San Francisco, CA — ONSITE</p>' },
    // meta/non-job comment: no delimiter -> must be dropped
    { id: 3, author: 'a3', created_at: '2026-10-01T12:00:00Z',
      text: '<p>Please remember to follow the formatting guidelines when posting.</p>' },
    // bogus "salary" (employee count) must NOT become a salary; still a valid role
    { id: 4, author: 'a4', created_at: '2026-10-01T13:00:00Z',
      text: '<p>Initech | Frontend Developer | London, UK | we are 12,000 people strong</p>' },
  ],
};
const thread = { id: '99999', title: 'Ask HN: Who is hiring? (October 2026)', created_at: '2026-10-01T09:00:00Z' };

(async () => {
  // all posts
  const all = await searchHnHiring({ maxResults: 50 }, { thread, items });
  assert(all.count === 3, `3 of 4 comments parse to jobs (meta dropped) — got ${all.count}`);
  assert(all.jobs.every((j) => j.title && j.company && j.source_platform === 'hn'), 'every row has title+company+source_platform=hn');
  assert(all.jobs.every((j) => !/^https?:\/\//.test(j.title) && !/^full[\s-]?time$/i.test(j.title)), 'no URL/employment-term leaked as title');

  const acme = all.jobs.find((j) => j.company === 'Acme Corp');
  assert(!!acme && /backend engineer/i.test(acme.title), 'Acme title parsed');
  assert(acme && acme.remote === true, 'Acme classified remote');
  assert(acme && acme.salary_min === 170000 && acme.salary_max === 230000 && acme.salary_currency === 'USD', `Acme salary 170k-230k USD (got ${acme && acme.salary})`);
  assert(acme && /acme\.example/.test(acme.url), 'Acme apply URL extracted');

  const initech = all.jobs.find((j) => j.company === 'Initech');
  assert(!!initech && initech.salary == null, 'bogus "12,000 people" not parsed as salary');
  assert(initech && /item\?id=4/.test(initech.url), 'Initech falls back to HN permalink (no apply link)');

  // remote-only filter
  const remote = await searchHnHiring({ remoteOnly: true }, { thread, items });
  assert(remote.count === 1 && remote.jobs[0].company === 'Acme Corp', `remoteOnly keeps 1 (Acme) — got ${remote.count}`);

  // keyword filter
  const kw = await searchHnHiring({ query: 'data scientist' }, { thread, items });
  assert(kw.count === 1 && kw.jobs[0].company === 'Globex', `query=data scientist keeps 1 (Globex) — got ${kw.count}`);

  // maxResults clamp
  const capped = await searchHnHiring({ maxResults: 2 }, { thread, items });
  assert(capped.count === 2, `maxResults=2 caps output — got ${capped.count}`);

  // LIVE: the monthly-thread auto-discovery still resolves a hiring thread
  try {
    const live = await discoverCurrentThread({ fetchImpl: fetch });
    assert(!!live.id && /who is hiring/i.test(live.title), `LIVE discovery -> "${live.title}" (${live.id})`);
  } catch (e) {
    assert(false, `LIVE discovery failed: ${e.message}`);
  }

  console.log(failures === 0 ? '\nALL PASS (hn_check)' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
