// Rounds: per epoch  sweep -> bookClaim -> compute -> execute, one round at a time.
// `computeHistory` is the deterministic part (also used by replay, snapshot and api): it walks every
// closed epoch from launch, books the pot, evaluates eligibility at the close and computes the drop.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Alerts } from './alerts.js';
import { epochBoundary, type Config, type Launch, type Ops, type Rules } from './config.js';
import { evaluateAll, type WalletStatus } from './eligibility.js';
import type { DropResult, Executor } from './executor.js';
import type { Fees } from './fees.js';
import { Rebuilder, rebuild, type Ev, type Indexer, type Inflow } from './indexer.js';
import { ledgerHash, readLedger, writeLedger, type Ledger } from './ledger.js';
import { computeDrop } from './payout.js';
import { gridCritical, type ChainReader } from './rpc.js';
import { twapClose } from './twap.js';

// ---------------------------------------------------------------------------------------------
// bookClaim (pure)
// ---------------------------------------------------------------------------------------------

export interface BookInput {
  sweeps: bigint; // IMD from hook sweeps in the window
  distributor: bigint; // IMD received from the launch distributor in the window
  carry: bigint; // leftover rolled forward from the previous drop
  dexReserveRemaining: bigint; // part of the one-time DEX reserve not yet taken
  opsSkimFraction: [bigint, bigint];
  pouchShareOfDistributor: [bigint, bigint];
}

export interface Book {
  sweeps: bigint;
  distributorGross: bigint;
  distributorPouch: bigint;
  team: bigint; // shown in treasury, never paid
  newPouch: bigint;
  opsSkim: bigint;
  dexReserve: bigint;
  carry: bigint;
  pot: bigint;
}

