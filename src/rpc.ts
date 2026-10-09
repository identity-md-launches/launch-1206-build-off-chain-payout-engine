// JSON-RPC access: round-robin with backoff, a dedicated getLogs endpoint, a pinned priority endpoint
// for payout rounds, chunked getLogs that bisects refused ranges, a conservative head (lowest across
// endpoints minus followMargin), block-timestamp interpolation between anchor headers, and a disk cache.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, custom, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import type { RpcCfg } from './config.js';

export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed?: boolean;
  /** Returned by some nodes (Robinhood Chain's public RPC does); exact when present. */
  blockTimestamp?: Hex | number;
}

export interface LogFilter {
  address: Hex | Hex[];
  topics: (Hex | Hex[] | null)[];
}

export type Fetcher = (url: string, body: unknown) => Promise<any>;

const defaultFetcher: Fetcher = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${redact(url)}`, res.status);
  return res.json();
};

export class RpcError extends Error {
  constructor(
    msg: string,
    readonly code?: number,
  ) {
    super(msg);
  }
}

/** Strip API keys from URLs before they reach a log line. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<rpc>';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RpcPool {
  private next = 0;
  private id = 1;
  private cooldown = new Map<string, number>();
  private lastCall = new Map<string, number>();

  constructor(
    readonly urls: string[],
    private readonly cfg: Pick<RpcCfg, 'maxRetries' | 'backoffMs'> & { minIntervalMs?: number },
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {
    if (urls.length === 0) throw new Error('RpcPool needs at least one URL');
  }

  private pick(): string {
    const now = Date.now();
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(this.next + i) % this.urls.length];
      if ((this.cooldown.get(url) ?? 0) <= now) {
        this.next = (this.next + i + 1) % this.urls.length;
        return url;
      }
    }
    this.next = (this.next + 1) % this.urls.length;
    return this.urls[this.next];
  }

  /** One call on one specific URL, no retries. Calls to one URL are spaced by minIntervalMs. */
  async callOn<T = any>(url: string, method: string, params: unknown[]): Promise<T> {
    const gap = this.cfg.minIntervalMs ?? 0;
    if (gap > 0) {
      const at = Math.max(Date.now(), (this.lastCall.get(url) ?? 0) + gap);
      this.lastCall.set(url, at);
      if (at > Date.now()) await sleep(at - Date.now());
    }
    const json = await this.fetcher(url, { jsonrpc: '2.0', id: this.id++, method, params });
    if (json?.error) throw new RpcError(String(json.error.message ?? 'rpc error'), json.error.code);
    return json.result as T;
  }

  /** Round-robin with exponential backoff; a failing endpoint is cooled down. */
  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const url = this.pick();
      try {
        return await this.callOn<T>(url, method, params);
      } catch (e) {
        lastErr = e;
        if (isRangeRefusal(e) || isRevert(e)) throw e; // deterministic: retrying elsewhere will not help
        this.cooldown.set(url, Date.now() + this.cfg.backoffMs * 2 ** attempt);
        await sleep(Math.min(this.cfg.backoffMs * 2 ** attempt, 15_000));
      }
    }
    throw lastErr;
  }

  /** viem PublicClient whose requests go through this pool. */
  client(): PublicClient {
    return createPublicClient({
      transport: custom({ request: ({ method, params }) => this.call(method, params ?? []) }),
    }) as PublicClient;
  }

  /** Lowest head across all endpoints (a lagging node must never be read past its head). */
  async lowestHead(): Promise<bigint> {
    const heads = await Promise.all(
      this.urls.map((u) =>
        this.callOn<Hex>(u, 'eth_blockNumber', []).then(
          (h) => BigInt(h),
          () => null,
        ),
      ),
    );
    const ok = heads.filter((h): h is bigint => h !== null);
    if (ok.length === 0) throw new RpcError('no endpoint answered eth_blockNumber');
    return ok.reduce((a, b) => (a < b ? a : b));
  }
}

export function isRevert(e: unknown): boolean {
  const code = (e as RpcError)?.code;
  return code === 3 || /execution reverted|revert/i.test(String((e as Error)?.message ?? e));
}

export function isRangeRefusal(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return /range|too many|limit|exceed|response size|query returned more|10000|block range/.test(m);
}

/** On-disk JSON cache (atomic writes). */
export class DiskCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(key: string) {
    return join(this.dir, `${keccak256(toHex(key)).slice(2, 34)}.json`);
  }
  get<T>(key: string): T | undefined {
    const p = this.path(key);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }
  set(key: string, value: unknown) {
    const p = this.path(key);
    writeFileSync(`${p}.tmp`, JSON.stringify(value));
    renameSync(`${p}.tmp`, p);
  }
}

export interface ChainReaderOpts {
  rpc: RpcCfg;
  cacheDir?: string;
  fetcher?: Fetcher;
}

/**
 * Everything the indexer and executor read from chain. `pinned()` returns a reader whose every
 * request goes to RPC_PRIORITY_URL, used for all reads inside a payout round.
 */
export class ChainReader {
  readonly pool: RpcPool;
  readonly logsPool: RpcPool;
  readonly priority?: RpcPool;
  private readonly cache?: DiskCache;
  readonly timestamps: Timestamps;

  constructor(private readonly opts: ChainReaderOpts) {
    const { rpc } = opts;
    this.pool = new RpcPool(rpc.urls, rpc, opts.fetcher);
    this.logsPool = rpc.logsUrl ? new RpcPool([rpc.logsUrl], rpc, opts.fetcher) : this.pool;
    this.priority = rpc.priorityUrl ? new RpcPool([rpc.priorityUrl], rpc, opts.fetcher) : undefined;
    this.cache = opts.cacheDir ? new DiskCache(opts.cacheDir) : undefined;
    this.timestamps = new Timestamps((b) => this.exactTimestamp(b), rpc.anchorSpacing, opts.cacheDir);
  }

  client(): PublicClient {
    return this.pool.client();
  }

  /** Reader pinned to the priority node (falls back to the pool when none is configured). */
  pinned(): PublicClient {
    return (this.priority ?? this.pool).client();
  }

  async safeHead(): Promise<bigint> {
    const h = await this.pool.lowestHead();
    const m = BigInt(this.opts.rpc.followMargin);
    return h > m ? h - m : 0n;
  }

  async exactTimestamp(block: bigint): Promise<number> {
    const b = await this.pool.call<{ timestamp: Hex } | null>('eth_getBlockByNumber', [toHex(block), false]);
    if (!b) throw new RpcError(`block ${block} not found`);
    return Number(BigInt(b.timestamp));
  }

  /** getLogs over [from, to] in chunks; a refused chunk is bisected until it passes. Sorted output. */
  async getLogs(filter: LogFilter, from: bigint, to: bigint): Promise<RawLog[]> {
    const out: RawLog[] = [];
    const chunk = BigInt(this.opts.rpc.logChunk);
    for (let a = from; a <= to; a += chunk) {
      const b = a + chunk - 1n < to ? a + chunk - 1n : to;
      out.push(...(await this.getLogsRange(filter, a, b)));
    }
    return out.sort(cmpLog);
  }

  private async getLogsRange(filter: LogFilter, a: bigint, b: bigint): Promise<RawLog[]> {
    const key = `logs:${JSON.stringify(filter)}:${a}:${b}`;
    const hit = this.cache?.get<RawLog[]>(key);
    if (hit) return hit;
    try {
      const logs = await this.logsPool.call<RawLog[]>('eth_getLogs', [
        { address: filter.address, topics: filter.topics, fromBlock: toHex(a), toBlock: toHex(b) },
      ]);
      const clean = logs.filter((l) => !l.removed);
      this.cache?.set(key, clean); // only ranges at or below the safe head are ever requested
      return clean;
    } catch (e) {
      if (a === b) throw e;
      const mid = (a + b) / 2n;
      return [...(await this.getLogsRange(filter, a, mid)), ...(await this.getLogsRange(filter, mid + 1n, b))];
    }
  }

  async getReceipt(hash: Hex): Promise<any> {
    return this.pool.call('eth_getTransactionReceipt', [hash]);
  }

  async getTx(hash: Hex): Promise<any> {
    return this.pool.call('eth_getTransactionByHash', [hash]);
  }

  async hasCode(address: Hex): Promise<boolean> {
    const code = await this.pool.call<Hex>('eth_getCode', [address, 'latest']);
    return !!code && code !== '0x';
  }
}

export function cmpLog(x: RawLog, y: RawLog): number {
  const bx = BigInt(x.blockNumber);
  const by = BigInt(y.blockNumber);
  if (bx !== by) return bx < by ? -1 : 1;
  return Number(BigInt(x.logIndex) - BigInt(y.logIndex));
}

/**
 * Block timestamps from anchor headers every `spacing` blocks, linearly interpolated in between.
 * When an interpolated bracket straddles a critical instant (an epoch boundary or TWAP window start)
 * the exact header is fetched, so the side of the boundary a block falls on is never guessed.
 */
export class Timestamps {
  private known = new Map<bigint, number>();
  private exact = new Set<bigint>();
  private dirty = false;

  constructor(
    private readonly fetchExact: (b: bigint) => Promise<number>,
    private readonly spacing: number,
    private readonly cacheDir?: string,
  ) {
    if (cacheDir && existsSync(this.file())) {
      const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, number>;
      for (const [k, v] of Object.entries(raw)) {
        this.known.set(BigInt(k), v);
        this.exact.add(BigInt(k));
      }
    }
  }

  private file() {
    return join(this.cacheDir!, 'headers.json');
  }

  private async header(b: bigint): Promise<number> {
    const k = this.known.get(b);
    if (k !== undefined) return k;
    const t = await this.fetchExact(b);
    this.known.set(b, t);
    this.exact.add(b);
    this.dirty = true;
    return t;
  }

  /**
   * Timestamp for `block`. `isCritical(lo, hi)` says whether an instant the engine cares about lies
   * in (lo, hi]; if so the exact header is used. `head` caps the upper anchor.
   */
  async at(block: bigint, head: bigint, isCritical: (lo: number, hi: number) => boolean): Promise<number> {
    if (this.exact.has(block)) return this.known.get(block)!;
    const s = BigInt(this.spacing);
    const lo = (block / s) * s;
    let hi = lo + s;
    if (hi > head) hi = head;
    if (lo === block || hi <= block) return this.header(block);
    const [tLo, tHi] = [await this.header(lo), await this.header(hi)];
    if (tLo !== tHi && isCritical(tLo, tHi)) return this.header(block);
    return tLo + Math.floor(((tHi - tLo) * Number(block - lo)) / Number(hi - lo));
  }

  save() {
    if (!this.cacheDir || !this.dirty) return;
    const obj: Record<string, number> = {};
    for (const b of this.exact) obj[b.toString()] = this.known.get(b)!;
    writeFileSync(`${this.file()}.tmp`, JSON.stringify(obj));
    renameSync(`${this.file()}.tmp`, this.file());
    this.dirty = false;
  }
}

/** Critical-instant predicate for the epoch grid: every boundary B and every TWAP start B - twap. */
export function gridCritical(launchTs: number, epochSeconds: number, twapSeconds: number) {
  const hits = (lo: number, hi: number, offset: number) => {
    // smallest grid point g = launchTs + k*epoch - offset with g > lo; critical if g <= hi
    const k = Math.floor((lo + offset - launchTs) / epochSeconds) + 1;
    return launchTs + k * epochSeconds - offset <= hi;
  };
  return (lo: number, hi: number) => hits(lo, hi, 0) || hits(lo, hi, twapSeconds);
}
