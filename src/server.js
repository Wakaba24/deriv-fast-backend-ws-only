import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { DerivClient } from "./derivClient.js";
import { state } from "./state.js";
import { log, err, warn } from "./logger.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

const origins = (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: origins.includes("*") ? "*" : origins,
  credentials: false
}));

app.get("/health", (req, res) => {
  res.json({ ok: true, connected: state.connected, authorized: state.authorized, time: new Date().toISOString() });
});

// Keep HTTP endpoints for debugging only (not required by UI)
app.get("/status", (req, res) => {
  res.json({
    connected: state.connected,
    authorized: state.authorized,
    lastError: state.lastError,
    defaults: state.defaults,
    ticks: { symbol: state.ticks.symbol, last: state.ticks.last, buffer_size: state.ticks.buffer.length },
    trade: {
      maxConcurrent: state.trade.maxConcurrent,
      whenFull: state.trade.whenFull,
      active_count: state.trade.activeByContract.size + state.trade.pendingBuys.size,
      queue_length: state.trade.queue.length,
      lastResult: state.trade.lastResult
    }
  });
});

const port = Number(process.env.PORT || 8080);

if (!process.env.DERIV_TOKEN) {
  err("Missing DERIV_TOKEN. Set it in .env or Railway Variables.");
  process.exit(1);
}

const client = new DerivClient({
  appId: process.env.DERIV_APP_ID || "1089",
  token: process.env.DERIV_TOKEN,
  wsUrl: process.env.DERIV_WS_URL || "wss://ws.derivws.com/websockets/v3",
  pingIntervalMs: Number(process.env.PING_INTERVAL_MS || 10000),
  reconnectBaseDelayMs: Number(process.env.RECONNECT_BASE_DELAY_MS || 500),
  reconnectMaxDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS || 10000),
  tradeResultTimeoutMs: Number(process.env.TRADE_RESULT_TIMEOUT_MS || 30000),
  maxTicksBuffer: Number(process.env.MAX_TICKS_BUFFER || 2000),
  logTicks: String(process.env.LOG_TICKS || "false").toLowerCase() === "true"
});

client.connect().catch((e) => err("Initial connect failed:", e?.message || e));

const server = app.listen(port, () => {
  log(`HTTP server listening on :${port}`);
});

const wss = new WebSocketServer({ server, path: "/ui" });

const UI_KEY = (process.env.UI_WS_KEY || "").trim();

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function currentStatus() {
  return {
    connected: state.connected,
    authorized: state.authorized,
    lastError: state.lastError,
    defaults: state.defaults,
    trade: {
      maxConcurrent: state.trade.maxConcurrent,
      whenFull: state.trade.whenFull,
      active_count: state.trade.activeByContract.size + state.trade.pendingBuys.size,
      queue_length: state.trade.queue.length
    },
    tick: state.ticks.last
  };
}

wss.on("connection", (ws, req) => {
  // Optional simple auth via query string: ?key=...
  const url = new URL(req.url, "http://localhost");
  const key = (url.searchParams.get("key") || "").trim();
  if (UI_KEY && key !== UI_KEY) {
    safeSend(ws, { type: "error", error: "UNAUTHORIZED" });
    ws.close();
    return;
  }

  ws.isAlive = true;
  ws.subTicks = true; // default: stream ticks
  ws.subResults = true;

  safeSend(ws, { type: "hello", ts: Date.now(), status: currentStatus() });

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Client can change subscriptions
    if (msg.type === "subscribe") {
      if (typeof msg.ticks === "boolean") ws.subTicks = msg.ticks;
      if (typeof msg.results === "boolean") ws.subResults = msg.results;
      safeSend(ws, { type: "subscribed", ticks: ws.subTicks, results: ws.subResults });
      return;
    }

    if (msg.type === "set_defaults") {
      const { symbol, currency, basis, maxConcurrent, whenFull } = msg;
      if (symbol) state.defaults.symbol = String(symbol);
      if (currency) state.defaults.currency = String(currency);
      if (basis) state.defaults.basis = String(basis);
      if (maxConcurrent !== undefined && maxConcurrent !== null) state.trade.maxConcurrent = Number(maxConcurrent);
      if (whenFull) state.trade.whenFull = String(whenFull).toLowerCase();
      safeSend(ws, { type: "defaults_set", defaults: state.defaults, trade: { maxConcurrent: state.trade.maxConcurrent, whenFull: state.trade.whenFull } });
      return;
    }

    if (msg.type === "subscribe_symbol") {
      if (!msg.symbol) { safeSend(ws, { type: "error", error: "symbol_required" }); return; }
      try {
        await client.subscribeTicks(String(msg.symbol));
        safeSend(ws, { type: "symbol_subscribed", symbol: String(msg.symbol) });
      } catch (e) {
        safeSend(ws, { type: "error", error: e?.message || String(e) });
      }
      return;
    }

    if (msg.type === "trade") {
      try {
        const body = msg.payload || {};
        const required = ["contract_type", "duration", "stake"];
        for (const k of required) {
          if (body[k] === undefined || body[k] === null || body[k] === "") {
            safeSend(ws, { type: "trade_ack", ok: false, error: `${k}_required` });
            return;
          }
        }
        const r = await client.placeTrade({
          symbol: body.symbol,
          contract_type: String(body.contract_type),
          duration: Number(body.duration),
          duration_unit: body.duration_unit ? String(body.duration_unit) : "t",
          stake: Number(body.stake),
          currency: body.currency,
          basis: body.basis,
          barrier: body.barrier,
          prediction: body.prediction
        });
        safeSend(ws, { type: "trade_ack", ok: true, ...r });
      } catch (e) {
        safeSend(ws, { type: "trade_ack", ok: false, error: e?.message || String(e) });
      }
      return;
    }

    if (msg.type === "status") {
      safeSend(ws, { type: "status", status: currentStatus() });
      return;
    }
  });

  ws.on("close", () => {});
});

const uiHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on("close", () => clearInterval(uiHeartbeat));

// Broadcast tick + results to all UI clients that subscribed
client.on("tick", (tick) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws.subTicks) {
      safeSend(ws, { type: "tick", tick });
    }
  });
});

// Broadcast trade started + contract updates (improves perceived speed and correctness)
client.on("trade_started", (trade) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws.subResults) {
      safeSend(ws, { type: "trade_started", trade });
    }
  });
});

client.on("contract_update", (update) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws.subResults) {
      safeSend(ws, { type: "contract_update", update });
    }
  });
});

client.on("trade_result", (result) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws.subResults) {
      safeSend(ws, { type: "result", result });
    }
  });
});

client.on("error", (e) => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      safeSend(ws, { type: "backend_error", error: e?.error || e });
    }
  });
});
