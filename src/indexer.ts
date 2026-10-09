// Indexer: backfills from launchBlock then follows the safe head. Collects token Transfers, Swap and
// Initialize for our pool id, hook FeeAccrued/Swept, and IMD Transfers into the payout wallet.
// Logs are grouped by transaction and every wallet ledger is rebuilt deterministically from them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeAbiParameters, getAddress, pad, type Address, type Hex } from 'viem';
import { TOPIC } from './abi.js';
import { IMD, POOL_MANAGER, type Config, type Launch } from './config.js';
import { gridCritical, type ChainReader, type RawLog } from './rpc.js';
import { priceX96FromSqrt, type Observation } from './twap.js';

// ---------------------------------------------------------------------------------------------
// Decoded events
// ---------------------------------------------------------------------------------------------

interface Base {
  block: bigint;
  logIndex: number;
  txIndex: number;
  tx: Hex;
  ts: number;
}
export type Ev =
  | (Base & { kind: 'transfer'; asset: 'token' | 'imd'; from: Address; to: Address; value: bigint })
  | (Base & { kind: 'swap'; sender: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint })
  | (Base & { kind: 'init'; currency0: Address; currency1: Address; hooks: Address; sqrtPriceX96: bigint })
  | (Base & { kind: 'fee'; isSell: boolean; baseFeeImd: bigint; surchargeImd: bigint; imdLeg: bigint })
  | (Base & { kind: 'swept'; amount: bigint; to: Address });

const topicAddr = (t: Hex): Address => getAddress(`0x${t.slice(26)}`);

