# trollbridge-mcp

An MCP (Model Context Protocol) server that wraps **Mini's TrollBridge** —
a pay-per-call bounty-intel bridge for AI agents —
so any MCP-compatible agent can discover and use the bridge through tools.

Bridge: https://mini-tollbooth.onrender.com
Keeper: Mini, a data-bounty hunter. Tolls go to Mini's $1-bet wallet on Base.

## Install

The repo will be published shortly; until then this installs straight from GitHub:

```bash
npx -y github:eric-tijerina/trollbridge-mcp
```

## Claude Desktop config

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trollbridge": {
      "command": "npx",
      "args": ["-y", "github:eric-tijerina/trollbridge-mcp"]
    }
  }
}
```

(Or point `command` at a local checkout: `"command": "node", "args": ["/path/to/trollbridge-mcp/server.js"]`.)

## Tools

**Tolled lanes** — $0.02 USDC per call on Base (eip155:8453) via x402.
This MCP server never pays: when a lane answers HTTP 402, the tool returns
the payment challenge (price, asset, pay-to address) plus instructions for
completing the x402 v2 flow and retrying — with an honest statement that no
payment was made.

| Tool | Lane | What it returns |
|---|---|---|
| `bridge_bounties` | `GET /bounties` | All open bounties worth an agent's time |
| `bridge_fresh` | `GET /fresh` | Bounties posted in the last 24h |
| `bridge_deadlines` | `GET /deadlines` | Class-action / claim deadlines |
| `bridge_sweepstakes` | `GET /sweepstakes` | Free-to-enter sweepstakes, curated |
| `bridge_verdicts` | `GET /verdicts` | Recently-paid bounties |

Each tolled tool accepts an optional `limit` (1–200, default 50).

**Free tools** — no toll, real data:

| Tool | Endpoint | What it returns |
|---|---|---|
| `bridge_tools` | `GET /tools` | Third-party tool directory (marketplace) |
| `bridge_traffic` | `GET /traffic` | Honest bridge stats: lookers vs paid crossings |
| `bridge_health` | `GET /health` | Is the bridge awake, lane count, status |

## Honest notes

- The bridge runs on a free hosting tier and sleeps after ~15 minutes idle;
  the first call after sleep takes ~30 seconds to wake it.
- Traffic is small and growing. `bridge_traffic` reports exactly what the
  bridge has seen — nothing is inflated.
- This server contains no secrets and makes no payments. Tolls are paid
  by the calling agent through the x402 flow, straight to the keeper's
  Base wallet (`0x9412222D7801906B4179E58E44B8Dbf16426Bea2`).

## Dev

```bash
npm install
npm start   # stdio MCP server
```

Set `TROLLBRIDGE_URL` to point at a different bridge instance.
Node >= 18 required.
