// Snapshot: recomputes the public view from the index (same deterministic code as the rounds app)
// and writes data/*.json: token, status, treasury, rounds, chart, leaderboard, wallets (ledgers are
// written by the rounds app). Prices refresh every PRICE_INTERVAL_MS; the last good price is kept.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { poolManagerAbi } from './abi.js';
import { IMD, POOL_MANAGER, epochBoundary, type Config } from './config.js';
import { loadIndex, type Ev } from './indexer.js';
import { computeHistory, estimateNextDrop, loadManualClaims, type History, type HistoryInput } from './rounds.js';
import type { ChainReader } from './rpc.js';
import { priceX96FromSqrt, spotAt } from './twap.js';

export interface Prices {
  imdUsd: number | null;
  ethUsd: number | null;
  tokenUsd: number | null;
  source: string;
  at: string;
}

export interface Progress {
  indexedBlock: string;
  indexedTs: number;
  uptoEpoch: number;
}

const Q96 = 2 ** 96;

export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
}

export function writeData(dataDir: string, name: string, v: unknown) {
  mkdirSync(dataDir, { recursive: true });
  const p = join(dataDir, name);
  writeFileSync(`${p}.tmp`, toJson(v));
  renameSync(`${p}.tmp`, p);
}

export function readProgress(dataDir: string): Progress | null {
  const p = join(dataDir, 'state', 'progress.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function readContracts(dataDir: string): Set<string> {
  const p = join(dataDir, 'index', 'code.json');
  if (!existsSync(p)) return new Set();
  const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, boolean>;
  return new Set(Object.keys(m).filter((k) => m[k]));
}

/** Rebuild the deterministic history from what the rounds app has indexed. */
export function loadHistory(cfg: Config): { hist: History; input: HistoryInput; progress: Progress; events: Ev[] } | null {
  const progress = readProgress(cfg.ops.dataDir);
  if (!progress) return null;
  const idx = loadIndex(cfg.ops.dataDir, cfg.launch);
  if (!idx.events.some((e) => e.kind === 'init')) return null;
  const input: HistoryInput = {
    events: idx.events,
    launch: cfg.launch,
    rules: cfg.rules,
    ops: cfg.ops,
    excluded: cfg.exclusions,
    contracts: readContracts(cfg.ops.dataDir),
    uptoEpoch: progress.uptoEpoch,
    manualClaims: loadManualClaims(cfg.ops.dataDir),
  };
  return { hist: computeHistory(input), input, progress, events: idx.events };
}

/** sqrtPriceX96 of a v4 pool via PoolManager.extsload(keccak256(poolId, POOLS_SLOT=6)). */
export async function poolSqrtPrice(chain: ChainReader, poolId: Hex): Promise<bigint> {
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
  const word = await chain.client().readContract({
    address: POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'extsload',
    args: [slot],
  });
  return BigInt(word) & ((1n << 160n) - 1n);
}

async function ethUsdFromApis(): Promise<{ v: number; src: string } | null> {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json();
    const v = Number(j?.ethereum?.usd);
    if (v > 0) return { v, src: 'coingecko' };
  } catch {
    /* fall through */
  }
  try {
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${weth}`, { signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json();
    const pairs = (j?.pairs ?? []).filter(
      (p: any) => p.baseToken?.address?.toLowerCase() === weth.toLowerCase() && Number(p.priceUsd) > 0,
    );
    pairs.sort((a: any, b: any) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
    if (pairs[0]) return { v: Number(pairs[0].priceUsd), src: 'dexscreener' };
  } catch {
    /* none */
  }
  return null;
}

/**
 * IMD/USD = ETH/USD divided by IMD-per-ETH from the public ETH/IMD pool (native ETH is currency0);
 * MONEYBACK/USD = IMD per MONEYBACK (our pool spot) * IMD/USD. Both tokens are 18 decimals.
 */
export async function fetchPrices(cfg: Config, chain: ChainReader, events: Ev[], last: Prices | null): Promise<Prices> {
  const at = new Date().toISOString();
  try {
    const eth = await ethUsdFromApis();
    if (!eth) throw new Error('no ETH/USD source answered');
    let imdUsd: number | null = null;
    if (cfg.launch.imdEthPoolId) {
      const sp = Number(await poolSqrtPrice(chain, cfg.launch.imdEthPoolId)) / Q96;
      const imdPerEth = sp * sp;
      if (imdPerEth > 0) imdUsd = eth.v / imdPerEth;
    }
    const spot = spotAt(
      events
        .filter((e) => e.kind === 'swap')
        .map((e: any) => {
          const init = events.find((x) => x.kind === 'init') as any;
          return {
            ts: e.ts,
            block: e.block,
            logIndex: e.logIndex,
            priceX96: priceX96FromSqrt(e.sqrtPriceX96, init.currency0.toLowerCase() === IMD.toLowerCase()),
          };
        }),
      Infinity,
    );
    const tokenUsd = spot !== null && imdUsd !== null ? (Number(spot) / Q96) * imdUsd : null;
    return { imdUsd, ethUsd: eth.v, tokenUsd, source: `RH ETH/IMD pool spot + ${eth.src}`, at };
  } catch (e) {
    if (last) return last;
    return { imdUsd: null, ethUsd: null, tokenUsd: null, source: `unavailable: ${(e as Error).message}`, at };
  }
}

/** Write every public data file from a computed history. */
export function writeSnapshot(cfg: Config, h: NonNullable<ReturnType<typeof loadHistory>>, prices: Prices | null, pending: bigint) {
  const { hist, input, progress } = h;
  const dir = cfg.ops.dataDir;
  const L = cfg.launch;
  const execPath = join(dir, 'state', 'exec.json');
  const exec = existsSync(execPath) ? JSON.parse(readFileSync(execPath, 'utf8')) : { drops: {} };
  const nextIndex = progress.uptoEpoch + 1;
  const estimate = estimateNextDrop(hist, input, Math.floor(Date.now() / 1000), pending);

  writeData(dir, 'token.json', {
    chainId: L.chainId,
    token: L.token,
    imd: IMD,
    poolManager: POOL_MANAGER,
    poolId: L.poolId,
    hook: L.hook,
    router: L.router,
    roundPayout: L.roundPayout,
    payoutWallet: L.payoutWallet,
    distributor: L.distributor,
    launchBlock: L.launchBlock,
    launchTs: L.launchTs,
    launchTx: L.launchTx,
    rules: cfg.rules,
  });
  writeData(dir, 'status.json', {
    updatedAt: new Date().toISOString(),
    executor: cfg.exec.mode,
    paused: existsSync(cfg.ops.pauseFile),
    indexedBlock: progress.indexedBlock,
    indexedTs: progress.indexedTs,
    lastClosedEpoch: progress.uptoEpoch,
    nextBoundaryTs: epochBoundary(cfg, nextIndex),
    pendingHookFees: pending,
    nextDropEstimate: estimate ? { pot: estimate.pot, paidTotal: estimate.paidTotal, payees: estimate.chunks.flatMap((c) => c.payees).length } : null,
    prices,
    payoutAsset: 'IMD',
  });
  writeData(dir, 'treasury.json', {
    ...hist.treasury,
    note: 'pouch = hook sweeps + 25% of distributor receipts; team = 75% of distributor receipts (shown, never paid)',
  });
  writeData(
    dir,
    'rounds.json',
    hist.epochs.map((e) => ({
      epochIndex: e.epochIndex,
      boundaryTs: e.boundaryTs,
      closeX96: e.closeX96,
      pot: e.book.pot,
      paid: e.ledger?.paidTotal ?? 0n,
      payees: e.ledger ? e.ledger.entries.filter((x) => x.amount > 0n).length : 0,
      eligible: e.eligible,
      underwater: e.underwater,
      ledgerHash: e.ledgerHash,
      roundIds: e.ledger?.chunks.map((c) => c.roundId) ?? [],
      execution: exec.drops[e.epochIndex]?.status ?? (e.ledger ? (cfg.exec.mode === 'live' ? 'pending' : 'dry-run') : null),
    })),
  );
  writeData(
    dir,
    'chart.json',
    hist.epochs.map((e) => ({
      t: e.boundaryTs,
      close: e.closeX96 === null ? null : Number(e.closeX96) / Q96,
      pot: e.book.pot,
      paid: e.ledger?.paidTotal ?? 0n,
    })),
  );
  const wallets = hist.statuses.map((s) => ({ ...s, paid: hist.paidSoFar.get(s.address) ?? 0n }));
  writeData(dir, 'wallets.json', wallets);
  writeData(
    dir,
    'leaderboard.json',
    [...wallets]
      .filter((w) => w.paid > 0n || w.loss > 0n)
      .sort((a, b) => (b.paid > a.paid ? 1 : b.paid < a.paid ? -1 : b.loss > a.loss ? 1 : -1))
      .slice(0, 100),
  );
}
