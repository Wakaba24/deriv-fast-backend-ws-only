export const state = {
  connected: false,
  authorized: false,
  lastError: null,

  defaults: {
    symbol: process.env.DEFAULT_SYMBOL || "R_50",
    currency: process.env.DEFAULT_CURRENCY || "USD",
    basis: "stake"
  },

  ticks: {
    symbol: null,
    last: null,
    buffer: []
  },

  trade: {
    // Concurrency settings
    maxConcurrent: Number(process.env.MAX_CONCURRENT_TRADES || 1),
    whenFull: (process.env.WHEN_FULL || "queue").toLowerCase(), // queue | reject

    queue: [],

    // Active trades indexed by contract_id
    activeByContract: new Map(), // contract_id -> { requestId, startedAt, payload }
    // Active buys before contract_id known (indexed by requestId)
    pendingBuys: new Map(), // requestId -> { requestId, startedAt, payload }

    lastResult: null
  }
};
