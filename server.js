// Mini's Tollbooth — a chain of tollbooths on one bridge.
// Thirteen tolled lanes on Base or Solana per call:
//   Bounty intel ($0.02 USDC each):
//   GET /bounties    — every open bounty across all boards (aibtc + Taskmarket + Superteam)
//   GET /fresh       — bounties posted in the last 24h
//   GET /verdicts    — recently paid bounties: proof the boards actually pay
//   GET /deadlines   — class-action / settlement claim deadlines worth real money
//   GET /sweepstakes — free sweepstakes with real prizes
//   Trader intel (for agents with funded wallets):
//   GET /prices      — agent-ready crypto price feed, no API key needed ($0.02)
//   GET /enrich      — wallet/address intelligence: balances, holdings, risk flags ($0.05)
//   GET /token-check — token safety scan: liquidity, holders, rug verdict ($0.05)
//   Market intel:
//   GET /markets     — live Polymarket odds, prices, volume ($0.05)
//   GET /search      — web search JSON, no API key needed ($0.05)
//   DeFi intel:
//   GET /yields      — best stablecoin yields right now, DeFiLlama ($0.05)
//   GET /new-pairs   — newest token listings with thin-liquidity flags ($0.05)
//   GET /gas         — live gas prices per chain ($0.02)
//
// Run: node server.js  (builds feed.json + prices.json at boot, refreshes every 6h)
// Cost to operate: $0. No gas, no chain interaction — the facilitator verifies.
// Traffic: the troll keeps a ledger — GET /traffic (free) shows challenged
// vs paid crossings per lane plus unique payer wallets. Counters live in
// data/usage.json (ephemeral across redeploys on free-tier hosting).
const express = require("express");
const fs = require("fs");
const path = require("path");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { ExactSvmScheme } = require("@x402/svm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");
// CDP Bazaar discovery: the pre-configured Coinbase facilitator settles on
// Base mainnet AND reports our lanes to the Bazaar catalog, which feeds tens
// of thousands of agents via CDP APIs, the Bazaar MCP server, and Amazon
// Bedrock AgentCore. Needs CDP_API_KEY_ID/_SECRET env (CDP account, free tier
// 1,000 tx/mo); without keys it falls back to the keyless config, which
// currently 401s on CDP endpoints — so CDP keys are required for the CDP path.
const { createFacilitatorConfig } = require("@coinbase/x402");
const { declareDiscoveryExtension, bazaarResourceServerExtension } = require("@x402/extensions/bazaar");
const { build } = require("./build-feed");
const trader = require("./trader-data");
const intel = require("./markets-data");
const defi = require("./defi-data");


const PAY_TO = process.env.PAY_TO || "0x9412222D7801906B4179E58E44B8Dbf16426Bea2";
const NETWORK = process.env.NETWORK || "eip155:8453"; // Base mainnet
const PRICE = process.env.PRICE || "$0.02";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana mainnet
const SOLANA_PAY_TO =
  process.env.SOLANA_PAY_TO || "GKkVwuJ9AwFiWXQke78T1jmzAaxPcamkVyrQN5g7a4JZ";
const PORT = process.env.PORT || 3000;
const IS_MAINNET = NETWORK === "eip155:8453";
const REFRESH_MS = 6 * 60 * 60 * 1000; // rebuild the feed every 6h while awake


// Facilitator: CDP when CDP_API_KEY_ID/_SECRET are set (required for Bazaar
// indexing — settlements must flow through CDP). FACILITATOR_URL env overrides
// with a plain URL facilitator (e.g. PayAI, keyless) when set — the current
// live default until CDP keys exist.
const facilitator = process.env.FACILITATOR_URL
  ? new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL })
  : new HTTPFacilitatorClient(
      createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
    );
const server = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactEvmScheme())
  .register(SOLANA_NETWORK, new ExactSvmScheme())
  .registerExtension(bazaarResourceServerExtension);


const app = express();
// Required behind Render/Railway/Fly proxies: without this the middleware
// reports http:// URLs and facilitators reject the route metadata.
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));


// ---- Bridge traffic ledger ----
// Counts every agent that approaches the bridge: 402 challenges (lookers)
// vs paid crossings (agents through) on the tolled lanes, free visits to
// the directory and discovery surfaces (/tools, /, /skill.md, /.well-known/x402,
// /openapi.json), plus unique payer wallets per lane.
// Runs BEFORE the toll collector so it sees both outcomes via res 'finish'.
// Persisted to data/usage.json (ephemeral on free-tier redeploys; the
// counters are a dashboard, not money — the chain is the money record).
const USAGE_PATH = path.join(__dirname, "data", "usage.json");
function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
  } catch {
    return { bridge: "TrollBridge", started_at: new Date().toISOString(), lanes: {} };
  }
}
function laneStats(u, route) {
  if (!u.lanes[route]) {
    u.lanes[route] = { challenged: 0, paid: 0, visits: 0, payers: [], first_seen: null, last_seen: null };
  }
  return u.lanes[route];
}
let usage = loadUsage();
let usageDirty = false;
setInterval(() => {
  if (!usageDirty) return;
  try {
    fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));
    usageDirty = false;
  } catch { /* best-effort */ }
}, 30000);
process.on("SIGTERM", () => {
  try { fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2)); } catch { /* best-effort */ }
});
function payerFromHeader(req) {
  try {
    // x402 v2 sends PAYMENT-SIGNATURE; v1 sends X-Payment. Read both.
    const h = req.headers["payment-signature"] || req.headers["x-payment"];
    if (!h) return null;
    const json = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return json?.payload?.authorization?.from || null;
  } catch {
    return null;
  }
}
// Traffic history for the dashboard graph: snapshot the totals at most
// every 15 minutes (piggybacked on real traffic, so idle stretches just
// show gaps). Capped at 672 snapshots (~7 days). The graph starts sparse
// and fills in — honest from the first knock.
const HISTORY_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_MAX = 672;
function snapshotTraffic() {
  const s = trafficSummary().totals;
  const now = new Date().toISOString();
  usage.history = usage.history || [];
  const last = usage.history[usage.history.length - 1];
  if (last && new Date(now) - new Date(last.t) < HISTORY_INTERVAL_MS) return;
  usage.history.push({
    t: now,
    challenged: s.challenged,
    paid: s.paid_crossings,
    discovery: s.discovery_views,
    directory: s.directory_visits,
    payers: s.unique_payers,
  });
  while (usage.history.length > HISTORY_MAX) usage.history.shift();
  usageDirty = true;
}
app.use((req, res, next) => {
  if (!TRACKED_ROUTES[req.path]) return next();
  res.on("finish", () => {
    const st = laneStats(usage, req.path);
    const now = new Date().toISOString();
    if (!st.first_seen) st.first_seen = now;
    st.last_seen = now;
    if (res.statusCode === 402) {
      st.challenged += 1;
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      if (LANES[req.path]) {
        st.paid += 1; // past the toll collector on a tolled lane = paid crossing
        const payer = payerFromHeader(req);
        if (payer && !st.payers.includes(payer)) st.payers.push(payer);
      } else {
        st.visits += 1; // free routes: /tools directory browses
      }
    }
    usageDirty = true;
    snapshotTraffic();
  });
  next();
});