export function bookClaim(i: BookInput): Book {
  const [pn, pd] = i.pouchShareOfDistributor;
  const distributorPouch = (i.distributor * pn) / pd;
  const team = i.distributor - distributorPouch;
  const newPouch = i.sweeps + distributorPouch;
  const [sn, sd] = i.opsSkimFraction;
  const opsSkim = (newPouch * sn) / sd;
  const afterSkim = newPouch - opsSkim;
  const dexReserve = i.dexReserveRemaining < afterSkim ? i.dexReserveRemaining : afterSkim;
  return {
    sweeps: i.sweeps,
    distributorGross: i.distributor,
    distributorPouch,
    team,
    newPouch,
    opsSkim,
    dexReserve,
    carry: i.carry,
    pot: i.carry + afterSkim - dexReserve,
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic history
// ---------------------------------------------------------------------------------------------

export interface ManualClaim {
  kind: 'sweep' | 'distributor';
  tx: string;
  logIndex: number;
  ts: number;
  amount: bigint;
  note?: string;
}

/** Payout-wallet inflows that count toward the pot: hook Swept events and distributor transfers. */
export function inflowsOf(evs: Ev[], launch: Launch, manual: ManualClaim[] = []): Inflow[] {
  const payout = launch.payoutWallet.toLowerCase();
  const distributor = launch.distributor.toLowerCase();
  const out: { kind: Inflow['kind']; tx: string; logIndex: number; ts: number; amount: bigint }[] = [];
  for (const e of evs) {
    if (e.kind === 'swept' && e.to.toLowerCase() === payout) out.push({ ...e, kind: 'sweep', amount: e.amount });
    if (e.kind === 'transfer' && e.asset === 'imd' && e.from.toLowerCase() === distributor && e.to.toLowerCase() === payout)
      out.push({ ...e, kind: 'distributor', amount: e.value });
  }
  // A manual claim never double-counts a tx whose inflow of that kind is already indexed.
  const seen = new Set(out.map((o) => `${o.kind}:${o.tx}`));
  for (const m of manual) if (!seen.has(`${m.kind}:${m.tx.toLowerCase()}`)) out.push({ ...m, tx: m.tx.toLowerCase() });
  return out.sort((a, b) => a.ts - b.ts || (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : a.logIndex - b.logIndex)) as Inflow[];
}

export interface EpochResult {
  epochIndex: number;
  boundaryTs: number;
  closeX96: bigint | null;
  book: Book;
  eligible: number;
  underwater: number;
  ledger: Ledger | null; // null when nothing was paid (no close, empty pot or nobody underwater)
  ledgerHash: string | null;
}

export interface Treasury {
  sweeps: bigint;
  distributorGross: bigint;
  pouch: bigint;
  team: bigint;
  opsSkim: bigint;
  dexReserve: bigint;
  paid: bigint;
  carry: bigint;
}

export interface History {
  epochs: EpochResult[];
  ledgers: Ledger[];
  treasury: Treasury;
  paidSoFar: Map<string, bigint>;
  statuses: WalletStatus[]; // as of the last computed close
  rebuilder: Rebuilder;
  inflows: Inflow[];
  lastWindowEnd: number;
}

export interface HistoryInput {
  events: Ev[];
  launch: Launch;
  rules: Rules;
  ops: Pick<Ops, 'opsSkimFraction' | 'dexReserveQuote'>;
  excluded: Set<string>;
  contracts: Set<string>;
  /** Last epoch index to compute (inclusive). */
  uptoEpoch: number;
  manualClaims?: ManualClaim[];
}

export function computeHistory(h: HistoryInput): History {
  const { launch, rules } = h;
  const rebuilder = new Rebuilder(h.events, launch, h.excluded);
  const inflows = inflowsOf(h.events, launch, h.manualClaims);
  const treasury: Treasury = {
    sweeps: 0n,
    distributorGross: 0n,
    pouch: 0n,
    team: 0n,
    opsSkim: 0n,
    dexReserve: 0n,
    paid: 0n,
    carry: 0n,
  };
  const paidSoFar = new Map<string, bigint>();
  const epochs: EpochResult[] = [];
  const ledgers: Ledger[] = [];
  let statuses: WalletStatus[] = [];
  let windowStart = -Infinity; // inflows are booked in (windowStart, boundary + grace]
  let ii = 0;
  for (let k = 0; k <= h.uptoEpoch; k++) {
    const B = epochBoundary({ launch, rules }, k);
    const windowEnd = B + rules.claimGraceSeconds;
    let sweeps = 0n;
    let distributor = 0n;
    for (; ii < inflows.length && inflows[ii].ts <= windowEnd; ii++) {
      if (inflows[ii].ts <= windowStart) continue;
      if (inflows[ii].kind === 'sweep') sweeps += inflows[ii].amount;
      else distributor += inflows[ii].amount;
    }
    windowStart = windowEnd;
    const book = bookClaim({
      sweeps,
      distributor,
      carry: treasury.carry,
      dexReserveRemaining: h.ops.dexReserveQuote - treasury.dexReserve,
      opsSkimFraction: h.ops.opsSkimFraction,
      pouchShareOfDistributor: rules.pouchShareOfDistributor,
    });
    treasury.sweeps += book.sweeps;
    treasury.distributorGross += book.distributorGross;
    treasury.pouch += book.newPouch;
    treasury.team += book.team;
    treasury.opsSkim += book.opsSkim;
    treasury.dexReserve += book.dexReserve;

    const state = rebuilder.advance(B);
    const closeX96 = twapClose(state.observations, B, rules.twapSeconds);
    let ledger: Ledger | null = null;
    let eligible = 0;
    let underwater = 0;
    if (closeX96 !== null) {
      statuses = evaluateAll(state.wallets.values(), {
        closeX96,
        minBuy: rules.minBuy,
        excluded: h.excluded,
        contracts: h.contracts,
      });
      eligible = statuses.filter((s) => s.eligible).length;
      underwater = statuses.filter((s) => s.eligible && s.loss > 0n).length;
      const drop = computeDrop({
        epochIndex: k,
        boundaryTs: B,
        token: launch.token,
        closeX96,
        pot: book.pot,
        statuses,
        paidSoFar,
        rules,
      });
      if (drop.paidTotal > 0n) {
        ledger = drop;
        ledgers.push(drop);
        for (const e of drop.entries) if (e.amount > 0n) paidSoFar.set(e.payee, (paidSoFar.get(e.payee) ?? 0n) + e.amount);
      }
    }
    const paid = ledger?.paidTotal ?? 0n;
    treasury.paid += paid;
    treasury.carry = book.pot - paid;
    epochs.push({
      epochIndex: k,
      boundaryTs: B,
      closeX96,
      book,
      eligible,
      underwater,
      ledger,
      ledgerHash: ledger ? ledgerHash(ledger) : null,
    });
  }
  return { epochs, ledgers, treasury, paidSoFar, statuses, rebuilder, inflows, lastWindowEnd: windowStart };
}

/**
 * What the next drop would pay if it closed at `nowTs`: TWAP ending now, pot = carry + inflows since
 * the last booked window + `pendingImd` (hook fees not yet swept). Uses the same eligibility and payout code.
 */
export function estimateNextDrop(hist: History, h: HistoryInput, nowTs: number, pendingImd = 0n): Ledger | null {
  const state = hist.rebuilder.advance(nowTs);
  const closeX96 = twapClose(state.observations, nowTs, h.rules.twapSeconds);
  if (closeX96 === null) return null;
  let sweeps = pendingImd;
  let distributor = 0n;
  for (const f of hist.inflows) {
    if (f.ts <= hist.lastWindowEnd) continue;
    if (f.kind === 'sweep') sweeps += f.amount;
    else distributor += f.amount;
  }
  const book = bookClaim({
    sweeps,
    distributor,
    carry: hist.treasury.carry,
    dexReserveRemaining: h.ops.dexReserveQuote - hist.treasury.dexReserve,
    opsSkimFraction: h.ops.opsSkimFraction,
    pouchShareOfDistributor: h.rules.pouchShareOfDistributor,
  });
  const statuses = evaluateAll(state.wallets.values(), {
    closeX96,
    minBuy: h.rules.minBuy,
    excluded: h.excluded,
    contracts: h.contracts,
  });
  return computeDrop({
    epochIndex: hist.epochs.length,
    boundaryTs: nowTs,
    token: h.launch.token,
    closeX96,
    pot: book.pot,
    statuses,
    paidSoFar: hist.paidSoFar,
    rules: h.rules,
  });
}

export function loadManualClaims(dataDir: string): ManualClaim[] {
  const p = join(dataDir, 'claims-manual.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).map((c: any) => ({ ...c, amount: BigInt(c.amount) }));
}

// ---------------------------------------------------------------------------------------------
// Runner (impure)
// ---------------------------------------------------------------------------------------------

export interface RunnerDeps {
  cfg: Config;
  chain: ChainReader;
  indexer: Indexer;
  fees: Fees;
  executor: Executor | null; // null in dry-run
  alerts: Alerts;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface TickResult {
  indexedBlock: bigint;
  indexedTs: number;
  history: History;
  input: HistoryInput;
  executed: { epochIndex: number; result: DropResult | 'dry-run' }[];
}

export class RoundRunner {
  private sweptEpoch = -1;
  private lastProgress = Date.now();
  private stallAlerted = false;
  private busy = false;

  constructor(private readonly d: RunnerDeps) {}

  private nowTs() {
    return Math.floor((this.d.now?.() ?? Date.now()) / 1000);
  }

  /** One pass: index, sweep/trigger after a boundary, compute closed epochs, execute pending drops. */
  async tick(): Promise<TickResult | null> {
    if (this.busy) return null; // one round at a time
    this.busy = true;
    try {
      return await this.tickInner();
    } finally {
      this.busy = false;
    }
  }

  private async tickInner(): Promise<TickResult> {
    const { cfg, chain, indexer, fees, executor, log } = this.d;
    const { launch, rules } = cfg;
    const now = this.nowTs();
    const currentEpoch = Math.floor((now - launch.launchTs) / rules.epochSeconds) - 1; // last closed by wall clock
    if (cfg.exec.mode === 'live' && currentEpoch > this.sweptEpoch && currentEpoch >= 0) {
      this.sweptEpoch = currentEpoch;
      await fees.realise(); // hook.sweep() + distributor trigger, right after the boundary
    }

    const indexedBlock = await indexer.sync();
    const critical = gridCritical(launch.launchTs, rules.epochSeconds, rules.twapSeconds);
    const indexedTs = await chain.timestamps.at(indexedBlock, indexedBlock, critical);
    const uptoEpoch = Math.floor((indexedTs - rules.claimGraceSeconds - launch.launchTs) / rules.epochSeconds) - 1;

    const evs = indexer.idx.events;
    // Only wallets with a qualifying buy can ever be paid, so only they need a code check.
    const candidates = [...rebuild(evs, launch, cfg.exclusions).wallets.values()]
      .filter((w) => w.qualTokens > 0n && !cfg.exclusions.has(w.address))
      .map((w) => w.address);
    const contracts = await indexer.contracts(candidates);
    const input: HistoryInput = {
      events: evs,
      launch,
      rules,
      ops: cfg.ops,
      excluded: cfg.exclusions,
      contracts,
      uptoEpoch,
      manualClaims: loadManualClaims(cfg.ops.dataDir),
    };
    const history = computeHistory(input);
    const dir = join(cfg.ops.dataDir, 'ledgers');
    for (const l of history.ledgers) {
      const existing = readLedger(dir, l.epochIndex);
      if (existing && ledgerHash(existing) !== ledgerHash(l)) {
        // A ledger is immutable once written: a recomputation that disagrees is an incident.
        await this.d.alerts.send(`ledger mismatch for epoch ${l.epochIndex}: on disk ${ledgerHash(existing)} vs ${ledgerHash(l)}`);
        throw new Error(`ledger for epoch ${l.epochIndex} changed on recomputation`);
      }
      if (!existing) writeLedger(dir, l);
    }

    const executed: TickResult['executed'] = [];
    if (executor) {
      for (const l of history.ledgers) {
        if (executor.isFinal(l.epochIndex)) continue;
        const result = await executor.executeDrop(l);
        executed.push({ epochIndex: l.epochIndex, result });
        if (result.status !== 'paid') break; // one round at a time; resume next tick
      }
      await executor.retryFailedLegs();
    } else {
      const last = history.ledgers[history.ledgers.length - 1];
      if (last) executed.push({ epochIndex: last.epochIndex, result: 'dry-run' });
    }

    if (uptoEpoch >= 0) this.lastProgress = Date.now();
    log('tick', { indexedBlock: indexedBlock.toString(), indexedTs, uptoEpoch, drops: history.ledgers.length });
    return { indexedBlock, indexedTs, history, input, executed };
  }

  /** Alerts once when no tick has completed (or the index has not advanced) for stallMinutes. */
  async checkStall(): Promise<void> {
    const stalledFor = (Date.now() - this.lastProgress) / 60_000;
    if (stalledFor > this.d.cfg.ops.stallMinutes && !this.stallAlerted) {
      this.stallAlerted = true;
      await this.d.alerts.send(`rounds stalled: no progress for ${stalledFor.toFixed(0)} min`);
    } else if (stalledFor <= this.d.cfg.ops.stallMinutes) {
      this.stallAlerted = false;
    }
  }

  markProgress() {
    this.lastProgress = Date.now();
  }
}
