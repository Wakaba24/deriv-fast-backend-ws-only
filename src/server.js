import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { DerivClient } from "./derivClient.js";
import { createSessionState, currentStatus } from "./state.js";
import { log, err, warn } from "./logger.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

const origins = (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: origins.includes("*") ? "*" : origins,
  credentials: false
}));

const port = Number(process.env.PORT || 8080);
const DEFAULT_APP_ID = process.env.DERIV_APP_ID || "1089";
const FALLBACK_TOKEN = (process.env.DERIV_TOKEN || "").trim();
const UI_KEY = (process.env.UI_WS_KEY || "").trim();

function buildClient(sessionState, token, appId) {
  return new DerivClient({
    state: sessionState,
    appId: appId || DEFAULT_APP_ID,
    token,
    wsUrl: process.env.DERIV_WS_URL || "wss://ws.derivws.com/websockets/v3",
    pingIntervalMs: Number(process.env.PING_INTERVAL_MS || 10000),
    reconnectBaseDelayMs: Number(process.env.RECONNECT_BASE_DELAY_MS || 500),
    reconnectMaxDelayMs: Number(process.env.RECONNECT_MAX_DELAY_MS || 10000),
    tradeResultTimeoutMs: Number(process.env.TRADE_RESULT_TIMEOUT_MS || 30000),
    maxTicksBuffer: Number(process.env.MAX_TICKS_BUFFER || 2000),
    logTicks: String(process.env.LOG_TICKS || "false").toLowerCase() === "true"
  });
}

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function bindClientToSocket(ws, client, sessionState) {
  client.on("tick", (tick) => {
    if (ws.readyState === ws.OPEN && ws.subTicks) safeSend(ws, { type: "tick", tick });
  });
  client.on("trade_started", (trade) => {
    if (ws.readyState === ws.OPEN && ws.subResults) safeSend(ws, { type: "trade_started", trade });
  });
  client.on("contract_update", (update) => {
    if (ws.readyState === ws.OPEN && ws.subResults) safeSend(ws, { type: "contract_update", update });
  });
  client.on("trade_result", (result) => {
    if (ws.readyState === ws.OPEN && ws.subResults) safeSend(ws, { type: "result", result });
  });
  client.on("authorized", (auth) => {
    sessionState.auth.authInProgress = false;
    safeSend(ws, { type: "session_auth_ok", auth, status: currentStatus(sessionState) });
  });
  client.on("error", ({ error }) => {
    if (sessionState.auth.authInProgress) {
      sessionState.auth.authInProgress = false;
      safeSend(ws, { type: "session_auth_failed", error, status: currentStatus(sessionState) });
    } else {
      safeSend(ws, { type: "backend_error", error, status: currentStatus(sessionState) });
    }
  });
}

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), fallbackConfigured: Boolean(FALLBACK_TOKEN) });
});

app.get("/status", (req, res) => {
  res.json({ ok: true, note: "Use websocket /ui for per-session status" });
});

const server = app.listen(port, () => {
  log(`HTTP server listening on :${port}`);
});

const wss = new WebSocketServer({ server, path: "/ui" });
const sessions = new Map();

