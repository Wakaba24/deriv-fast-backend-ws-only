export function createSessionState(overrides = {}) {
  return {
    connected: false,
    authorized: false,
    lastError: null,
    auth: {
      usingFallback: false,
      account: null,
      loginid: null,
      appId: null,
      authInProgress: false,
      tokenLast4: null
    },

    defaults: {
      symbol: overrides.defaultSymbol || process.env.DEFAULT_SYMBOL || "R_50",
      currency: overrides.defaultCurrency || process.env.DEFAULT_CURRENCY || "USD",
      basis: overrides.defaultBasis || "stake"
    },

    ticks: {
      symbol: null,
      last: null,
      buffer: []
    },

    trade: {
      maxConcurrent: Number(overrides.maxConcurrent ?? process.env.MAX_CONCURRENT_TRADES ?? 1),
      whenFull: String(overrides.whenFull ?? process.env.WHEN_FULL ?? "queue").toLowerCase(),

      queue: [],
      activeByContract: new Map(),
      pendingBuys: new Map(),
      lastResult: null
    }
  };
}

export function currentStatus(state) {
  return {
    connected: state.connected,
    authorized: state.authorized,
    lastError: state.lastError,
    auth: state.auth,
    defaults: state.defaults,
    trade: {
      maxConcurrent: state.trade.maxConcurrent,
      whenFull: state.trade.whenFull,
      active_count: state.trade.activeByContract.size + state.trade.pendingBuys.size,
      queue_length: state.trade.queue.length,
      lastResult: state.trade.lastResult
    },
    tick: state.ticks.last
  };
}
