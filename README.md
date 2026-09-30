# trollbridge-mcp

An MCP (Model Context Protocol) server that wraps **Mini's TrollBridge** —
a pay-per-call intel bridge for AI agents —
so any MCP-compatible agent can discover and use the bridge through tools.

Bridge: https://mini-tollbooth.onrender.com
Keeper: Mini, a data-bounty hunter. Tolls go to the keeper's Coinbase
on Base (eip155:8453) and Solana — agents pay on either rail via x402.

## Install

Installs straight from GitHub:

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

**Tolled lanes** — $0.02 or $0.05 USDC per call on Base or Solana via x402.
This MCP server never pays: when a lane answers HTTP 402, the tool returns
the payment challenge (price, asset, pay-to addresses for both rails) plus
instructions for completing the x402 v2 flow and retrying — with an honest
statement that no payment was made.

### Bounty lanes — $0.02 each

| Tool | Lane | What it returns |
|---|---|---|
| `bridge_bounties` | `GET /bounties` | All open bounties worth an agent's time |
| `bridge_fresh` | `GET /fresh` | Bounties posted in the last 24h |
| `bridge_deadlines` | `GET /deadlines` | Class-action / claim deadlines |
| `bridge_sweepstakes` | `GET /sweepstakes` | Free-to-enter sweepstakes, curated |
| `bridge_verdicts` | `GET /verdicts` | Recently-paid bounties |
| `bridge_opportunities` | `GET /opportunities` | Every paying opportunity, one normalized schema |

Each bounty tool accepts an optional `limit` (1–200, default 50).

### AI-intel lane — $0.02

| Tool | Lane | What it returns |
|---|---|---|
| `bridge_models` | `GET /models` | x402-payable AI model catalog: 107 models, per-token pricing, free flagged (optional `limit` 1–200) |

### Market-intel lanes

| Tool | Lane | Toll | What it returns |
|---|---|---|---|
| `bridge_prices` | `GET /prices` | $0.02 | Live BTC/ETH/SOL + USDC spot prices |
| `bridge_enrich` | `GET /enrich` | $0.05 | Wallet intel: type, balances, USDC watchlist, risk flags (`address`, `network`) |
| `bridge_token_check` | `GET /token-check` | $0.05 | Rug scan: liquidity, holders, 0–100 safety score + verdict (`mint`, `network`) |
| `bridge_markets` | `GET /markets` | $0.05 | Live Polymarket odds, prices, volume (`q`, optional `limit` 1–25) |
| `bridge_search` | `GET /search` | $0.05 | Web search: title/URL/snippet JSON (`q`) |
| `bridge_yields` | `GET /yields` | $0.05 | Best DeFi yields right now (optional `limit`, `stablecoinOnly`) |
| `bridge_new_pairs` | `GET /new-pairs` | $0.05 | Newest token listings with rug scores (optional `limit`, `chain`) |
| `bridge_gas` | `GET /gas` | $0.02 | Live gas prices per chain |

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
  Coinbase: Base USDC to `0x8BE8D056d5F0bEF850eC9ed5C4a8d647cBE896C0`,
  Solana USDC to `CDhLHtuj1HnPVDuZVtJxyw5aEpf6ZQxfBTrqAtFcWb2e`.

## Dev

```bash
npm install
npm start   # stdio MCP server
```

Set `TROLLBRIDGE_URL` to point at a different bridge instance.
Node >= 18 required.
