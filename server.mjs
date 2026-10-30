#!/usr/bin/env node
// Grey Ridge jobs-mcp — a zero-dependency Model Context Protocol server exposing a
// normalized, auto-detecting jobs feed across seven applicant-tracking systems
// (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Recruitee, Workable).
//
// Transport: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout, per the
// Model Context Protocol spec. No SDK, no dependencies: the server installs and
// boots instantly under `npx`, and ships no transitive package surface (the thing
// an agent tool should least of all drag in). The protocol framing is small and
// fully spec-conformant; see test/roundtrip.mjs for a real client handshake.
//
// All job data comes from keyless public ATS JSON endpoints via the vendored core
// in ./src — the same maintained adapter layer behind the Grey Ridge jobs feed.

import { scrape, parseEntry } from './src/scrape.js';
import { PLATFORMS } from './src/adapters.js';
import { searchHnHiring } from './src/hn/index.js';
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'greyridge-jobs-mcp', version: '0.3.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

// ---- premium depth rail ----------------------------------------------------
// The four tools below are free and read the live boards directly. Three
// derived layers are heavier to maintain (markup drift, cross-ATS normalization,
// cross-run state) so they are served metered, pay-per-call, over the x402 rail
// — USDC on Base, no account and no API key, the agent's wallet pays the 402
// inline. This constant is the single source of truth the get_premium_access
// tool and the see_also hints read from; nothing here gates a free call.
const PREMIUM = {
  base_url: 'https://assetfactory-jobs-x402.sigrunner.workers.dev',
  payment: {
    protocol: 'x402',
    scheme: 'exact',
    network: 'eip155:8453',
    network_name: 'Base',
    asset: 'USDC',
    pay_to: '0xE601c3FeCbf9Fe9DacAC10b8b87167944cfe93A2',
    how: 'GET the endpoint with no payment to receive the signed 402 challenge, then retry with the X-PAYMENT header. Any x402-aware client (e.g. @x402/fetch) does this automatically from a funded wallet.',
  },
  endpoints: [
    {
      path: '/jobs/comp',
      price_usd: 0.005,
      what: 'Normalized compensation per posting: unifies structured ATS salary fields AND pay-transparency text in job descriptions into {min,max,currency,period,annualized}, plus a per-company disclosure rate and median band.',
      why_paid: 'The pay-range widget markup and free-text phrasing drift constantly across employers; the normalizer needs upkeep a resold firmographics DB does not do.',
    },
    {
      path: '/hiring/signal',
      price_usd: 0.003,
      what: 'Live hiring/buying-intent signal per company: open-req count, intensity grade, department + location histograms, newest-post recency — one aggregate record per company, not listings.',
      why_paid: 'A rollup over the full maintained multi-ATS layer, computed at call time against the live boards.',
    },
    {
      path: '/jobs/search',
      price_usd: 0.004,
      what: 'The same normalized multi-ATS search as the free search_jobs tool, run server-side over a maintained 10-ATS layer (adds Breezy + Personio) with full-description and high-volume pulls.',
      why_paid: 'Metered access to the hosted, always-maintained feed when you do not want to run this stdio server yourself.',
    },
  ],
  free_preview: '/jobs/preview?companies=stripe.com',
};

// A compact, honest upsell pointer attached to free listing results so an agent
// that needs a derived layer knows exactly where it is — never a blocker.
const SEE_ALSO = {
  note: 'These rows are live and free. Derived layers (normalized compensation, hiring-intent signal) are available metered via x402/USDC on Base — call get_premium_access for details.',
  premium_tool: 'get_premium_access',
};

// ---- tool definitions -----------------------------------------------------