function loadFeed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "feed.json"), "utf8"));
  } catch {
    return { generated_at: null, bounties: [], fresh: [], deadlines: [], sweepstakes: [], count: {} };
  }
}

// TrollBridge marketplace registry: third-party tools listed on the bridge.
// Curated by the keeper; developers apply via POST /tools/apply.
function loadTools() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "tools.json"), "utf8"));
  } catch {
    return { marketplace: "TrollBridge", updated_at: null, listing_terms: {}, tools: [] };
  }
}

// Bazaar discovery metadata for the CDP catalog: every lane declares its
// input schema (?limit=N) and an output example so agents can construct a
// valid call before paying. Served inside the 402's extensions.bazaar block.
function discoveryFor(route, exampleItem) {
  return {
    ...declareDiscoveryExtension({
      input: { limit: 20 },
      inputSchema: {
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Max items to return. Omit for the full feed.",
          },
        },
        required: [],
      },
      output: {
        example: {
          generated_at: "2026-09-28T16:00:00.000Z",
          lane: route,
          description: LANES[route],
          count: 1,
          items: [exampleItem],
        },
      },
    }),
  };
}
// Same, but for lanes with their own query params (no ?limit).
// `input` must satisfy the schema's required props — the bazaar extension
// validates the example input against inputSchema.
function discoveryForParams(route, inputSchema, required, exampleInput, exampleItem) {
  return {
    ...declareDiscoveryExtension({
      input: exampleInput,
      inputSchema: { properties: inputSchema, required },
      output: {
        example: {
          lane: route,
          description: LANES[route],
          ...exampleItem,
        },
      },
    }),
  };
}
const ADDRESS_SCHEMA = {
  address: { type: "string", description: "Wallet address to inspect (0x… on Base, base58 on Solana)." },
  network: { type: "string", enum: ["base", "solana"], description: "Which chain the address lives on." },
};
const MINT_SCHEMA = {
  mint: { type: "string", description: "Token mint / contract address to scan (0x… on Base, base58 on Solana). Alias: address." },
  network: { type: "string", enum: ["base", "solana"], description: "Which chain the token lives on." },
};
const MARKETS_SCHEMA = {
  q: { type: "string", description: "Search terms for prediction markets (e.g. bitcoin, election, fed)." },
  limit: { type: "integer", minimum: 1, maximum: 25, description: "Max events to return (default 10)." },
};
const SEARCH_SCHEMA = {
  q: { type: "string", description: "Web search query." },
};
const YIELDS_SCHEMA = {
  limit: { type: "integer", minimum: 1, maximum: 25, description: "Max pools to return (default 10)." },
  stablecoinOnly: { type: "boolean", description: "Only stablecoin pools (default true)." },
};
const NEWPAIRS_SCHEMA = {
  limit: { type: "integer", minimum: 1, maximum: 25, description: "Max pairs to return (default 10)." },
  chain: { type: "string", description: "Optional chain filter (e.g. solana, ethereum, base)." },
};
function discoveryExtensionFor(route) {
  if (route === "/markets") return discoveryForParams(route, MARKETS_SCHEMA, ["q"], { q: "bitcoin", limit: 5 }, LANE_EXAMPLES[route]);
  if (route === "/search") return discoveryForParams(route, SEARCH_SCHEMA, ["q"], { q: "solana price" }, LANE_EXAMPLES[route]);
  if (route === "/yields") return discoveryForParams(route, YIELDS_SCHEMA, [], { limit: 10 }, LANE_EXAMPLES[route]);
  if (route === "/new-pairs") return discoveryForParams(route, NEWPAIRS_SCHEMA, [], { limit: 10 }, LANE_EXAMPLES[route]);
  if (route === "/gas") return discoveryForParams(route, {}, [], {}, LANE_EXAMPLES[route]);
  if (route === "/enrich") return discoveryForParams(route, ADDRESS_SCHEMA, ["address", "network"], { address: "0x8BE8D056d5F0bEF850eC9ed5C4a8d647cBE896C0", network: "base" }, LANE_EXAMPLES[route]);
  if (route === "/token-check") return discoveryForParams(route, MINT_SCHEMA, ["mint", "network"], { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", network: "solana" }, LANE_EXAMPLES[route]);
  if (route === "/prices") return discoveryForParams(route, {}, [], {}, LANE_EXAMPLES[route]);
  return discoveryFor(route, LANE_EXAMPLES[route]);
}

// The tolls: bounty-intel lanes cost $0.02 USDC; trader-intel lanes cost
// $0.02–$0.05. Every lane takes both rails (Base or Solana).
const LANES = {
  "/bounties": "Every open bounty across all boards — aibtc, Taskmarket, Superteam Earn.",
  "/fresh": "Bounties posted in the last 24h. First come, first served.",
  "/verdicts": "Recently paid bounties — proof these boards actually pay, with amounts and payout proof.",
  "/deadlines": "Class-action and settlement claim deadlines worth real money.",
  "/sweepstakes": "Free-to-enter sweepstakes with real prizes, verified live.",
  "/prices": "Agent-ready crypto price feed — spot prices for majors plus Base/Solana staples, no API key needed.",
  "/enrich": "Wallet and address intelligence — balances, holdings, heuristic risk flags on Base or Solana.",
  "/token-check": "Token safety scan — liquidity, volume, holder concentration, and a plain-English rug verdict.",
  "/markets": "Prediction-market intel — live Polymarket odds, prices, and volume, agent-ready JSON.",
  "/search": "Web search for agents — titles, URLs, and snippets as clean JSON, no API key needed.",
  "/yields": "DeFi yield intel — best stablecoin yields right now from DeFiLlama, sorted by APY, agent-ready JSON.",
  "/new-pairs": "New token listings — the newest DexScreener pairs with live liquidity, volume, and thin-liquidity flags.",
  "/gas": "Live gas prices per chain — Base, Ethereum, and Solana from public RPCs, with speed tiers where derivable.",
};
// Per-lane tolls. Anything not listed here costs PRICE (default $0.02).
const LANE_PRICES = {
  "/enrich": "$0.05",
  "/token-check": "$0.05",
  "/markets": "$0.05",
  "/search": "$0.05",
  "/yields": "$0.05",
  "/new-pairs": "$0.05",
};
const lanePrice = (route) => LANE_PRICES[route] || PRICE;
const LANE_TAGS = {
  "/bounties": ["bounty-intel", "ai-agents", "crypto"],
  "/fresh": ["bounty-intel", "ai-agents", "crypto"],
  "/verdicts": ["bounty-intel", "ai-agents", "payout-proof"],
  "/deadlines": ["bounty-intel", "class-actions", "settlements"],
  "/sweepstakes": ["bounty-intel", "sweepstakes", "free-to-enter"],
  "/prices": ["trader-intel", "prices", "crypto", "defi"],
  "/enrich": ["trader-intel", "wallet-intel", "risk", "crypto"],
  "/token-check": ["trader-intel", "token-safety", "rug-check", "defi"],
  "/markets": ["market-intel", "prediction-markets", "polymarket", "odds"],
  "/search": ["web-intel", "search", "research"],
  "/yields": ["defi-intel", "yields", "stablecoin", "apy", "defi"],
  "/new-pairs": ["defi-intel", "new-listings", "dex", "tokens"],
  "/gas": ["defi-intel", "gas", "fees", "chains"],
};
const LANE_EXAMPLES = {
  "/bounties": { id: "aibtc-example", title: "Example bounty", reward: "10000 sats", board: "aibtc" },
  "/fresh": { id: "taskmarket-example", title: "Example fresh bounty", reward_usdc: 2, board: "taskmarket" },
  "/verdicts": { id: "aibtc-example", title: "Example paid bounty", paid_amount: "10000 sats", payout_proof: "txid:..." },
  "/deadlines": { title: "Example settlement deadline", claim_deadline: "2027-02-10", est_payout: "$25-$50" },
  "/sweepstakes": { title: "Example sweepstakes", prize: "$25,000", entries: "daily" },
  "/prices": { symbol: "BTC", name: "Bitcoin", price_usd: 123456.78, change_24h_pct: 1.23, source: "coingecko" },
  "/enrich": { network: "base", address: "0x...", address_type: "externally-owned-account", native_balance_eth: 1.5, risk_flags: [] },
  "/token-check": { network: "solana", mint: "...", verdict: "caution", risk_score: 55, reasons: ["thin liquidity"] },
  "/markets": { query: "bitcoin", count: 3, events: [{ title: "Example market", outcomes: [{ question: "Will…?", prices: [{ outcome: "Yes", price: 0.65 }] }] }] },
  "/search": { query: "example query", count: 10, results: [{ title: "Example result", url: "https://example.com", snippet: "…" }] },
  "/yields": { count: 10, stablecoin_only: true, pools: [{ chain: "Ethereum", project: "curve-dex", symbol: "USDC", apy_pct: 8.42, tvl_usd: 5000000 }] },
  "/new-pairs": { count: 10, pairs: [{ chain: "solana", dex: "raydium", base_token: { symbol: "EXAMPLE", name: "Example" }, price_usd: 0.001, liquidity_usd: 25000, flags: [] }] },
  "/gas": { chains: { base: { status: "live", gas_price_gwei: 0.006 }, ethereum: { status: "live", gas_price_gwei: 9.6 }, solana: { status: "live", median_prioritization_fee_microlamports_per_cu: 0 } } },
};
const tollConfig = {};
for (const route of Object.keys(LANES)) {
  const price = lanePrice(route);
  tollConfig[`GET ${route}`] = {
    accepts: [
      { scheme: "exact", price, network: NETWORK, payTo: PAY_TO },
      { scheme: "exact", price, network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
    ],
    description: `${LANES[route]} Toll: ${price} USDC on Base or Solana.`,
    mimeType: "application/json",
    serviceName: "TrollBridge",
    tags: LANE_TAGS[route],
    extensions: discoveryExtensionFor(route),
  };
}
app.use(paymentMiddleware(tollConfig, server));

// Routes the traffic ledger watches: the tolled lanes, the free directory,
// and the free discovery surfaces (landing page, skill card, x402 manifest,
// OpenAPI) — so the troll sees every looker, not just toll payers.
const DISCOVERY_ROUTES = {
  "/": "Bridge landing page.",
  "/skill.md": "Agent skill card.",
  "/.well-known/x402": "x402 payment manifest.",
  "/openapi.json": "OpenAPI description.",
};
const TRACKED_ROUTES = {
  ...LANES,
  "/tools": "Free directory of third-party tools on the bridge.",
  ...DISCOVERY_ROUTES,
};

// Free sample: the troll lets you peek at the bridge before paying.
app.get("/", (req, res) => {
  const feed = loadFeed();
  const registry = loadTools();
  const liveTools = registry.tools.filter((t) => t.status === "live");
  const pricesDoc = trader.loadPrices();
  const laneBlurb = (route, desc) => {
    const toll = lanePrice(route);
    if (route === "/prices") return `${desc} (${pricesDoc.prices.length} assets, refreshed ${pricesDoc.generated_at || "soon"}) — ${toll} USDC`;
    if (route === "/enrich" || route === "/token-check" || route === "/markets" || route === "/search" || route === "/yields" || route === "/new-pairs" || route === "/gas") return `${desc} On-demand lookup — ${toll} USDC`;
    const n = (feed.count && feed.count[route.slice(1)]) || 0;
    return `${desc} (open items: ${n}) — ${toll} USDC`;
  };
  res.json({
    bridge: "TrollBridge",
    keeper: "Mini, data-bounty hunter",
    deal: `An AI-tool marketplace on a toll bridge. Thirteen tolled lanes on Base or Solana — five bounty-intel lanes at ${PRICE} USDC each, trader intel (/prices at ${PRICE}; /enrich and /token-check at $0.05), market intel (/markets and /search at $0.05), and DeFi intel (/yields and /new-pairs at $0.05; /gas at ${PRICE}) — plus a directory of third-party tools. Pay the troll, cross the bridge.`,
    lanes: Object.fromEntries(
      Object.entries(LANES).map(([route, desc]) => [`GET ${route}`, laneBlurb(route, desc)])
    ),
    marketplace: {
      tools_live: liveTools.length,
      browse_free: "GET /tools — the directory is always free. You only pay a tool's own toll when you call it.",
      list_yours: "POST /tools/apply — developers list their x402-tolled tools here. First 10 third-party listings are FREE (founding tools).",
      terms: registry.listing_terms,
    },
    network: NETWORK + (IS_MAINNET ? " (MAINNET — real money)" : " (testnet — proving the flow)"),
    payTo: PAY_TO,
    feed_generated_at: feed.generated_at,
    how_to_pay: "Request any lane. You'll get HTTP 402 with payment instructions; retry with the X-Payment header. See https://github.com/coinbase/x402",
  });
});

function trafficSummary() {
  const lanes = {};
  let totalChallenged = 0, totalPaid = 0, totalDirVisits = 0, totalDiscovery = 0;
  const allPayers = new Set();
  for (const [route, st] of Object.entries(usage.lanes)) {
    lanes[route] = {
      challenged: st.challenged,
      paid: st.paid,
      visits: st.visits || 0,
      unique_payers: st.payers.length,
      first_seen: st.first_seen,
      last_seen: st.last_seen,
    };
    totalChallenged += st.challenged;
    totalPaid += st.paid;
    if (route === "/tools") totalDirVisits += st.visits || 0;
    else if (DISCOVERY_ROUTES[route]) totalDiscovery += st.visits || 0;
    st.payers.forEach((p) => allPayers.add(p));
  }
  return {
    since: usage.started_at,
    totals: {
      challenged: totalChallenged,
      paid_crossings: totalPaid,
      directory_visits: totalDirVisits,
      discovery_views: totalDiscovery,
      unique_payers: allPayers.size,
    },
    lanes,
  };
}

app.get("/health", (req, res) => {
  const registry = loadTools();
  res.json({
    status: "ok",
    troll: "awake",
    lanes: Object.keys(LANES).length,
    marketplace: "TrollBridge",
    tools_listed: registry.tools.filter((t) => t.status === "live").length,
    traffic: trafficSummary().totals,
  });
});

// The troll's own dashboard: who came to the bridge, who paid to cross.
// Free to read — counters only, no secrets. Payer addresses are public
// on-chain data; the chain itself is the money record.
app.get("/traffic", (req, res) => {
  const full = trafficSummary();
  full.payers = Object.fromEntries(
    Object.entries(usage.lanes).map(([route, st]) => [route, st.payers])
  );
  full.history = usage.history || [];
  res.json(full);
});

// The troll's tally, drawn pretty: a live visual dashboard of bridge traffic.
// Untracked (like /traffic) so the troll's own lookers don't pollute the count.
app.get("/dashboard", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrollBridge Traffic — the troll's tally</title>
<style>
body{background:#0d0f14;color:#e8ecf4;font-family:-apple-system,system-ui,"Segoe UI",sans-serif;margin:0;padding:20px;max-width:960px;margin-left:auto;margin-right:auto}
h1{font-size:1.6rem;margin:0.2em 0}
.sub{color:#8b93a7;margin:0 0 1.2em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:1.6em}
.card{background:#161a23;border:1px solid #232a3a;border-radius:12px;padding:14px}
.num{font-size:2rem;font-weight:700}
.lbl{color:#8b93a7;font-size:0.85rem;margin-top:4px}
.green{color:#3ddc84}.amber{color:#f5a623}.blue{color:#5aa9ff}.gray{color:#e8ecf4}
h2{font-size:1.1rem;color:#8b93a7;text-transform:uppercase;letter-spacing:0.08em;margin:1.6em 0 0.6em}
canvas{width:100%;background:#11141c;border:1px solid #232a3a;border-radius:12px}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:#8b93a7;font-size:0.85rem;margin:0.6em 0}
.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
.foot{color:#5c6478;font-size:0.8rem;margin-top:2em}
.empty{color:#5c6478;padding:60px 0;text-align:center}
</style></head><body>
<h1>🌉 TrollBridge Traffic</h1>
<p class="sub">Every knock on the bridge, counted honest. <span id="since"></span></p>
<div class="cards">
<div class="card"><div class="num gray" id="c-challenged">–</div><div class="lbl">Toll knocks (402s)</div></div>
<div class="card"><div class="num green" id="c-paid">–</div><div class="lbl">Paid crossings</div></div>
<div class="card"><div class="num blue" id="c-discovery">–</div><div class="lbl">Discovery views</div></div>
<div class="card"><div class="num amber" id="c-payers">–</div><div class="lbl">Unique payers</div></div>
</div>
<h2>Per lane</h2>
<div class="legend"><span><span class="dot" style="background:#f5a623"></span>knocks</span><span><span class="dot" style="background:#3ddc84"></span>paid</span><span><span class="dot" style="background:#5aa9ff"></span>views</span></div>
<canvas id="lanes" height="300"></canvas>
<h2>Over time</h2>
<div class="legend"><span><span class="dot" style="background:#f5a623"></span>knocks</span><span><span class="dot" style="background:#3ddc84"></span>paid</span><span><span class="dot" style="background:#5aa9ff"></span>discovery + directory</span></div>
<canvas id="trend" height="300"></canvas>
<div class="empty" id="trend-empty" style="display:none">Gathering data — the graph fills in as traffic arrives.</div>
<p class="foot">Auto-refreshes every 60s · The chain is the money record — this is just the troll's tally.</p>
<script>
var C = {knock:"#f5a623", paid:"#3ddc84", view:"#5aa9ff", grid:"#232a3a", text:"#8b93a7"};
function fit(cv){var r=cv.getBoundingClientRect(),d=window.devicePixelRatio||1;cv.width=r.width*d;cv.height=300*d;var x=cv.getContext("2d");x.setTransform(d,0,0,d,0,0);return [x,r.width,300];}
function short(r){return r.replace(/^\\//,"")||"home";}
function drawBars(lanes){
  var cv=document.getElementById("lanes"),f=fit(cv),x=f[0],W=f[1],H=f[2];
  var routes=Object.keys(lanes);if(!routes.length)return;
  var pad={l:36,r:10,t:14,b:34},iw=W-pad.l-pad.r,ih=H-pad.t-pad.b;
  var max=1;routes.forEach(function(r){var s=lanes[r];max=Math.max(max,s.challenged,s.paid,s.visits||0);});
  var gw=iw/routes.length,bw=Math.min(26,(gw-16)/3);
  routes.forEach(function(r,i){
    var s=lanes[r],cx=pad.l+gw*i+gw/2;
    var bars=[[s.challenged,C.knock],[s.paid,C.paid],[s.visits||0,C.view]];
    bars.forEach(function(b,j){
      var v=b[0];if(!v)return;var h=ih*v/max,bx=cx-(bars.length*bw)/2+j*bw;
      x.fillStyle=b[1];x.fillRect(bx,pad.t+ih-h,bw-3,h);
      x.fillStyle="#e8ecf4";x.font="11px system-ui";x.textAlign="center";x.fillText(v,bx+(bw-3)/2,pad.t+ih-h-5);
    });
    x.fillStyle=C.text;x.font="11px system-ui";x.textAlign="center";x.fillText(short(r),cx,H-12);
  });
  x.strokeStyle=C.grid;x.beginPath();x.moveTo(pad.l,pad.t+ih);x.lineTo(W-pad.r,pad.t+ih);x.stroke();
}
function drawTrend(hist){
  var cv=document.getElementById("trend"),empty=document.getElementById("trend-empty");
  if(!hist||hist.length<2){cv.style.display="none";empty.style.display="block";return;}
  cv.style.display="block";empty.style.display="none";
  var f=fit(cv),x=f[0],W=f[1],H=f[2],pad={l:36,r:10,t:14,b:34},iw=W-pad.l-pad.r,ih=H-pad.t-pad.b;
  var series=[["challenged",C.knock],["paid",C.paid],["disc",C.view]];
  var max=1;hist.forEach(function(p){max=Math.max(max,p.challenged,p.paid,p.discovery+p.directory);});
  var t0=new Date(hist[0].t).getTime(),t1=new Date(hist[hist.length-1].t).getTime()||t0+1;
  series.forEach(function(s){
    x.strokeStyle=s[1];x.lineWidth=2;x.beginPath();
    hist.forEach(function(p,i){
      var v=s[0]==="disc"?p.discovery+p.directory:p[s[0]];
      var px=pad.l+iw*(new Date(p.t).getTime()-t0)/(t1-t0),py=pad.t+ih-ih*v/max;
      if(i===0)x.moveTo(px,py);else x.lineTo(px,py);
    });
    x.stroke();
  });
  x.strokeStyle=C.grid;x.beginPath();x.moveTo(pad.l,pad.t+ih);x.lineTo(W-pad.r,pad.t+ih);x.stroke();
  x.fillStyle=C.text;x.font="11px system-ui";x.textAlign="left";
  x.fillText(new Date(hist[0].t).toLocaleString(),pad.l,H-12);
  x.textAlign="right";x.fillText(new Date(hist[hist.length-1].t).toLocaleString(),W-pad.r,H-12);
}
function load(){
  fetch("/traffic").then(function(r){return r.json();}).then(function(d){
    document.getElementById("c-challenged").textContent=d.totals.challenged;
    document.getElementById("c-paid").textContent=d.totals.paid_crossings;
    document.getElementById("c-discovery").textContent=d.totals.discovery_views+d.totals.directory_visits;
    document.getElementById("c-payers").textContent=d.totals.unique_payers;
    document.getElementById("since").textContent="Counting since "+new Date(d.since).toLocaleString()+".";
    drawBars(d.lanes);drawTrend(d.history);
  });
}
load();setInterval(load,60000);window.addEventListener("resize",load);
</script></body></html>`);
});

// ---- TrollBridge marketplace: free directory, paid listings ----

// The directory is always free — you toll the crossing, not the map.
app.get("/tools", (req, res) => {
  const registry = loadTools();
  res.json({
    marketplace: "TrollBridge",
    updated_at: registry.updated_at,
    listing_terms: registry.listing_terms,
    tools: registry.tools,
  });
});

// Developer application intake. Validates the payload and returns a
// pre-filled GitHub issue URL — one click files the application durably,
// since the bridge keeps no database (the keeper curates listings by hand).
app.post("/tools/apply", (req, res) => {
  const b = req.body || {};
  const required = ["name", "developer", "description", "endpoint", "price", "pay_to"];
  const missing = required.filter((k) => typeof b[k] !== "string" || !b[k].trim());
  if (missing.length) {
    return res.status(400).json({
      status: "rejected",
      reason: `missing fields: ${missing.join(", ")}`,
      required,
      example: {
        name: "My Tool",
        developer: "your-handle",
        description: "What it does, in one honest sentence.",
        endpoint: "https://your-tool.example.com/call",
        method: "GET (optional, default GET)",
        price: "$0.05 (your own x402 toll, USDC on Base)",
        pay_to: "0xYourWallet...",
        category: "data (optional)",
        contact: "where to reach you (optional)",
      },
    });
  }
  let endpointOk = false;
  try {
    const u = new URL(b.endpoint);
    endpointOk = u.protocol === "https:";
  } catch { /* invalid */ }
  if (!endpointOk) {
    return res.status(400).json({ status: "rejected", reason: "endpoint must be a valid https:// URL" });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(b.pay_to.trim())) {
    return res.status(400).json({ status: "rejected", reason: "pay_to must be a valid EVM wallet address (0x + 40 hex chars)" });
  }
  const appId = `tb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const issueTitle = `[tool-listing] ${b.name} by ${b.developer}`;
  const issueBody = [
    `Application: ${appId}`,
    ``,
    `**Tool:** ${b.name}`,
    `**Developer:** ${b.developer}`,
    `**Description:** ${b.description}`,
    `**Endpoint:** ${b.endpoint}`,
    `**Method:** ${(b.method || "GET").toUpperCase()}`,
    `**Price:** ${b.price}`,
    `**Pay to:** ${b.pay_to}`,
    `**Category:** ${b.category || "general"}`,
    `**Contact:** ${b.contact || "n/a"}`,
  ].join("\n");
  const issueUrl =
    "https://github.com/eric-tijerina/mini-tollbooth/issues/new?title=" +
    encodeURIComponent(issueTitle) +
    "&body=" +
    encodeURIComponent(issueBody);
  // Best-effort local log for the keeper (ephemeral on free-tier hosting;
  // the GitHub issue is the durable record).
  try {
    fs.appendFileSync(
      path.join(__dirname, "data", "applications.jsonl"),
      JSON.stringify({ application_id: appId, received_at: new Date().toISOString(), ...b }) + "\n"
    );
  } catch { /* log is best-effort */ }
  res.json({
    status: "received",
    application_id: appId,
    next_step: "Open the issue URL below to file your application — one click, pre-filled. The keeper reviews every application; junk gets delisted.",
    issue_url: issueUrl,
    listing_terms: loadTools().listing_terms,
  });
});

function lane(route, key) {
  app.get(route, (req, res) => {
    const feed = loadFeed();
    let items = feed[key] || [];
    // Honest input schema for indexers: ?limit=N caps the items returned.
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit)) {
      items = items.slice(0, Math.max(1, Math.min(200, limit)));
    }
    res.json({
      generated_at: feed.generated_at,
      lane: route,
      description: LANES[route],
      count: items.length,
      items,
      board_errors: feed.board_errors || [],
    });
  });
}
lane("/bounties", "bounties");
lane("/fresh", "fresh");
lane("/verdicts", "verdicts");
lane("/deadlines", "deadlines");
lane("/sweepstakes", "sweepstakes");

// ---- Trader-intel lanes (for agents with funded wallets) ----
// All pay-or-nothing like the bounty lanes: the toll middleware above
// challenges first; these handlers only run on a paid crossing.

// GET /prices — cached spot prices, refreshed every 6h by build-feed.js.
app.get("/prices", (req, res) => {
  const doc = trader.loadPrices();
  res.json({
    generated_at: doc.generated_at,
    lane: "/prices",
    description: LANES["/prices"],
    refresh: doc.refresh || "every 6h",
    sources: doc.sources || null,
    count: doc.prices.length,
    prices: doc.prices,
    errors: doc.errors || [],
  });
});

// GET /enrich?address=0x…&network=base|solana — wallet intelligence.
app.get("/enrich", async (req, res) => {
  try {
    const out = await trader.enrichAddress(req.query.address, req.query.network);
    res.json({ lane: "/enrich", description: LANES["/enrich"], ...out });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, usage: "GET /enrich?address=<wallet>&network=base|solana" });
    console.error("route error GET /enrich:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// GET /token-check?mint=…&network=base|solana — token safety scan.
app.get("/token-check", async (req, res) => {
  try {
    const mint = req.query.mint || req.query.address;
    const out = await trader.checkToken(mint, req.query.network);
    res.json({ lane: "/token-check", description: LANES["/token-check"], ...out });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, usage: "GET /token-check?mint=<token>&network=base|solana" });
    console.error("route error GET /token-check:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// ---- Market-intel lanes (for agents with funded wallets) ----
// Same pay-or-nothing deal: the toll middleware challenges first; these
// handlers only run on a paid crossing.

// GET /markets?q=bitcoin&limit=10 — prediction-market odds from Polymarket's free API.
app.get("/markets", async (req, res) => {
  try {
    const out = await intel.searchMarkets(req.query.q, req.query.limit);
    res.json({ lane: "/markets", description: LANES["/markets"], ...out });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, usage: "GET /markets?q=<search terms>&limit=1-25" });
    console.error("route error GET /markets:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// GET /search?q=… — web search for agents (Brave API when BRAVE_API_KEY is set, else DuckDuckGo).
app.get("/search", async (req, res) => {
  try {
    const out = await intel.webSearch(req.query.q);
    res.json({ lane: "/search", description: LANES["/search"], ...out });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, usage: "GET /search?q=<query>" });
    console.error("route error GET /search:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// ---- DeFi-intel lanes (for agents with funded wallets) ----
// Same pay-or-nothing deal: the toll middleware challenges first; these
// handlers only run on a paid crossing.

// GET /yields?limit=10&stablecoinOnly=true — best stablecoin yields from DeFiLlama's free API.
app.get("/yields", async (req, res) => {
  try {
    const out = await defi.topYields(req.query.limit, req.query.stablecoinOnly);
    res.json({ lane: "/yields", description: LANES["/yields"], ...out });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, usage: "GET /yields?limit=1-25&stablecoinOnly=true|false" });
    console.error("route error GET /yields:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// GET /new-pairs?limit=10&chain=solana — newest DexScreener listings with live pair data + thin-liquidity flags.
app.get("/new-pairs", async (req, res) => {
  try {
    const out = await defi.newPairs(req.query.limit, req.query.chain);
    res.json({ lane: "/new-pairs", description: LANES["/new-pairs"], ...out });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message, usage: "GET /new-pairs?limit=1-25&chain=solana|ethereum|base" });
    console.error("route error GET /new-pairs:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// GET /gas — live gas prices per chain from public RPCs.
app.get("/gas", async (req, res) => {
  try {
    const out = await defi.gasPrices();
    res.json({ lane: "/gas", description: LANES["/gas"], ...out });
  } catch (e) {
    console.error("route error GET /gas:", e.message);
    res.status(502).json({ error: "upstream data source unreachable — try again shortly" });
  }
});

// Build at boot, then keep the feed fresh while awake.
build()
  .catch((e) => console.error("boot feed build failed:", e.message))
  .finally(() => {
    setInterval(() => build().catch((e) => console.error("refresh failed:", e.message)), REFRESH_MS);
    // Last resort: log what the default handler swallows.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      console.error(`route error ${req.method} ${req.path}:`, err && err.message);
      if (!res.headersSent) res.status(500).json({ error: "Internal Server Error" });
    });
    app.listen(PORT, () =>
      console.log(`troll awake on :${PORT} | TrollBridge: ${Object.keys(LANES).length} lanes @ $0.02–$0.05 on ${NETWORK} + ${SOLANA_NETWORK} -> ${PAY_TO} / ${SOLANA_PAY_TO}${IS_MAINNET ? " [MAINNET]" : " [testnet]"} | tools: ${loadTools().tools.filter((t) => t.status === "live").length} listed`)
    );
  });
// ---- Agent skill: the human- and agent-readable contract for the bridge.
// Free and unauthenticated by design — indexers (agentic.market et al.)
// point at https://mini-tollbooth.onrender.com/skill.md.
app.get("/skill.md", (req, res) => {
  try {
    const md = fs.readFileSync(path.join(__dirname, "skill.md"), "utf8");
    res.type("text/markdown").send(md);
  } catch {
    res.status(500).json({ error: "skill.md not found" });
  }
});

// ---- x402 discovery manifest: how indexers (x402scan, agent402, 402index)
// find the bridge. Free, unauthenticated, by design.
app.get("/.well-known/x402", (req, res) => {
  const base = "https://mini-tollbooth.onrender.com";
  res.json({
    spec: "trollbridge-manifest/1",
    name: "TrollBridge",
    description:
      "Pay-per-call intel for AI agents. Thirteen tolled lanes: bounty intel (every open bounty across all boards, fresh bounties from the last 24h, recently-paid verdicts proving the boards pay, class-action claim deadlines, verified free sweepstakes) plus trader intel (agent-ready price feed, wallet/address intelligence, token safety scans) plus market intel (live Polymarket prediction-market odds, agent-ready web search) plus DeFi intel (best stablecoin yields, newest token listings with liquidity flags, live gas prices). Bounty lanes and /gas $0.02 USDC per call; /enrich, /token-check, /markets, /search, /yields, and /new-pairs $0.05. Base or Solana.",
    homepage: base,
    payment: {
      protocol: "x402",
      network: "eip155:8453",
      network_name: "Base",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      asset_name: "USDC",
      pay_to: PAY_TO,
      price_usd: "0.02",
    },
    payment_solana: {
      protocol: "x402",
      network: SOLANA_NETWORK,
      network_name: "Solana",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      asset_name: "USDC",
      pay_to: SOLANA_PAY_TO,
      price_usd: "0.02",
    },
    resources: Object.keys(LANES).map((route) => `${base}${route}`),
    lanes: Object.entries(LANES).map(([route, description]) => ({
      url: `${base}${route}`,
      description,
      price_usd: lanePrice(route).replace("$", ""),
    })),
    directory: `${base}/tools`,
    traffic: `${base}/traffic`,
    dashboard: `${base}/dashboard`,
  });
});

// ---- x402scan discovery: OpenAPI is their canonical discovery format.
// GET /openapi.json stays free and unauthenticated by design (it is not
// in the toll config, so the paywall never touches it).
app.get("/openapi.json", (req, res) => {
  const laneParam = {
    name: "limit",
    in: "query",
    required: false,
    description: "Max items to return. Omit for the full feed.",
    schema: { type: "integer", minimum: 1, maximum: 200 },
  };
  const laneSchema = {
    type: "object",
    properties: {
      generated_at: { type: "string", format: "date-time" },
      lane: { type: "string" },
      description: { type: "string" },
      count: { type: "integer" },
      items: { type: "array", items: { type: "object" } },
      board_errors: { type: "array", items: { type: "string" } },
    },
    required: ["generated_at", "lane", "items"],
  };
  const op = (operationId, summary, description, priceUsd, parameters) => ({
    operationId,
    summary,
    description,
    tags: ["toll-lanes"],
    parameters,
    "x-payment-info": {
      price: { mode: "fixed", currency: "USD", amount: Number(priceUsd).toFixed(6) },
      protocols: [{ x402: {} }],
    },
    responses: {
      200: {
        description: "Paid crossing — the lane's data.",
        content: { "application/json": { schema: laneSchema } },
      },
      402: {
        description: `Payment Required — pay $${priceUsd} USDC on Base or Solana via the x402 v2 flow, then retry with the payment in the X-Payment header.`,
      },
    },
  });
  const addressParam = {
    name: "address",
    in: "query",
    required: true,
    description: "Wallet address to inspect (0x… on Base, base58 on Solana).",
    schema: { type: "string" },
  };
  const mintParam = {
    name: "mint",
    in: "query",
    required: true,
    description: "Token mint / contract address to scan (0x… on Base, base58 on Solana).",
    schema: { type: "string" },
  };
  const networkParam = {
    name: "network",
    in: "query",
    required: true,
    description: "Which chain: base or solana.",
    schema: { type: "string", enum: ["base", "solana"] },
  };
  const qParam = (required, description) => ({
    name: "q",
    in: "query",
    required,
    description,
    schema: { type: "string" },
  });
  const routeParams = (route) => {
    if (route === "/enrich") return [addressParam, networkParam];
    if (route === "/token-check") return [mintParam, networkParam];
    if (route === "/prices") return [];
    if (route === "/gas") return [];
    if (route === "/markets") return [qParam(true, "Search terms for prediction markets (e.g. bitcoin, election, fed)."), { name: "limit", in: "query", required: false, description: "Max events to return (1–25, default 10).", schema: { type: "integer", minimum: 1, maximum: 25 } }];
    if (route === "/search") return [qParam(true, "Web search query.")];
    if (route === "/yields") return [
      { name: "limit", in: "query", required: false, description: "Max pools to return (1–25, default 10).", schema: { type: "integer", minimum: 1, maximum: 25 } },
      { name: "stablecoinOnly", in: "query", required: false, description: "Only stablecoin pools (default true).", schema: { type: "boolean" } },
    ];
    if (route === "/new-pairs") return [
      { name: "limit", in: "query", required: false, description: "Max pairs to return (1–25, default 10).", schema: { type: "integer", minimum: 1, maximum: 25 } },
      { name: "chain", in: "query", required: false, description: "Optional chain filter (e.g. solana, ethereum, base).", schema: { type: "string" } },
    ];
    return [laneParam];
  };
  const paths = {};
  for (const [route, description] of Object.entries(LANES)) {
    const id = route.slice(1);
    const priceUsd = lanePrice(route).replace("$", "");
    paths[route] = {
      get: op(
        id,
        `TrollBridge lane: ${id}`,
        `${description} Costs $${priceUsd} USDC per call on Base or Solana.`,
        priceUsd,
        routeParams(route)
      ),
    };
  }
  res.json({
    openapi: "3.1.0",
    info: {
      title: "TrollBridge",
      version: "1.1.0",
      description:
        "Pay-per-call intel for AI agents. Thirteen tolled lanes: bounty intel (bounties, fresh, verdicts, deadlines, sweepstakes) at $0.02 USDC per call, trader intel (/prices at $0.02; /enrich and /token-check at $0.05), market intel (/markets and /search at $0.05), DeFi intel (/yields and /new-pairs at $0.05; /gas at $0.02).",
      "x-guidance":
        "Call any lane with GET. Without payment you receive a 402 challenge (x402 v2) with the exact payment requirements in the response headers and body — the 402 is the source of truth for amounts and payTo addresses. Tolls: $0.02 USDC on the bounty lanes, /prices, and /gas; $0.05 USDC on /enrich, /token-check, /markets, /search, /yields, and /new-pairs. Both rails accepted on every lane: Base (USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) and Solana (USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). Complete the x402 payment and retry with the X-Payment header. Bounty lanes take ?limit=N (1–200). /enrich needs ?address=…&network=base|solana. /token-check needs ?mint=…&network=base|solana. /markets takes ?q=… (required) and ?limit=1–25. /search needs ?q=…. /yields takes ?limit=1–25 and ?stablecoinOnly=true|false. /new-pairs takes ?limit=1–25 and ?chain=solana|ethereum|base. /gas takes no params. The free directory of third-party tools is GET /tools; bridge traffic stats are GET /traffic.",
      contact: { email: "erict4209@gmail.com" },
    },
    paths,
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "X-Payment",
          description:
            "x402 v2 payment: sign the 402 challenge (EIP-3009 authorization on Base, SPL transfer on Solana) and send it in this header.",
        },
      },
    },
    security: [{ x402: [] }],
  });
});
