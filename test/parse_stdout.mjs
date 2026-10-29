// Reads JSON-RPC lines from stdin, summarizes the id:2 tools/call result.
let d = '';
process.stdin.on('data', (c) => (d += c)).on('end', () => {
  const lines = d.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r = lines.find((x) => x.id === 2);
  if (!r) { console.log('no id:2 response'); process.exit(1); }
  const j = JSON.parse(r.result.content[0].text);
  const first = j.jobs && j.jobs[0];
  console.log(`npx live search_jobs: count=${j.count} first=${first ? first.title : '?'} platform=${first ? first.source_platform : '?'} url_ok=${!!(first && first.url)}`);
});
