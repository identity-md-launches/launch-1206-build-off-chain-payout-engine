// Configuration: launch.json (on-chain addresses discovered at launch) + environment knobs.
// Only IMD, the PoolManager and the dead address are hardcoded; everything else comes from launch.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, isAddress, type Abi, type Address, type Hex } from 'viem';

export const CHAIN_ID = 4663;
export const IMD: Address = '0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127';
export const POOL_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
export const DEAD: Address = '0x000000000000000000000000000000000000dEaD';

export interface DistributorTrigger {
  /** Human-readable function signature, e.g. "function release()". */
  signature: string;
  args?: unknown[];
}

export interface Launch {
  chainId: number;
  token: Address;
  poolId: Hex;
  hook: Address;
  distributor: Address;
  router: Address;
  roundPayout: Address;
  payoutWallet: Address;
  deployer: Address;
  factory: Address;
  launchBlock: bigint;
  launchTs: number;
  launchTx: Hex;
  /** Public ETH/IMD v4 pool id used for the IMD/USD price (optional). */
  imdEthPoolId?: Hex;
  /** How to trigger the launch Merkle distributor so the 1% LP share is realised (optional). */
  distributorTrigger?: DistributorTrigger;
  /** RoundPayout ABI as shipped with launch.json; a built-in ABI is used when absent. */
  roundPayoutAbi?: Abi;
  /** Extra excluded addresses (merged with EXCLUDE_ADDRESSES from env). */
  exclude?: Address[];
}

export interface Rules {
  epochSeconds: number;
  twapSeconds: number;
  /** Inflows up to boundary + grace count toward that drop (the sweep runs right after the boundary). */
  claimGraceSeconds: number;
  minBuy: bigint; // IMD wei
  minPayout: bigint; // IMD wei
  maxRoundRatio: [bigint, bigint]; // numerator, denominator (1/3)
  maxPayoutRatio: [bigint, bigint]; // 1/1 = made whole
  weightLossExp: number; // a
  weightPctExp: number; // b
  pouchShareOfDistributor: [bigint, bigint]; // 25% of each distributor receipt
  maxRecipientsPerTx: number;
}

export interface Ops {
  opsSkimFraction: [bigint, bigint];
  dexReserveQuote: bigint; // IMD wei, one-time
  maxRoundPayoutQuote: bigint; // IMD wei; a drop above this is refused
  dataDir: string;
  pauseFile: string;
  apiPort: number;
  apiHost: string;
  telegramToken?: string;
  telegramChatId?: string;
  heartbeatMinutes: number;
  priceIntervalMs: number;
  stallMinutes: number;
}

export interface Exec {
  mode: 'dry-run' | 'live';
  confirmationBlocks: number;
  txTimeoutMs: number;
  maxLegRetries: number;
  fundingProofAttempts: number;
  fundingProofDelayMs: number;
}

export interface RpcCfg {
  urls: string[];
  logsUrl?: string;
  priorityUrl?: string;
  pollMs: number;
  followMargin: number;
  anchorSpacing: number;
  logChunk: number;
  maxRetries: number;
  backoffMs: number;
  minIntervalMs: number;
}

export interface Config {
  launch: Launch;
  rules: Rules;
  ops: Ops;
  exec: Exec;
  rpc: RpcCfg;
  exclusions: Set<string>; // lowercase
}

type Env = Record<string, string | undefined>;

