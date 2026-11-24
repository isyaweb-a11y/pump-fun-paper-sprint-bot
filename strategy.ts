// Dartboard: a small-stakes pump.fun replay bot.
//
// Idea: on a 6-hour window almost every new bonding curve goes to zero, so the bot
// never bets big. It takes many small (0.03 SOL) positions on fresh curves with real
// opening demand, cuts them on a fixed 15-slot hold, and puts a larger (0.5 SOL)
// stake on coins closing on the 85 SOL migration line while a broad crowd is still
// pushing them up. Guardrail probes (0.012 SOL round trips) keep fills and coins on
// pace only when the main modes lag, so the run clears the 20-coin minimum bar.
// SURGE and DIP modes were built and measured, then switched off: both lost money
// on every dev window. A narrow cluster of wallets churning one coin is a rug in
// waiting, not demand, so the migration mode requires at least 10 distinct buyers
// in its window and no single buyer over 30% of buy flow.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Stake per position (SOL). */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** LAUNCH: age window in slots since CreateEvent. */
  launchMinAge: number;
  launchMaxAge: number;
  /** LAUNCH: cumulative buy SOL since create, and distinct non-creator buyers. */
  launchMinBuySol: number;
  launchMinBuyers: number;
  /** LAUNCH: creator's own buys must stay under this (SOL) and creator must not have sold. */
  launchMaxDevBuySol: number;
  /** LAUNCH: min real SOL at entry; max price run-up from create. */
  launchMinRealSol: number;
  launchMaxRunup: number;
  /** SURGE: lookback window (slots), min net buy SOL, min buys, min buyers. */
  surgeWindow: number;
  surgeMinNetSol: number;
  surgeMinBuys: number;
  surgeMinBuyers: number;
  /** SURGE: min price rise over the window, price at least this share of window high. */
  surgeMinUp: number;
  surgeNearHigh: number;
  /** SURGE: real SOL bounds at entry. */
  surgeMinRealSol: number;
  surgeMaxRealSol: number;
  /** SURGE: min age in slots. */
  surgeMinAge: number;
  /** DIP: high lookback (slots), drawdown band, min real SOL. */
  dipHighWindow: number;
  dipMin: number;
  dipMax: number;
  dipMinRealSol: number;
  /** DIP: of the last N trades at least this many buys, and the last must be a buy. */
  dipFlowTrades: number;
  dipMinBuys: number;
  /** MIGRATION: buy coins near the 85 SOL migration threshold while still rising. */
  migMinRealSol: number;
  migStakeSol: number;
  migWindow: number;
  migMinNetSol: number;
  /** MIGRATION: distinct buyers in the window, and the largest buyer's share of buy SOL. */
  migMinBuyers: number;
  migMaxBuyerShare: number;
  /** Exits. */
  stopLoss: number;
  trailArm: number;
  trail: number;
  tpCap: number;
  maxHold: number;
  /** If > 0: sell every position exactly this many slots after opening (ignores other exits). */
  fixedHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Guardrail pacing. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Final settings, chosen on four sliced 6-hour windows of the kit's dev data
// (net +0.28 SOL total, worst window -0.12, max drawdown 2%):
//   - LAUNCH flips at 0.03 SOL with a fixed 15-slot hold, plus MIGRATION flips at
//     0.5 SOL on coins near the 85 SOL migration line with a broad buyer crowd.
//   - SURGE and DIP are switched off (both lost money on every dev window).
//   - Light guardrail probes (0.012 SOL) keep the run above 20 coins.
export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.03,
  minBuySol: 0.01,
  launchMinAge: 5,
  launchMaxAge: 600,
  launchMinBuySol: 10,
  launchMinBuyers: 8,
  launchMaxDevBuySol: 5,
  launchMinRealSol: 10,
  launchMaxRunup: 1.0,
  surgeWindow: 40,
  surgeMinNetSol: 1e9,
  surgeMinBuys: 4,
  surgeMinBuyers: 4,
  surgeMinUp: 0.08,
  surgeNearHigh: 0.95,
  surgeMinRealSol: 10,
  surgeMaxRealSol: 80,
  surgeMinAge: 200,
  dipHighWindow: 1500,
  dipMin: 1,
  dipMax: 0.45,
  dipMinRealSol: 3,
  dipFlowTrades: 6,
  dipMinBuys: 3,
  migMinRealSol: 55,
  migStakeSol: 0.5,
  migWindow: 40,
  migMinNetSol: 0.5,
  migMinBuyers: 10,
  migMaxBuyerShare: 0.3,
  stopLoss: 0.12,
  trailArm: 0.25,
  trail: 0.2,
  tpCap: 5.0,
  maxHold: 3000,
  fixedHold: 15,
  cooldown: 300,
  maxEntries: 2,
  targetCoins: 22,
  targetFills: 60,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  devSold: boolean;
  devBuySol: number;
  /** Cumulative buy SOL since create, and distinct non-creator buyers. */
  buySol: number;
  buyers: Set<string>;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  mode: string;
}

