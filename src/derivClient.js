import WebSocket from "ws";
import { EventEmitter } from "events";
import { state } from "./state.js";
import { log, warn, err } from "./logger.js";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export class DerivClient extends EventEmitter {
  constructor(opts) {
    super();
    this.appId = opts.appId;
    this.token = opts.token;
    this.wsUrl = opts.wsUrl;
    this.pingIntervalMs = opts.pingIntervalMs;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs;
    this.tradeResultTimeoutMs = opts.tradeResultTimeoutMs;
    this.maxTicksBuffer = opts.maxTicksBuffer;
    this.logTicks = opts.logTicks;

    this.ws = null;
    this.pingTimer = null;
    this.reconnectAttempt = 0;

    this.pending = new Map(); // req_id -> {resolve,reject,ts,type}
  }

  _nextReqId() {
    return Math.floor(Math.random() * 1e9);
  }

  _activeCount() {
    return state.trade.activeByContract.size + state.trade.pendingBuys.size;
  }

  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    state.connected = false;
    state.authorized = false;

    const url = `${this.wsUrl}?app_id=${encodeURIComponent(this.appId)}`;
    log("Connecting to Deriv WS:", url);

    this.ws = new WebSocket(url);

    this.ws.on("open", async () => {
      state.connected = true;
      state.lastError = null;
      this.reconnectAttempt = 0;
      log("✅ Connected");
      this.emit("connection", { connected: true });

      // Start heartbeat
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ ping: 1 }));
        }
      }, this.pingIntervalMs);

      // Authorize
      try {
        await this.send({ authorize: this.token }, "authorize");
        state.authorized = true;
        log("🔐 Authorized");
        this.emit("authorized", { authorized: true });

        // Subscribe to default ticks
        await this.subscribeTicks(state.defaults.symbol);
      } catch (e) {
        err("Authorize failed:", e?.message || e);
        state.lastError = e?.message || String(e);
        this.emit("error", { error: state.lastError });
      }
    });

    this.ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }

      // Resolve pending promises by req_id
      if (msg.req_id && this.pending.has(msg.req_id)) {
        const p = this.pending.get(msg.req_id);
        this.pending.delete(msg.req_id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg);
      }

      // Stream handlers
      if (msg.msg_type === "tick") {
        state.ticks.symbol = msg.tick?.symbol || state.ticks.symbol;
        state.ticks.last = msg.tick;
        state.ticks.buffer.push(msg.tick);
        if (state.ticks.buffer.length > this.maxTicksBuffer) {
          state.ticks.buffer.splice(0, state.ticks.buffer.length - this.maxTicksBuffer);
        }
        if (this.logTicks) log("tick", msg.tick.quote, msg.tick.epoch);
        this.emit("tick", msg.tick);
      }

      if (msg.msg_type === "buy") {
        // Buy response gives contract_id
        const contractId = msg.buy?.contract_id;
        if (!contractId) return;

        // Prefer passthrough mapping (more reliable under fast consecutive buys)
        const passthroughId =
          msg.buy?.passthrough?.request_id ??
          msg.echo_req?.passthrough?.request_id ??
          msg.passthrough?.request_id ??
          null;

        let requestId = null;
        let pending = null;

        if (passthroughId && state.trade.pendingBuys.has(passthroughId)) {
          requestId = passthroughId;
          pending = state.trade.pendingBuys.get(passthroughId);
          state.trade.pendingBuys.delete(passthroughId);
        } else {
          // Fallback: Match FIFO pending buy (in case passthrough isn't echoed)
          const entries = Array.from(state.trade.pendingBuys.entries());
          if (entries.length === 0) return;
          entries.sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0));
          [requestId, pending] = entries[0];
          state.trade.pendingBuys.delete(requestId);
        }

        state.trade.activeByContract.set(contractId, {
          requestId,
          startedAt: pending?.startedAt,
          payload: pending?.payload
        });

        this.emit("trade_started", { request_id: requestId, contract_id: contractId });
      }

      if (msg.msg_type === "proposal_open_contract") {
        const poc = msg.proposal_open_contract;
        if (!poc) return;
        const contractId = poc.contract_id;
        const active = state.trade.activeByContract.get(contractId);
        if (!active) return;

        // Stream contract updates immediately for UI (reduces perceived latency)
        this.emit("contract_update", {
          contract_id: contractId,
          status: poc.status,
          is_sold: poc.is_sold,
          profit: poc.profit,
          payout: poc.payout,
          buy_price: poc.buy_price,
          sell_price: poc.sell_price,
          exit_tick: poc.exit_tick,
          exit_tick_time: poc.exit_tick_time,
          current_spot: poc.current_spot,
          current_spot_time: poc.current_spot_time,
          transaction_ids: poc.transaction_ids || null,
          request_id: active.requestId
        });

        const isFinal = Boolean(poc.is_sold) || ["won", "lost"].includes(poc.status);
        if (isFinal) {
          const result = {
            contract_id: contractId,
            status: poc.status,
            is_sold: poc.is_sold,
            profit: poc.profit,
            payout: poc.payout,
            buy_price: poc.buy_price,
            sell_price: poc.sell_price,
            exit_tick: poc.exit_tick,
            exit_tick_time: poc.exit_tick_time,
            transaction_ids: poc.transaction_ids || null,
            endedAt: Date.now(),
            request_id: active.requestId
          };

          state.trade.lastResult = result;

          state.trade.activeByContract.delete(contractId);
          this.emit("trade_result", result);

          this._drainQueue();
        }
      }

      if (msg.error) {
        state.lastError = `${msg.error.code}: ${msg.error.message}`;
        this.emit("error", { error: state.lastError });
      }
    });

    this.ws.on("close", async (code, reason) => {
      state.connected = false;
      state.authorized = false;
      warn("WS closed:", code, reason?.toString?.() || "");
      this.emit("connection", { connected: false, code });

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;

      for (const [_, p] of this.pending.entries()) {
        p.reject(new Error("WebSocket closed"));
      }
      this.pending.clear();

      // Reset trade tracking (conservative)
      state.trade.queue = [];
      state.trade.activeByContract.clear();
      state.trade.pendingBuys.clear();

      await this._reconnect();
    });

    this.ws.on("error", (e) => {
      state.lastError = e?.message || String(e);
      warn("WS error:", state.lastError);
      this.emit("error", { error: state.lastError });
    });
  }

  async _reconnect() {
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, Math.min(this.reconnectAttempt, 8))
    );
    warn(`Reconnecting in ${delay}ms...`);
    await sleep(delay);
    try {
      await this.connect();
    } catch (e) {
      warn("Reconnect failed:", e?.message || e);
    }
  }

  async send(payload, type = "request") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    const req_id = this._nextReqId();
    const msg = { ...payload, req_id };
    const p = new Promise((resolve, reject) => {
      this.pending.set(req_id, { resolve, reject, ts: Date.now(), type });
      setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          reject(new Error(`Timeout waiting for ${type}`));
        }
      }, 15000);
    });
    this.ws.send(JSON.stringify(msg));
    return p;
  }

  async subscribeTicks(symbol) {
    state.ticks.symbol = symbol;
    state.ticks.buffer = [];
    await this.send({ ticks: symbol, subscribe: 1 }, "ticks_subscribe");
    log("📈 Subscribed ticks:", symbol);
    this.emit("subscribed", { symbol });
  }

  async placeTrade(tradePayload) {
    const requestId = this._nextReqId();
    const payload = { requestId, startedAt: Date.now(), ...tradePayload };

    const maxC = state.trade.maxConcurrent;
    if (this._activeCount() >= maxC) {
      if (state.trade.whenFull === "reject") {
        return { accepted: false, queued: false, request_id: requestId, error: "CONCURRENCY_LIMIT" };
      }
      state.trade.queue.push(payload);
      return { accepted: true, queued: true, request_id: requestId, queue_position: state.trade.queue.length };
    }

    this._startTrade(payload).catch((e) => {
      err("Trade failed:", e?.message || e);
      const r = { contract_id: null, status: "error", error: e?.message || String(e), endedAt: Date.now(), request_id: requestId };
      state.trade.lastResult = r;
      this.emit("trade_result", r);
      state.trade.pendingBuys.delete(requestId);
      this._drainQueue();
    });

    return { accepted: true, queued: false, request_id: requestId };
  }

  _drainQueue() {
    const maxC = state.trade.maxConcurrent;
    while (state.trade.queue.length > 0 && this._activeCount() < maxC) {
      const next = state.trade.queue.shift();
      this._startTrade(next).catch((e) => {
        err("Queued trade failed:", e?.message || e);
        const r = { contract_id: null, status: "error", error: e?.message || String(e), endedAt: Date.now(), request_id: next.requestId };
        state.trade.lastResult = r;
        this.emit("trade_result", r);
        state.trade.pendingBuys.delete(next.requestId);
      });
    }
  }

  async _startTrade(payload) {
    if (!state.authorized) throw new Error("Not authorized yet");

    const {
      symbol,
      contract_type,
      duration,
      duration_unit,
      stake,
      currency,
      basis,
      barrier,
      prediction
    } = payload;

    state.trade.pendingBuys.set(payload.requestId, { requestId: payload.requestId, startedAt: payload.startedAt, payload });

    const proposalReq = {
      proposal: 1,
      amount: Number(stake),
      basis: basis || state.defaults.basis || "stake",
      contract_type,
      currency: currency || state.defaults.currency,
      duration: Number(duration),
      duration_unit: duration_unit || "t",
      symbol: symbol || state.defaults.symbol,
      passthrough: { request_id: payload.requestId }
    };

    if (barrier !== undefined && barrier !== null) proposalReq.barrier = String(barrier);
    if (prediction !== undefined && prediction !== null) proposalReq.prediction = Number(prediction);

    const proposalRes = await this.send(proposalReq, "proposal");
    const proposal_id = proposalRes.proposal?.id;
    if (!proposal_id) throw new Error("No proposal id returned");

    const buyRes = await this.send({ buy: proposal_id, price: Number(stake), passthrough: { request_id: payload.requestId } }, "buy");
    const contractId = buyRes.buy?.contract_id;
    if (!contractId) throw new Error("No contract_id returned");

    state.trade.pendingBuys.delete(payload.requestId);
    state.trade.activeByContract.set(contractId, { requestId: payload.requestId, startedAt: payload.startedAt, payload });
    this.emit("trade_started", { request_id: payload.requestId, contract_id: contractId });

    this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }, "proposal_open_contract").catch(() => {});

    setTimeout(() => {
      if (state.trade.activeByContract.has(contractId)) {
        const r = {
          contract_id: contractId,
          status: "timeout",
          is_sold: false,
          profit: null,
          payout: null,
          buy_price: null,
          sell_price: null,
          endedAt: Date.now(),
          request_id: payload.requestId
        };
        state.trade.lastResult = r;
        state.trade.activeByContract.delete(contractId);
        this.emit("trade_result", r);
        this._drainQueue();
      }
    }, this.tradeResultTimeoutMs);

    log("🟢 Trade started:", { contract_type, symbol: proposalReq.symbol, stake, duration: proposalReq.duration, contractId, requestId: payload.requestId });
  }
}