/** Parse a decimal IMD amount ("1.5") into wei. */
export function parseUnits18(v: string): bigint {
  const s = v.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal amount: ${v}`);
  const [i, f = ''] = s.split('.');
  if (f.length > 18) throw new Error(`too many decimals: ${v}`);
  return BigInt(i) * 10n ** 18n + BigInt(f.padEnd(18, '0'));
}

/** Parse a fraction given as "1/3", "0.25" or "25%" into [num, den]. */
export function parseFraction(v: string): [bigint, bigint] {
  const s = v.trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/').map((x) => BigInt(x.trim()));
    if (d === 0n) throw new Error(`bad fraction ${v}`);
    return [n, d];
  }
  if (s.endsWith('%')) return reduce(parseUnits18(s.slice(0, -1)), 100n * 10n ** 18n);
  return reduce(parseUnits18(s), 10n ** 18n);
}

function reduce(n: bigint, d: bigint): [bigint, bigint] {
  const g = gcd(n, d) || 1n;
  return [n / g, d / g];
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) {
    throw new Error(`launch.json: ${field} must be an address (got ${JSON.stringify(v)})`);
  }
  return getAddress(v);
}

export function parseLaunch(raw: any): Launch {
  const poolId = String(raw.poolId ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new Error('launch.json: poolId must be a bytes32 hex');
  const launchTx = String(raw.launchTx ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(launchTx)) throw new Error('launch.json: launchTx must be a tx hash');
  const chainId = Number(raw.chainId ?? CHAIN_ID);
  if (chainId !== CHAIN_ID) throw new Error(`launch.json: chainId ${chainId} is not Robinhood Chain ${CHAIN_ID}`);
  const launchTs = Number(raw.launchTs);
  if (!Number.isInteger(launchTs) || launchTs <= 0) throw new Error('launch.json: launchTs must be a unix timestamp');
  return {
    chainId,
    token: addr(raw.token, 'token'),
    poolId: poolId.toLowerCase() as Hex,
    hook: addr(raw.hook, 'hook'),
    distributor: addr(raw.distributor, 'distributor'),
    router: addr(raw.router, 'router'),
    roundPayout: addr(raw.roundPayout, 'roundPayout'),
    payoutWallet: addr(raw.payoutWallet, 'payoutWallet'),
    deployer: addr(raw.deployer, 'deployer'),
    factory: addr(raw.factory, 'factory'),
    launchBlock: BigInt(raw.launchBlock),
    launchTs,
    launchTx: launchTx.toLowerCase() as Hex,
    imdEthPoolId: raw.imdEthPoolId ? (String(raw.imdEthPoolId).toLowerCase() as Hex) : undefined,
    distributorTrigger: raw.distributorTrigger,
    roundPayoutAbi: raw.roundPayoutAbi,
    exclude: (raw.exclude ?? []).map((a: unknown, i: number) => addr(a, `exclude[${i}]`)),
  };
}

const num = (env: Env, k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const str = (env: Env, k: string, d: string) => (env[k] !== undefined && env[k] !== '' ? env[k]! : d);

export function buildConfig(launch: Launch, env: Env = process.env): Config {
  const urls = str(env, 'RPC_URLS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = str(env, 'EXECUTOR', 'dry-run');
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`EXECUTOR must be dry-run or live (got ${mode})`);
  const dataDir = resolve(str(env, 'DATA_DIR', 'data'));
  const cfg: Config = {
    launch,
    rules: {
      epochSeconds: num(env, 'EPOCH_SECONDS', 900),
      twapSeconds: num(env, 'TWAP_SECONDS', 180),
      claimGraceSeconds: num(env, 'CLAIM_GRACE_SECONDS', 120),
      minBuy: parseUnits18(str(env, 'MIN_BUY_IMD', '0')),
      minPayout: parseUnits18(str(env, 'MIN_PAYOUT_IMD', '0')),
      maxRoundRatio: parseFraction(str(env, 'MAX_ROUND_RATIO', '1/3')),
      maxPayoutRatio: parseFraction(str(env, 'MAX_PAYOUT_RATIO', '1')),
      weightLossExp: num(env, 'WEIGHT_LOSS_EXP', 1),
      weightPctExp: num(env, 'WEIGHT_PCT_EXP', 0),
      pouchShareOfDistributor: parseFraction(str(env, 'DISTRIBUTOR_POUCH_SHARE', '1/4')),
      maxRecipientsPerTx: num(env, 'MAX_RECIPIENTS_PER_TX', 200),
    },
    ops: {
      opsSkimFraction: parseFraction(str(env, 'OPS_SKIM_FRACTION', '0')),
      dexReserveQuote: parseUnits18(str(env, 'DEX_RESERVE_QUOTE', '0')),
      maxRoundPayoutQuote: parseUnits18(str(env, 'MAX_ROUND_PAYOUT_QUOTE', '1000000')),
      dataDir,
      pauseFile: resolve(str(env, 'PAUSE_FILE', `${dataDir}/PAUSE`)),
      apiPort: num(env, 'API_PORT', 8787),
      apiHost: str(env, 'API_HOST', '127.0.0.1'),
      telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
      telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
      heartbeatMinutes: num(env, 'HEARTBEAT_MINUTES', 60),
      priceIntervalMs: num(env, 'PRICE_INTERVAL_MS', 60_000),
      stallMinutes: num(env, 'STALL_MINUTES', 30),
    },
    exec: {
      mode,
      confirmationBlocks: num(env, 'CONFIRMATION_BLOCKS', 5),
      txTimeoutMs: num(env, 'TX_TIMEOUT_MS', 120_000),
      maxLegRetries: num(env, 'MAX_LEG_RETRIES', 3),
      fundingProofAttempts: num(env, 'FUNDING_PROOF_ATTEMPTS', 20),
      fundingProofDelayMs: num(env, 'FUNDING_PROOF_DELAY_MS', 1500),
    },
    rpc: {
      urls,
      logsUrl: env.RPC_LOGS_URL || undefined,
      priorityUrl: env.RPC_PRIORITY_URL || undefined,
      pollMs: num(env, 'VIEM_POLL_MS', 750),
      followMargin: num(env, 'FOLLOW_MARGIN', 20),
      anchorSpacing: num(env, 'ANCHOR_SPACING', 100),
      logChunk: num(env, 'LOG_CHUNK', 50_000),
      maxRetries: num(env, 'RPC_MAX_RETRIES', 6),
      backoffMs: num(env, 'RPC_BACKOFF_MS', 500),
      minIntervalMs: num(env, 'RPC_MIN_INTERVAL_MS', 100),
    },
    exclusions: new Set(),
  };
  const extra = str(env, 'EXCLUDE_ADDRESSES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => addr(a, 'EXCLUDE_ADDRESSES'));
  for (const a of [
    launch.deployer,
    launch.factory,
    launch.distributor,
    POOL_MANAGER,
    launch.hook,
    launch.router,
    launch.roundPayout,
    launch.payoutWallet,
    DEAD,
    '0x0000000000000000000000000000000000000000',
    ...(launch.exclude ?? []),
    ...extra,
  ]) {
    cfg.exclusions.add(a.toLowerCase());
  }
  return cfg;
}

export function loadConfig(env: Env = process.env): Config {
  const path = resolve(str(env, 'LAUNCH_JSON', 'launch.json'));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message} (copy launch.example.json, or run npm run discover)`);
  }
  const cfg = buildConfig(parseLaunch(raw), env);
  if (cfg.rpc.urls.length === 0) throw new Error('RPC_URLS is empty');
  return cfg;
}

/** Epoch index for a timestamp; epoch k closes at launchTs + (k+1)*epochSeconds. */
export function epochBoundary(cfg: Pick<Config, 'launch' | 'rules'>, epochIndex: number): number {
  return cfg.launch.launchTs + (epochIndex + 1) * cfg.rules.epochSeconds;
}
export function lastClosedEpoch(cfg: Pick<Config, 'launch' | 'rules'>, nowTs: number): number {
  return Math.floor((nowTs - cfg.launch.launchTs) / cfg.rules.epochSeconds) - 1;
}