/** Decode one raw log into an engine event, or null if it is not one we track. */
export function decodeLog(log: RawLog, launch: Launch, ts: number): Ev | null {
  const base: Base = {
    block: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex)),
    txIndex: Number(BigInt(log.transactionIndex)),
    tx: log.transactionHash.toLowerCase() as Hex,
    ts,
  };
  const addr = log.address.toLowerCase();
  const t0 = log.topics[0];
  if (t0 === TOPIC.transfer && log.topics.length === 3) {
    const asset = addr === launch.token.toLowerCase() ? 'token' : addr === IMD.toLowerCase() ? 'imd' : null;
    if (!asset) return null;
    const [value] = decodeAbiParameters([{ type: 'uint256' }], log.data);
    return { ...base, kind: 'transfer', asset, from: topicAddr(log.topics[1]), to: topicAddr(log.topics[2]), value };
  }
  if (addr === POOL_MANAGER.toLowerCase() && log.topics[1]?.toLowerCase() === launch.poolId) {
    if (t0 === TOPIC.swap) {
      const [amount0, amount1, sqrtPriceX96] = decodeAbiParameters(
        [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
        log.data,
      );
      return { ...base, kind: 'swap', sender: topicAddr(log.topics[2]), amount0, amount1, sqrtPriceX96 };
    }
    if (t0 === TOPIC.initialize) {
      const [, , hooks, sqrtPriceX96] = decodeAbiParameters(
        [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
        log.data,
      );
      return {
        ...base,
        kind: 'init',
        currency0: topicAddr(log.topics[2]),
        currency1: topicAddr(log.topics[3]),
        hooks: getAddress(hooks),
        sqrtPriceX96,
      };
    }
    return null;
  }
  if (addr === launch.hook.toLowerCase()) {
    // Fields are read from topics+data in declaration order, so the decoding does not depend on
    // which parameters the deployed hook marks indexed.
    const words: Hex[] = [...log.topics.slice(1)];
    for (let i = 2; i < log.data.length; i += 64) words.push(`0x${log.data.slice(i, i + 64)}` as Hex);
    if (t0 === TOPIC.feeAccrued && words.length >= 4) {
      return {
        ...base,
        kind: 'fee',
        isSell: BigInt(words[0]) !== 0n,
        baseFeeImd: BigInt(words[1]),
        surchargeImd: BigInt(words[2]),
        imdLeg: BigInt(words[3]),
      };
    }
    if (t0 === TOPIC.swept && words.length >= 2) {
      return { ...base, kind: 'swept', amount: BigInt(words[0]), to: topicAddr(words[1]) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Transaction grouping and classification (pure)
// ---------------------------------------------------------------------------------------------

export interface TxGroup {
  tx: Hex;
  block: bigint;
  txIndex: number;
  ts: number;
  events: Ev[];
}

export function sortEvents(evs: Ev[]): Ev[] {
  return [...evs].sort((a, b) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex));
}

export function groupByTx(evs: Ev[]): TxGroup[] {
  const out: TxGroup[] = [];
  const byTx = new Map<string, TxGroup>();
  for (const e of sortEvents(evs)) {
    let g = byTx.get(e.tx);
    if (!g) {
      g = { tx: e.tx, block: e.block, txIndex: e.txIndex, ts: e.ts, events: [] };
      byTx.set(e.tx, g);
      out.push(g);
    }
    g.events.push(e);
  }
  return out;
}

export interface PoolOrder {
  imdIsCurrency0: boolean;
}

/** Currency order from the pool's Initialize log; never assumed. */
export function poolOrder(evs: Ev[], token: Address): PoolOrder {
  const init = evs.find((e) => e.kind === 'init');
  if (!init || init.kind !== 'init') throw new Error('Initialize log for the pool id not indexed yet');
  const c0 = init.currency0.toLowerCase();
  const c1 = init.currency1.toLowerCase();
  const imd = IMD.toLowerCase();
  const tok = token.toLowerCase();
  if (c0 === imd && c1 === tok) return { imdIsCurrency0: true };
  if (c1 === imd && c0 === tok) return { imdIsCurrency0: false };
  throw new Error(`pool currencies ${c0}/${c1} are not IMD/token`);
}

export interface TxClass {
  /** Tokens that left our pool on buy swaps (swapper-side positive delta). */
  tokensOut: bigint;
  /** IMD paid into buy swaps plus hook fees on buys. */
  costImd: bigint;
  feeAccrued: boolean;
  qualifying: boolean;
  /** Net token change per address in this tx (lowercase keys). */
  net: Map<string, bigint>;
  /** Addresses that sent tokens to a different address in this tx. */
  senders: Set<string>;
  observations: Observation[];
}

/**
 * v4 Swap amounts are the swapper's BalanceDelta: negative = paid into the pool, positive = taken
 * out. A buy of MONEYBACK has token delta > 0 and IMD delta < 0.
 */
export function classifyTx(g: TxGroup, order: PoolOrder): TxClass {
  let tokensOut = 0n;
  let imdIn = 0n;
  let fees = 0n;
  let feeAccrued = false;
  const net = new Map<string, bigint>();
  const senders = new Set<string>();
  const observations: Observation[] = [];
  for (const e of g.events) {
    if (e.kind === 'swap') {
      const imd = order.imdIsCurrency0 ? e.amount0 : e.amount1;
      const tok = order.imdIsCurrency0 ? e.amount1 : e.amount0;
      if (tok > 0n && imd < 0n) {
        tokensOut += tok;
        imdIn += -imd;
      }
      observations.push({
        ts: e.ts,
        block: e.block,
        logIndex: e.logIndex,
        priceX96: priceX96FromSqrt(e.sqrtPriceX96, order.imdIsCurrency0),
      });
    } else if (e.kind === 'fee') {
      feeAccrued = true;
      if (!e.isSell) fees += e.baseFeeImd + e.surchargeImd;
    } else if (e.kind === 'transfer' && e.asset === 'token') {
      const f = e.from.toLowerCase();
      const t = e.to.toLowerCase();
      if (f === t || e.value === 0n) continue;
      net.set(f, (net.get(f) ?? 0n) - e.value);
      net.set(t, (net.get(t) ?? 0n) + e.value);
      senders.add(f);
    }
  }
  return {
    tokensOut,
    costImd: imdIn + fees,
    feeAccrued,
    qualifying: tokensOut > 0n && feeAccrued,
    net,
    senders,
    observations,
  };
}

// ---------------------------------------------------------------------------------------------
// Wallet ledgers (pure, deterministic)
// ---------------------------------------------------------------------------------------------

export interface Buy {
  tx: Hex;
  ts: number;
  tokens: bigint; // qualifying tokens credited
  cost: bigint; // IMD basis for those tokens
}

export interface WalletLedger {
  address: string; // lowercase
  balance: bigint;
  qualTokens: bigint;
  qualCost: bigint;
  unqualifiedIn: bigint;
  buys: Buy[];
  disqualified: { tx: Hex; ts: number; reason: string } | null;
}

export interface Inflow {
  kind: 'sweep' | 'distributor';
  tx: Hex;
  logIndex: number;
  block: bigint;
  ts: number;
  amount: bigint;
}

export interface IndexState {
  wallets: Map<string, WalletLedger>;
  observations: Observation[];
  inflows: Inflow[];
  lastTs: number;
}

function ledgerOf(m: Map<string, WalletLedger>, a: string): WalletLedger {
  let w = m.get(a);
  if (!w) {
    w = { address: a, balance: 0n, qualTokens: 0n, qualCost: 0n, unqualifiedIn: 0n, buys: [], disqualified: null };
    m.set(a, w);
  }
  return w;
}

/**
 * Replays transactions in order and maintains wallet ledgers, price observations and payout-wallet
 * inflows. `advance(ts)` applies every transaction with timestamp <= ts, so one pass serves every
 * epoch in turn. `excluded` addresses never qualify (but their balances are tracked).
 */
export class Rebuilder {
  readonly state: IndexState = { wallets: new Map(), observations: [], inflows: [], lastTs: 0 };
  private readonly groups: TxGroup[];
  private readonly order: PoolOrder;
  private i = 0;

  constructor(
    evs: Ev[],
    private readonly launch: Launch,
    private readonly excluded: Set<string>,
  ) {
    this.order = poolOrder(evs, launch.token);
    this.groups = groupByTx(evs);
  }

  advance(uptoTs: number): IndexState {
    const payout = this.launch.payoutWallet.toLowerCase();
    const distributor = this.launch.distributor.toLowerCase();
    const { wallets, observations, inflows } = this.state;
    for (; this.i < this.groups.length && this.groups[this.i].ts <= uptoTs; this.i++) {
      const g = this.groups[this.i];
      this.state.lastTs = g.ts;
      const c = classifyTx(g, this.order);
      observations.push(...c.observations);
      for (const e of g.events) {
        if (e.kind === 'swept' && e.to.toLowerCase() === payout) {
          inflows.push({ kind: 'sweep', tx: e.tx, logIndex: e.logIndex, block: e.block, ts: e.ts, amount: e.amount });
        } else if (
          e.kind === 'transfer' &&
          e.asset === 'imd' &&
          e.from.toLowerCase() === distributor &&
          e.to.toLowerCase() === payout
        ) {
          inflows.push({ kind: 'distributor', tx: e.tx, logIndex: e.logIndex, block: e.block, ts: e.ts, amount: e.value });
        }
      }
      // Credit receivers in order of first appearance; qualifying tokens are capped at tokensOut.
      let budget = c.qualifying ? c.tokensOut : 0n;
      for (const [a, delta] of c.net) {
        const w = ledgerOf(wallets, a);
        w.balance += delta;
        if (c.senders.has(a) && !w.disqualified) {
          w.disqualified = { tx: g.tx, ts: g.ts, reason: 'balance decreased (sell or transfer out)' };
        }
        if (delta <= 0n) continue;
        const q = !this.excluded.has(a) && budget > 0n ? (delta < budget ? delta : budget) : 0n;
        if (q > 0n) {
          const cost = (c.costImd * q) / c.tokensOut;
          budget -= q;
          w.qualTokens += q;
          w.qualCost += cost;
          w.buys.push({ tx: g.tx, ts: g.ts, tokens: q, cost });
        }
        w.unqualifiedIn += delta - q;
      }
    }
    return this.state;
  }
}

export function rebuild(evs: Ev[], launch: Launch, excluded: Set<string>, uptoTs = Infinity): IndexState {
  return new Rebuilder(evs, launch, excluded).advance(uptoTs);
}

// ---------------------------------------------------------------------------------------------
// Persistence + follower
// ---------------------------------------------------------------------------------------------

export function evToJson(e: Ev): Record<string, unknown> {
  return JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
}
export function evFromJson(o: any): Ev {
  return JSON.parse(JSON.stringify(o), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as Ev;
}

export interface IndexFile {
  cursor: string; // last indexed block (decimal)
  events: Ev[];
}

export function loadIndex(dataDir: string, launch: Launch): IndexFile {
  const p = join(dataDir, 'index', 'events.json');
  if (!existsSync(p)) return { cursor: (launch.launchBlock - 1n).toString(), events: [] };
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return { cursor: raw.cursor, events: raw.events.map(evFromJson) };
}

export function saveIndex(dataDir: string, idx: IndexFile) {
  const dir = join(dataDir, 'index');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'events.json');
  writeFileSync(`${p}.tmp`, JSON.stringify({ cursor: idx.cursor, events: idx.events.map(evToJson) }));
  renameSync(`${p}.tmp`, p);
}

export class Indexer {
  idx: IndexFile;
  private codeCache: Record<string, boolean>;

  constructor(
    private readonly cfg: Config,
    private readonly chain: ChainReader,
  ) {
    this.idx = loadIndex(cfg.ops.dataDir, cfg.launch);
    const cp = join(cfg.ops.dataDir, 'index', 'code.json');
    this.codeCache = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')) : {};
  }

  get cursor(): bigint {
    return BigInt(this.idx.cursor);
  }

  /** Index up to the safe head (or `target`). Returns the new cursor. */
  async sync(target?: bigint, onProgress?: (to: bigint) => void): Promise<bigint> {
    const head = target ?? (await this.chain.safeHead());
    const { launch, rules } = this.cfg;
    const step = BigInt(this.cfg.rpc.logChunk) * 4n;
    const critical = gridCritical(launch.launchTs, rules.epochSeconds, rules.twapSeconds);
    while (this.cursor < head) {
      const from = this.cursor + 1n;
      const to = from + step - 1n < head ? from + step - 1n : head;
      const filters = [
        { address: launch.token, topics: [TOPIC.transfer] },
        { address: POOL_MANAGER, topics: [[TOPIC.swap, TOPIC.initialize], launch.poolId] },
        { address: launch.hook, topics: [[TOPIC.feeAccrued, TOPIC.swept]] },
        { address: IMD, topics: [TOPIC.transfer, null, pad(launch.payoutWallet.toLowerCase() as Hex)] },
      ] as const;
      const raws: RawLog[] = [];
      for (const f of filters) raws.push(...(await this.chain.getLogs(f as any, from, to)));
      const tsCache = new Map<string, number>();
      for (const r of raws) {
        const b = BigInt(r.blockNumber);
        let ts = r.blockTimestamp !== undefined ? Number(BigInt(r.blockTimestamp)) : tsCache.get(r.blockNumber);
        if (ts === undefined) {
          ts = await this.chain.timestamps.at(b, head, critical);
          tsCache.set(r.blockNumber, ts);
        }
        const e = decodeLog(r, launch, ts);
        if (e) this.idx.events.push(e);
      }
      this.idx.events = dedupe(this.idx.events);
      this.idx.cursor = to.toString();
      saveIndex(this.cfg.ops.dataDir, this.idx);
      this.chain.timestamps.save();
      onProgress?.(to);
    }
    return this.cursor;
  }

  /** Addresses with deployed code among `addrs` (cached; code never disappears in practice). */
  async contracts(addrs: string[]): Promise<Set<string>> {
    const p = join(this.cfg.ops.dataDir, 'index', 'code.json');
    for (const a of addrs) {
      if (this.codeCache[a] === undefined) {
        this.codeCache[a] = await this.chain.hasCode(a as Hex);
        mkdirSync(join(this.cfg.ops.dataDir, 'index'), { recursive: true });
        writeFileSync(p, JSON.stringify(this.codeCache)); // saved per address: progress survives rate limits
      }
    }
    return new Set(addrs.filter((a) => this.codeCache[a]));
  }
}

function dedupe(evs: Ev[]): Ev[] {
  const seen = new Set<string>();
  const out: Ev[] = [];
  for (const e of sortEvents(evs)) {
    const k = `${e.tx}:${e.logIndex}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}