const TOOLS = [
  {
    name: 'search_jobs',
    description:
      'Fetch live, normalized open job postings for one or more companies across 7 ATS platforms ' +
      '(Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Recruitee, Workable). Each company may be ' +
      'given as a bare slug ("stripe"), a domain ("stripe.com"), or an explicit "platform:token" ' +
      '("greenhouse:stripe", "lever:palantir", "workday:nvidia.wd5:NVIDIAExternalCareerSite"). The ATS ' +
      'and board token are auto-detected for slugs/domains. Returns a unified schema: title, company, ' +
      'location, remote, employment_type, department, posted_at (ISO), salary, url, source_platform.',
    inputSchema: {
      type: 'object',
      properties: {
        companies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Company slugs, domains, or "platform:token" strings. At least one required.',
          minItems: 1,
        },
        maxPerCompany: {
          type: 'integer',
          description: 'Cap postings returned per company (default 25, max 200).',
          default: 25,
        },
        includeDescription: {
          type: 'boolean',
          description: 'Include the full job description text (heavier payload). Default false.',
          default: false,
        },
      },
      required: ['companies'],
      additionalProperties: false,
    },
  },
  {
    name: 'detect_ats',
    description:
      'Resolve which applicant-tracking system a company uses and its board token, from a bare slug ' +
      'or domain, without pulling the full posting list. Returns {platform, token} or a not-detected ' +
      'result. Cheap probe — use before search_jobs when you only need to know the ATS.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company slug ("bunq") or domain ("bunq.com").' },
      },
      required: ['company'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_platforms',
    description:
      'List the ATS platforms this server supports and how to address each one (token format, whether ' +
      'auto-detect covers it). No network call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_hn_hiring',
    description:
      'Search the CURRENT month\'s Hacker News "Ask HN: Who is hiring?" thread for live job postings, ' +
      'normalized into the same unified schema as search_jobs (title, company, location, remote, ' +
      'employment_type, salary, url, source_platform). The monthly thread id is auto-discovered (it ' +
      'rotates on the 1st of every month) and each free-text post header is parsed into structured ' +
      'fields. Optionally filter by a keyword and/or remote-only. No company list needed — this is the ' +
      'whole thread. source_platform is "hn"; url is the apply link when present, else the HN permalink.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter over title + company + snippet (e.g. "rust", "senior backend"). Omit for all posts.',
        },
        remoteOnly: {
          type: 'boolean',
          description: 'Keep only postings classified as remote. Default false.',
          default: false,
        },
        maxResults: {
          type: 'integer',
          description: 'Cap postings returned (default 50, max 200).',
          default: 50,
        },
        includeDescription: {
          type: 'boolean',
          description: 'Include the post body snippet as the description. Default false.',
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_premium_access',
    description:
      'Describe the metered depth endpoints available beyond this free server: a normalized cross-ATS ' +
      'compensation layer, a per-company hiring-intent signal, and a hosted high-volume multi-ATS search. ' +
      'These are served pay-per-call over x402 (USDC on Base, no account/API key — the caller\'s wallet ' +
      'pays the 402 inline). Returns the base URL, each endpoint\'s path + USD price + what it adds, and ' +
      'the exact payment parameters (network, asset, pay-to, handshake). No network call, no payment.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---- tool handlers ---------------------------------------------------------

function clampMax(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(Math.floor(n), 200);
}

async function toolSearchJobs(args) {
  const companies = Array.isArray(args?.companies) ? args.companies.filter((c) => typeof c === 'string' && c.trim()) : [];
  if (companies.length === 0) throw new Error('`companies` must be a non-empty array of strings');
  const { jobs, resolutions } = await scrape({
    companies,
    maxItemsPerCompany: clampMax(args?.maxPerCompany),
    includeDescription: !!args?.includeDescription,
  });
  return {
    query: { companies, maxPerCompany: clampMax(args?.maxPerCompany), includeDescription: !!args?.includeDescription },
    count: jobs.length,
    resolutions,
    jobs,
    see_also: SEE_ALSO,
  };
}

function toolGetPremiumAccess() {
  return {
    service: 'Grey Ridge Jobs — metered depth rail',
    base_url: PREMIUM.base_url,
    payment: PREMIUM.payment,
    endpoints: PREMIUM.endpoints.map((e) => ({
      url: PREMIUM.base_url + e.path,
      price_usd: e.price_usd,
      what: e.what,
      why_paid: e.why_paid,
    })),
    free_preview_url: PREMIUM.base_url + PREMIUM.free_preview,
    note: 'The four job-search tools on this server are free and read live boards directly. Pay only for the derived layers above, and only per call.',
  };
}

async function toolDetectAts(args) {
  const company = typeof args?.company === 'string' ? args.company.trim() : '';
  if (!company) throw new Error('`company` is required');
  const { explicit } = parseEntry(company);
  if (explicit) {
    return { input: company, detected: true, via: 'explicit', platform: explicit.platform, token: explicit.token };
  }
  // Reuse the pure core: a 1-item scrape surfaces the resolution without a heavy pull.
  const { resolutions } = await scrape({ companies: [company], maxItemsPerCompany: 1 });
  const r = resolutions[0] || {};
  if (r.resolved) {
    return { input: company, detected: true, via: 'auto', platform: r.resolved.platform, token: r.resolved.token };
  }
  return { input: company, detected: false, error: r.error || 'no ATS detected' };
}

async function toolSearchHnHiring(args) {
  // HN is a single whole-thread pull (no per-company fan-out), so it carries a higher
  // default cap (50) than search_jobs. searchHnHiring clamps to [1,200] internally.
  const opts = {
    query: typeof args?.query === 'string' ? args.query : undefined,
    remoteOnly: !!args?.remoteOnly,
    maxResults: args?.maxResults,
    includeDescription: !!args?.includeDescription,
  };
  const { thread, count, jobs } = await searchHnHiring(opts);
  return {
    query: {
      query: opts.query ?? null,
      remoteOnly: opts.remoteOnly,
      maxResults: Number(args?.maxResults) > 0 ? Math.min(Math.floor(Number(args.maxResults)), 200) : 50,
      includeDescription: opts.includeDescription,
    },
    source: 'hackernews-whoishiring',
    thread,
    count,
    jobs,
    see_also: SEE_ALSO,
  };
}

function toolListPlatforms() {
  const notes = {
    greenhouse: 'slug e.g. "stripe" — auto-detected',
    lever: 'slug e.g. "palantir" — auto-detected',
    ashby: 'slug e.g. "openai" — auto-detected',
    smartrecruiters: 'company id e.g. "Experian" — auto-detected',
    workday: 'explicit only: "workday:tenant.wdN:SiteName" or a *.myworkdayjobs.com careers URL',
    recruitee: 'slug e.g. "bunq" — auto-detected',
    workable: 'slug e.g. "epignosis" — auto-detected',
  };
  return {
    platforms: PLATFORMS,
    count: PLATFORMS.length,
    addressing: notes,
    examples: ['greenhouse:stripe', 'lever:palantir', 'ashby:openai', 'bunq.com', 'epignosis'],
  };
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'search_jobs':
      return toolSearchJobs(args);
    case 'detect_ats':
      return toolDetectAts(args);
    case 'list_platforms':
      return toolListPlatforms();
    case 'search_hn_hiring':
      return toolSearchHnHiring(args);
    case 'get_premium_access':
      return toolGetPremiumAccess();
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---- JSON-RPC / MCP plumbing ----------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;

  // Notifications (no id) — never reply.
  if (!isRequest) {
    // notifications/initialized, notifications/cancelled, etc. — nothing to do.
    return;
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Normalized multi-ATS job feed. Call list_platforms to see coverage, detect_ats to resolve a ' +
          'company to its ATS, search_jobs to pull live normalized postings, and search_hn_hiring to read ' +
          'the current month\'s Hacker News "Who is hiring?" thread in the same schema. These reads are free. ' +
          'For derived layers — normalized cross-ATS compensation and a per-company hiring-intent signal — ' +
          'call get_premium_access; those are metered pay-per-call over x402 (USDC on Base, no account).',
      });
      return;
    }
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const data = await dispatchTool(name, args);
        result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        // Tool-level failure: report as an isError tool result, not a protocol error,
        // so the model sees the message and can recover.
        result(id, { content: [{ type: 'text', text: `error: ${e?.message || String(e)}` }], isError: true });
      }
      return;
    }
    default:
      error(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let closed = false;
  const maybeExit = () => { if (closed && inFlight === 0) process.exit(0); };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // Per JSON-RPC: parse error with null id.
      error(null, -32700, 'parse error');
      return;
    }
    // Track in-flight work so EOF (a one-shot pipe) never kills a request that
    // is still awaiting a live fetch. Responses stay ordered by the awaits in handle().
    inFlight += 1;
    handle(msg)
      .catch((e) => {
        if (msg && msg.id !== undefined && msg.id !== null) error(msg.id, -32603, `internal error: ${e?.message || e}`);
      })
      .finally(() => { inFlight -= 1; maybeExit(); });
  });
  // On stdin EOF, drain any in-flight requests before exiting rather than cutting them off.
  rl.on('close', () => { closed = true; maybeExit(); });
}

main();