async function authorizeSession(ws, { token, appId, usingFallback = false }) {
  const session = sessions.get(ws);
  if (!session) return;

  const activeCount = session.state.trade.activeByContract.size + session.state.trade.pendingBuys.size;
  if (activeCount > 0 || session.state.trade.queue.length > 0) {
    safeSend(ws, { type: "session_auth_failed", error: "SESSION_BUSY_ACTIVE_TRADES", status: currentStatus(session.state) });
    return;
  }

  if (!token) {
    safeSend(ws, { type: "session_auth_failed", error: "TOKEN_REQUIRED", status: currentStatus(session.state) });
    return;
  }

  session.state.auth.authInProgress = true;
  session.state.auth.usingFallback = Boolean(usingFallback);
  safeSend(ws, { type: "session_auth_started", usingFallback: Boolean(usingFallback) });

  try {
    if (session.client) await session.client.disconnect({ resetState: true });
    session.client = buildClient(session.state, token, appId || DEFAULT_APP_ID);
    bindClientToSocket(ws, session.client, session.state);
    await session.client.connect();
  } catch (e) {
    session.state.auth.authInProgress = false;
    session.state.lastError = e?.message || String(e);
    safeSend(ws, { type: "session_auth_failed", error: session.state.lastError, status: currentStatus(session.state) });
  }
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const key = (url.searchParams.get("key") || "").trim();
  if (UI_KEY && key !== UI_KEY) {
    safeSend(ws, { type: "error", error: "UNAUTHORIZED" });
    ws.close();
    return;
  }

  const sessionId = randomUUID();
  const sessionState = createSessionState();
  const session = { id: sessionId, state: sessionState, client: null };
  sessions.set(ws, session);

  ws.isAlive = true;
  ws.subTicks = true;
  ws.subResults = true;

  safeSend(ws, { type: "hello", ts: Date.now(), sessionId, status: currentStatus(sessionState), fallbackAvailable: Boolean(FALLBACK_TOKEN) });

  if (FALLBACK_TOKEN) {
    await authorizeSession(ws, { token: FALLBACK_TOKEN, appId: DEFAULT_APP_ID, usingFallback: true });
  }

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (buf) => {
    const currentSession = sessions.get(ws);
    if (!currentSession) return;

    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "subscribe") {
      if (typeof msg.ticks === "boolean") ws.subTicks = msg.ticks;
      if (typeof msg.results === "boolean") ws.subResults = msg.results;
      safeSend(ws, { type: "subscribed", ticks: ws.subTicks, results: ws.subResults });
      return;
    }

    if (msg.type === "auth_session" || msg.type === "set_token") {
      await authorizeSession(ws, {
        token: (msg.token || "").trim(),
        appId: msg.appId ? String(msg.appId) : DEFAULT_APP_ID,
        usingFallback: false
      });
      return;
    }

    if (msg.type === "use_fallback_token") {
      if (!FALLBACK_TOKEN) {
        safeSend(ws, { type: "session_auth_failed", error: "FALLBACK_NOT_CONFIGURED", status: currentStatus(currentSession.state) });
        return;
      }
      await authorizeSession(ws, { token: FALLBACK_TOKEN, appId: DEFAULT_APP_ID, usingFallback: true });
      return;
    }

    if (msg.type === "set_defaults") {
      const { symbol, currency, basis, maxConcurrent, whenFull } = msg;
      if (symbol) currentSession.state.defaults.symbol = String(symbol);
      if (currency) currentSession.state.defaults.currency = String(currency);
      if (basis) currentSession.state.defaults.basis = String(basis);
      if (maxConcurrent !== undefined && maxConcurrent !== null) currentSession.state.trade.maxConcurrent = Number(maxConcurrent);
      if (whenFull) currentSession.state.trade.whenFull = String(whenFull).toLowerCase();
      safeSend(ws, { type: "defaults_set", defaults: currentSession.state.defaults, trade: { maxConcurrent: currentSession.state.trade.maxConcurrent, whenFull: currentSession.state.trade.whenFull } });
      return;
    }

    if (msg.type === "subscribe_symbol") {
      if (!msg.symbol) { safeSend(ws, { type: "error", error: "symbol_required" }); return; }
      if (!currentSession.client || !currentSession.state.authorized) {
        safeSend(ws, { type: "error", error: "SESSION_NOT_AUTHORIZED" });
        return;
      }
      try {
        await currentSession.client.subscribeTicks(String(msg.symbol));
        safeSend(ws, { type: "symbol_subscribed", symbol: String(msg.symbol) });
      } catch (e) {
        safeSend(ws, { type: "error", error: e?.message || String(e) });
      }
      return;
    }

    if (msg.type === "trade") {
      if (!currentSession.client || !currentSession.state.authorized) {
        safeSend(ws, { type: "trade_ack", ok: false, error: "SESSION_NOT_AUTHORIZED" });
        return;
      }
      try {
        const body = msg.payload || {};
        const required = ["contract_type", "duration", "stake"];
        for (const k of required) {
          if (body[k] === undefined || body[k] === null || body[k] === "") {
            safeSend(ws, { type: "trade_ack", ok: false, error: `${k}_required` });
            return;
          }
        }
        const r = await currentSession.client.placeTrade({
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
        safeSend(ws, { type: "trade_ack", ok: true, ...r, activeLoginId: currentSession.state.auth.loginid, sessionId: currentSession.id });
      } catch (e) {
        safeSend(ws, { type: "trade_ack", ok: false, error: e?.message || String(e) });
      }
      return;
    }

    if (msg.type === "status") {
      safeSend(ws, { type: "status", status: currentStatus(currentSession.state) });
      return;
    }
  });

  ws.on("close", async () => {
    const closingSession = sessions.get(ws);
    sessions.delete(ws);
    if (closingSession?.client) await closingSession.client.disconnect({ resetState: true });
  });
});

const uiHeartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on("close", () => clearInterval(uiHeartbeat));
