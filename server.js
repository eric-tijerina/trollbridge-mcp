#!/usr/bin/env node
/**
 * trollbridge-mcp — MCP wrapper for Mini's TrollBridge.
 *
 * TrollBridge (https://mini-tollbooth.onrender.com) is a pay-per-call
 * intel bridge for AI agents. Tolled lanes cost $0.02 or $0.05 USDC per
 * call on Base (eip155:8453) or Solana via the x402 protocol; the free
 * endpoints (/tools, /traffic, /health) cost nothing. Tolls settle to
 * the keeper's Coinbase.
 *
 * This MCP server is a read-only client. It NEVER attempts payment:
 * when a tolled lane answers HTTP 402, the tool returns an honest
 * explanation of the payment challenge plus instructions for completing
 * the x402 v2 flow and retrying. It never claims a payment was made.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BRIDGE_URL =
  process.env.TROLLBRIDGE_URL || "https://mini-tollbooth.onrender.com";

// Payment rails from the live 402 challenge (verified on mainnet).
// The tool result echoes these back; they are also parsed from the live
// 402 response body when present. Tolls go to the keeper's Coinbase.
const RAILS = [
  {
    label: "Base",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetName: "USDC",
    payTo: "0x8BE8D056d5F0bEF850eC9ed5C4a8d647cBE896C0",
  },
  {
    label: "Solana",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    assetName: "USDC",
    payTo: "CDhLHtuj1HnPVDuZVtJxyw5aEpf6ZQxfBTrqAtFcWb2e",
  },
];

const HONEST_PREAMBLE =
  "Mini's TrollBridge: a pay-per-call intel bridge kept by Mini, " +
  "a data-bounty hunter. Tolls go to the keeper's Coinbase (USDC on Base " +
  "or Solana). This MCP server only reads the bridge — it never pays and " +
  "never claims a payment was made.";

async function bridgeGet(path, lane) {
  const url = `${BRIDGE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      text:
        `Could not reach TrollBridge at ${url}: ${err.message}. ` +
        "The bridge runs on a free hosting tier and sleeps after 15 minutes " +
        "of idleness — it may just be waking up. Wait ~30 seconds and retry.",
    };
  }

  if (res.status === 402) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    return { ok: false, kind: "402", text: paywalled(path, bodyText, lane) };
  }

  if (!res.ok) {
    const hint =
      res.status === 404 && path.startsWith("/verdicts")
        ? " The /verdicts lane may not be deployed on the bridge yet."
        : "";
    return {
      ok: false,
      kind: "http",
      text: `TrollBridge returned HTTP ${res.status} for ${path}.${hint} Retry shortly.`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return {
      ok: false,
      kind: "parse",
      text: `TrollBridge returned non-JSON for ${path}: ${err.message}.`,
    };
  }
  return { ok: true, data };
}

function paywalled(path, bodyText, lane) {
  const tollPrice = lane && lane.tollPrice ? lane.tollPrice : "$0.02";
  const tollAtomic = lane && lane.tollAtomic ? lane.tollAtomic : "20000";
  const lines = [
    `${HONEST_PREAMBLE}`,
    "",
    `GET ${path} is a TOLLED lane. The bridge answered HTTP 402 Payment Required.`,
    "No payment was attempted and none was made.",
    "",
    "To cross, pay the toll with the x402 v2 flow:",
    `  - Price:    ${tollPrice} USDC per call (${tollAtomic} atomic units)`,
  ];
  for (const rail of RAILS) {
    lines.push(
      `  - Rail:     ${rail.label} (${rail.network})`,
      `      Asset:  ${rail.asset} (${rail.assetName})`,
      `      Pay to: ${rail.payTo}`
    );
  }
  lines.push(
    "  - Scheme:   exact",
    "",
    "x402 v2 steps: read the 402 challenge (it carries payment requirements),",
    "sign a payment authorization for the exact amount with a funded wallet,",
    "then retry the request with the X-Payment header set (PAYMENT-SIGNATURE) —",
    "the bridge verifies via its facilitator and returns the data with an",
    "X-Payment-Response receipt. Any x402 v2 client library can do this.",
    "",
    "Until you pay, here is the raw 402 challenge body for reference:",
    bodyText ? bodyText.slice(0, 2000) : "(empty body)"
  );
  return lines.join("\n");
}

function asText(result) {
  if (result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  }
  return { content: [{ type: "text", text: result.text }] };
}

function limitQuery(args, min, max, def) {
  if (args && args.limit != null) {
    const limit = Math.max(min, Math.min(max, Math.floor(Number(args.limit) || def)));
    return `?limit=${limit}`;
  }
  return "";
}

const LIMIT_SCHEMA = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Max items to return (1-200). Default 50.",
    },
  },
};

const NO_PARAMS_SCHEMA = { type: "object", properties: {} };

// --- Tolled lanes ---------------------------------------------------------
const TOLLED_LANES = {
  bridge_bounties: {
    path: "/bounties",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — ALL open bounties worth an agent's time (aibtc, Taskmarket, Superteam), refreshed every 6 hours. TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
    inputSchema: LIMIT_SCHEMA,
    buildQuery: (args) => limitQuery(args, 1, 200, 50),
  },
  bridge_fresh: {
    path: "/fresh",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — bounties posted in the last 24 hours. TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
    inputSchema: LIMIT_SCHEMA,
    buildQuery: (args) => limitQuery(args, 1, 200, 50),
  },
  bridge_deadlines: {
    path: "/deadlines",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — upcoming class-action and claim deadlines (money with an expiry date). TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
    inputSchema: LIMIT_SCHEMA,
    buildQuery: (args) => limitQuery(args, 1, 200, 50),
  },
  bridge_sweepstakes: {
    path: "/sweepstakes",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — free-to-enter sweepstakes with real prizes, curated by Mini. TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
    inputSchema: LIMIT_SCHEMA,
    buildQuery: (args) => limitQuery(args, 1, 200, 50),
  },
  bridge_verdicts: {
    path: "/verdicts",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — recently-paid bounties: which bounties actually paid out and how much. TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
    inputSchema: LIMIT_SCHEMA,
    buildQuery: (args) => limitQuery(args, 1, 200, 50),
  },
  bridge_prices: {
    path: "/prices",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — spot crypto prices: BTC, ETH, SOL, USDC. TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. No params.",
    inputSchema: NO_PARAMS_SCHEMA,
  },
  bridge_gas: {
    path: "/gas",
    tollPrice: "$0.02",
    tollAtomic: "20000",
    description:
      "Mini's TrollBridge — live gas prices per chain, for agents about to move money. TOLLED: $0.02 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. No params.",
    inputSchema: NO_PARAMS_SCHEMA,
  },
  bridge_enrich: {
    path: "/enrich",
    tollPrice: "$0.05",
    tollAtomic: "50000",
    description:
      "Mini's TrollBridge — wallet address intel: type, native balance, USDC watchlist, risk flags. TOLLED: $0.05 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Requires address and network.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Wallet address to enrich.",
        },
        network: {
          type: "string",
          enum: ["base", "solana"],
          description: "Which chain the address is on.",
        },
      },
      required: ["address", "network"],
    },
    buildQuery: (args) =>
      `?address=${encodeURIComponent(args.address)}&network=${encodeURIComponent(args.network)}`,
  },
  bridge_token_check: {
    path: "/token-check",
    tollPrice: "$0.05",
    tollAtomic: "50000",
    description:
      "Mini's TrollBridge — token rug scan: liquidity, volume, buys/sells, holder concentration, heuristic 0-100 score plus a plain verdict. TOLLED: $0.05 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Requires mint and network.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token contract address (mint) to scan.",
        },
        network: {
          type: "string",
          enum: ["base", "solana"],
          description: "Which chain the token is on.",
        },
      },
      required: ["mint", "network"],
    },
    buildQuery: (args) =>
      `?mint=${encodeURIComponent(args.mint)}&network=${encodeURIComponent(args.network)}`,
  },
  bridge_markets: {
    path: "/markets",
    tollPrice: "$0.05",
    tollAtomic: "50000",
    description:
      "Mini's TrollBridge — prediction-market intel: live Polymarket odds, prices, and volume, agent-ready JSON. TOLLED: $0.05 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Requires q; optional limit 1-25.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Search terms for prediction markets (e.g. bitcoin, election, fed).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Max events to return (1-25). Default 10.",
        },
      },
      required: ["q"],
    },
    buildQuery: (args) => {
      let qs = `?q=${encodeURIComponent(args.q)}`;
      if (args.limit != null) {
        qs += `&limit=${Math.max(1, Math.min(25, Math.floor(Number(args.limit) || 10)))}`;
      }
      return qs;
    },
  },
  bridge_search: {
    path: "/search",
    tollPrice: "$0.05",
    tollAtomic: "50000",
    description:
      "Mini's TrollBridge — web search for agents: title, url, snippet per result, agent-ready JSON. TOLLED: $0.05 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Requires q.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Search query.",
        },
      },
      required: ["q"],
    },
    buildQuery: (args) => `?q=${encodeURIComponent(args.q)}`,
  },
  bridge_yields: {
    path: "/yields",
    tollPrice: "$0.05",
    tollAtomic: "50000",
    description:
      "Mini's TrollBridge — best DeFi yields right now: stablecoin APYs and more, for yield-hunting agents. TOLLED: $0.05 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-50, stablecoinOnly.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max yields to return (1-50). Default 20.",
        },
        stablecoinOnly: {
          type: "boolean",
          description: "Only stablecoin pools. Default false.",
        },
      },
    },
    buildQuery: (args) => {
      const params = [];
      if (args.limit != null) {
        params.push(`limit=${Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)))}`);
      }
      if (args.stablecoinOnly) {
        params.push("stablecoinOnly=true");
      }
      return params.length ? `?${params.join("&")}` : "";
    },
  },
  bridge_new_pairs: {
    path: "/new-pairs",
    tollPrice: "$0.05",
    tollAtomic: "50000",
    description:
      "Mini's TrollBridge — newest token listings with rug scores attached, for check-then-ape sniping. TOLLED: $0.05 USDC per call on Base or Solana via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-50, chain.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max pairs to return (1-50). Default 20.",
        },
        chain: {
          type: "string",
          description: "Chain filter, e.g. base or solana.",
        },
      },
    },
    buildQuery: (args) => {
      const params = [];
      if (args.limit != null) {
        params.push(`limit=${Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 20)))}`);
      }
      if (args.chain) {
        params.push(`chain=${encodeURIComponent(args.chain)}`);
      }
      return params.length ? `?${params.join("&")}` : "";
    },
  },
};

// --- Free endpoints -------------------------------------------------------
const FREE_ENDPOINTS = {
  bridge_tools: {
    path: "/tools",
    description:
      "Mini's TrollBridge — FREE directory of third-party AI tools listed on the TrollBridge marketplace (developers list tools, agents pay per use). No toll.",
  },
  bridge_traffic: {
    path: "/traffic",
    description:
      "Mini's TrollBridge — FREE bridge statistics: per-lane toll challenges (lookers) vs paid crossings (agents through), unique payer wallets, first/last seen. Honest day-one ledger: traffic is small and growing; this tool reports exactly what the bridge has seen, nothing more.",
  },
  bridge_health: {
    path: "/health",
    description:
      "Mini's TrollBridge — FREE health check: is the bridge awake, how many lanes, marketplace status. No toll.",
  },
};

const server = new Server(
  { name: "trollbridge-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

const ALL_TOOLS = { ...TOLLED_LANES, ...FREE_ENDPOINTS };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(ALL_TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema || { type: "object", properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = ALL_TOOLS[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);

  // Local validation first — missing required params never reach the
  // bridge, so no toll is owed for this error.
  const required = (def.inputSchema && def.inputSchema.required) || [];
  const missing = required.filter(
    (k) => !args || args[k] == null || args[k] === ""
  );
  if (missing.length) {
    return asText({
      ok: false,
      kind: "args",
      text:
        `Tool ${name} requires: ${missing.join(", ")}. ` +
        "Provide them and retry — this validation happens locally, " +
        "so no toll was charged and none is owed.",
    });
  }

  let path = def.path;
  if (def.buildQuery) {
    path += def.buildQuery(args || {});
  }

  const result = await bridgeGet(path, TOLLED_LANES[name] ? def : null);
  return asText(result);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("trollbridge-mcp fatal:", err);
  process.exit(1);
});
