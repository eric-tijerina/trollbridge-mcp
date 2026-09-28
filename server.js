#!/usr/bin/env node
/**
 * trollbridge-mcp — MCP wrapper for Mini's TrollBridge.
 *
 * TrollBridge (https://mini-tollbooth.onrender.com) is a pay-per-call
 * bounty-intel bridge for AI agents. Tolled lanes cost $0.02 USDC per call
 * on Base (eip155:8453) via the x402 protocol; the free endpoints (/tools,
 * /traffic, /health) cost nothing.
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

// Payment constants from the live 402 challenge (verified on mainnet).
// The tool result echoes these back; they are also parsed from the live
// 402 response body when present.
const TOLL = {
  price: "$0.02 USDC per call",
  amountAtomic: "20000",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x9412222D7801906B4179E58E44B8Dbf16426Bea2",
  scheme: "exact",
};

const HONEST_PREAMBLE =
  "Mini's TrollBridge: a pay-per-call bounty-intel bridge kept by Mini, " +
  "a data-bounty hunter. Tolls go to Mini's $1-bet wallet on Base. " +
  "This MCP server only reads the bridge — it never pays and never " +
  "claims a payment was made.";

async function bridgeGet(path) {
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
    return { ok: false, kind: "402", text: paywalled(path, bodyText) };
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

function paywalled(path, bodyText) {
  const lines = [
    `${HONEST_PREAMBLE}`,
    "",
    `GET ${path} is a TOLLED lane. The bridge answered HTTP 402 Payment Required.`,
    "No payment was attempted and none was made.",
    "",
    "To cross, pay the toll with the x402 v2 flow:",
    `  - Price:    ${TOLL.price} (${TOLL.amountAtomic} atomic units)`,
    `  - Network:  ${TOLL.network} (Base)`,
    `  - Asset:    ${TOLL.asset} (USDC)`,
    `  - Pay to:   ${TOLL.payTo}`,
    `  - Scheme:   ${TOLL.scheme}`,
    "",
    "x402 v2 steps: read the 402 challenge (it carries payment requirements),",
    "sign a payment authorization for the exact amount with a funded Base wallet,",
    "then retry the request with the X-Payment header set (PAYMENT-SIGNATURE) —",
    "the bridge verifies via its facilitator and returns the data with an",
    "X-Payment-Response receipt. Any x402 v2 client library can do this.",
    "",
    "Until you pay, here is the raw 402 challenge body for reference:",
    bodyText ? bodyText.slice(0, 2000) : "(empty body)",
  ];
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

const TOLLED_LANES = {
  bridge_bounties: {
    path: "/bounties",
    description:
      "Mini's TrollBridge — ALL open bounties worth an agent's time (aibtc, Taskmarket, Superteam), refreshed every 6 hours. TOLLED: $0.02 USDC per call on Base via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
  },
  bridge_fresh: {
    path: "/fresh",
    description:
      "Mini's TrollBridge — bounties posted in the last 24 hours. TOLLED: $0.02 USDC per call on Base via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
  },
  bridge_deadlines: {
    path: "/deadlines",
    description:
      "Mini's TrollBridge — upcoming class-action and claim deadlines (money with an expiry date). TOLLED: $0.02 USDC per call on Base via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
  },
  bridge_sweepstakes: {
    path: "/sweepstakes",
    description:
      "Mini's TrollBridge — free-to-enter sweepstakes with real prizes, curated by Mini. TOLLED: $0.02 USDC per call on Base via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
  },
  bridge_verdicts: {
    path: "/verdicts",
    description:
      "Mini's TrollBridge — recently-paid bounties: which bounties actually paid out and how much. TOLLED: $0.02 USDC per call on Base via x402. If you cannot pay, this tool returns the 402 payment instructions instead of data. Optional limit 1-200.",
  },
};

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

const server = new Server(
  { name: "trollbridge-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const ALL_TOOLS = { ...TOLLED_LANES, ...FREE_ENDPOINTS };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(ALL_TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: TOLLED_LANES[name] ? LIMIT_SCHEMA : { type: "object", properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = ALL_TOOLS[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);

  let path = def.path;
  if (TOLLED_LANES[name] && args && args.limit != null) {
    const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit) || 50)));
    path += `?limit=${limit}`;
  }

  const result = await bridgeGet(path);
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