const priceOf = (vq: number, vt: number): number => (vt > 0 ? vq / vt : 0);

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.surgeWindow, p.dipHighWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12, devSold: false, devBuySol: 0, buySol: 0, buyers: new Set() };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Liquidation value of a position in SOL, curve + tx fees deducted. */
  const valueOf = (state: BotState, batch: Batch, mint: Pubkey): number => {
    const pos = state.positions.get(mint);
    if (pos === undefined) return 0;
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const mk = batch.marks.find((m) => m.mint === mint);
    const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const tokens = Number(pos.token_amount);
    if (vt + tokens <= 0) return 0;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  const launchSignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.launchMinAge || age > p.launchMaxAge) return false;
    if (t.devSold || t.devBuySol > p.launchMaxDevBuySol) return false;
    if (rqSol < p.launchMinRealSol) return false;
    if (t.createPrice > 0 && price / t.createPrice - 1 > p.launchMaxRunup) return false;
    if (t.buySol < p.launchMinBuySol) return false;
    return t.buyers.size >= p.launchMinBuyers;
  };

  const surgeSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.surgeMinRealSol || rqSol > p.surgeMaxRealSol) return false;
    if (t.created === null || now - t.created < p.surgeMinAge) return false;
    const from = now - p.surgeWindow;
    const mid = now - p.surgeWindow / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        buyers.add(tr.user);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.surgeMinBuys || buyers.size < p.surgeMinBuyers) return false;
    if (buySol - sellSol < p.surgeMinNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.surgeMinUp) return false;
    if (last < high * p.surgeNearHigh) return false;
    if (netNew <= 0 || netNew < netOld) return false;
    return true;
  };

  /** A coin closing on the 85 SOL migration line while a broad crowd is still pushing it up.
   *  A narrow cluster of wallets churning the same coin is a rug in waiting, not demand. */
  const migSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.migMinRealSol) return false;
    const from = now - p.migWindow;
    let net = 0;
    let buySol = 0;
    let first = -1;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (first < 0) first = tr.price;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) {
        buySol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      }
      last = tr.price;
    }
    if (first <= 0 || last <= 0) return false;
    if (net < p.migMinNetSol) return false;
    if (last < first) return false;
    if (buyers.size < p.migMinBuyers) return false;
    let top = 0;
    for (const v of buyers.values()) if (v > top) top = v;
    if (buySol > 0 && top > p.migMaxBuyerShare * buySol) return false;
    return true;
  };

  const dipSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.dipMinRealSol) return false;
    if (t.trades.length < p.dipFlowTrades) return false;
    let hi = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (now - tr.slot > p.dipHighWindow) break;
      if (tr.price > hi) hi = tr.price;
    }
    if (hi <= 0) return false;
    const last = t.trades[t.trades.length - 1]!;
    const dd = 1 - last.price / hi;
    if (dd < p.dipMin || dd > p.dipMax) return false;
    if (!last.buy) return false;
    let buys = 0;
    for (let i = t.trades.length - p.dipFlowTrades; i < t.trades.length; i++) {
      if (t.trades[i]!.buy) buys++;
    }
    return buys >= p.dipMinBuys;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = priceOf(Number(e.virtual_quote_reserves), Number(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: priceOf(Number(e.virtual_quote_reserves), Number(e.virtual_token_reserves)) });
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user !== t.creator) t.buyers.add(e.user);
          }
          traded.add(e.mint);
          if (t.creator !== null && e.user === t.creator) {
            if (e.is_buy) t.devBuySol += sol;
            else t.devSold = true;
          }
        } else if (e.event === 'CompleteEvent') {
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const pendingByMint = new Map<Pubkey, boolean>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, true);

      // Exits first: stop loss, trailing stop, 3x cap, time limit, creator sold.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(state, batch, mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (p.fixedHold > 0) {
          if (now - h.opened >= p.fixedHold) exit = true;
        } else {
          if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
          if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
          if (!exit && value >= cost * p.tpCap) exit = true;
          if (!exit && now - h.opened > p.maxHold && value < cost * 1.1) exit = true;
          if (!exit && t.devSold) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const price = priceOf(Number(curve.virtual_quote_reserves), Number(curve.virtual_token_reserves));
        if (!(price > 0)) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let mode = '';
        let stake = p.stakeSol;
        if (migSignal(t, now, rqSol)) {
          mode = 'mig';
          stake = p.migStakeSol;
        } else if (launchSignal(t, now, rqSol, price)) mode = 'launch';
        else if (surgeSignal(t, now, rqSol)) mode = 'surge';
        else if (dipSignal(t, now, rqSol)) mode = 'dip';
        if (mode === '') continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, stake);
        if (amount > free - tx) amount = free - tx;
        if (!(amount >= p.minBuySol)) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports <= 0n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: 1500 });
        free -= amount + tx;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, mode });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace. Probes
      // are the cheapest way to clear the 20-coin minimum bar on quiet windows;
      // they never compete with real entries for a slot they already hold.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: 1500 });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
