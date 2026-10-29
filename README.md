# Grey Ridge Jobs MCP

[![smoke](https://github.com/rezearcher/jobs-mcp-server/actions/workflows/smoke.yml/badge.svg)](https://github.com/rezearcher/jobs-mcp-server/actions/workflows/smoke.yml)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue)](https://modelcontextprotocol.io)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

A **Model Context Protocol** server that gives any MCP client — Claude Desktop, Cursor, Cline,
Continue, or your own agent — a live, normalized feed of open job postings pulled straight from
company applicant-tracking systems.

One tool call, eight ATS platforms, one clean schema:

> **Greenhouse · Lever · Ashby · SmartRecruiters · Workday · Recruitee · Workable · BambooHR**

Give it a bare company name (`stripe`), a domain (`stripe.com`), or an explicit board
(`greenhouse:stripe`, `workday:nvidia.wd5:NVIDIAExternalCareerSite`) — the server detects the ATS
and board token for you and returns postings with stable field names across every platform.

- **Zero dependencies.** No MCP SDK, no transitive package tree — the server is one file plus a
  vendored adapter core. It installs and boots instantly under `npx`, and drags nothing into your
  agent's trust boundary. (For an agent tool, the supply chain *is* the attack surface.)
- **Zero keys, zero account.** Every source is a public ATS JSON endpoint.
- **Normalized schema.** `title · company · location · remote · employment_type · department ·
  posted_at (ISO) · salary · url · source_platform` — same shape whoever the employer uses.
- **Auto-detect.** Pass a slug or domain; the ATS and token are resolved for you.

## Install

Requires Node.js ≥ 18.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "jobs": {
      "command": "npx",
      "args": ["-y", "github:rezearcher/jobs-mcp-server"]
    }
  }
}
```

### Cursor / Cline / Continue

Point the client at the same command (`npx -y github:rezearcher/jobs-mcp-server`) as a stdio
server. In Cursor: Settings → MCP → Add new server → type `command`.

### From source

```bash
git clone https://github.com/rezearcher/jobs-mcp-server
cd jobs-mcp-server
node server.mjs          # speaks MCP over stdio
npm test                 # real client handshake + live-data roundtrip
```

## Tools

| Tool | What it does |
|------|--------------|
| `search_jobs` | Live normalized postings for one or more companies. Args: `companies` (string[]), `maxPerCompany` (default 25, max 200), `includeDescription` (default false). |
| `detect_ats` | Resolve a company slug/domain to `{platform, token}` without pulling the full list. |
| `list_platforms` | The 8 supported platforms and how to address each. No network call. |

### Example

Ask your assistant: *"Use the jobs tool to list open engineering roles at Stripe and Palantir."*
The model calls:

```json
{ "name": "search_jobs",
  "arguments": { "companies": ["greenhouse:stripe", "lever:palantir"], "maxPerCompany": 25 } }
```

and gets back a `jobs[]` array plus a `resolutions[]` log showing how each company was resolved.

## Addressing a company

| Form | Example | Notes |
|------|---------|-------|
| bare slug | `stripe` | auto-detected across platforms |
| domain | `stripe.com` | auto-detected |
| explicit | `greenhouse:stripe`, `lever:palantir`, `ashby:openai` | skips detection |
| Workday | `workday:nvidia.wd5:NVIDIAExternalCareerSite` or a `*.myworkdayjobs.com` URL | explicit only |

## Why a maintained server (and not a one-off script)

ATS JSON shapes drift and companies migrate between vendors. This server is the public face of a
continuously **maintained** adapter layer: each platform is isolated so a shape change touches one
adapter, and a scheduled canary (`.github/workflows/smoke.yml`) exercises a live board on every push
and daily, failing loudly the moment an adapter stops returning rows. That upkeep is the point — it
is why the feed keeps working after the day you install it.

## License

MIT © Grey Ridge Signals Group LLC. Job content belongs to the respective employers and their ATS
providers; this tool only retrieves and normalizes publicly listed postings. Respect each source's
terms and rate limits.
