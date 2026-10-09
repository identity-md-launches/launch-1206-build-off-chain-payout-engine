// Recompute every drop from logs and diff against on-chain RoundPaid events.
//
//   npm run replay                         # from data/index (built by the rounds app), diff vs chain
//   npm run replay -- --fixture <file> --out <dir> [--expected <dir>]   # offline, from a log fixture
//
// A fixture is {"launch": {...launch.json...}, "uptoEpoch": n, "logs": [raw eth_getLogs entries with
// a "blockTimestamp" number]}. With --expected the written ledgers are compared byte-for-byte.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeEventLog, type Abi, type Hex } from 'viem';
import { TOPIC, defaultRoundPayoutAbi } from '../src/abi.js';
import { buildConfig, loadConfig, parseLaunch, type Config } from '../src/config.js';
import { decodeLog, loadIndex, type Ev } from '../src/indexer.js';
import { canonicalLedger, ledgerFileName, writeLedger, type Ledger } from '../src/ledger.js';
import { computeHistory, loadManualClaims, type History } from '../src/rounds.js';
import { ChainReader, type RawLog } from '../src/rpc.js';
import { readContracts, readProgress } from '../src/snapshot.js';

export interface Fixture {
  launch: Record<string, unknown>;
  uptoEpoch: number;
  contracts?: string[];
  logs: (RawLog & { blockTimestamp: number })[];
}

/** Pure replay of a log fixture with the given env knobs (defaults = product rules). */
export function replayFixture(fx: Fixture, env: Record<string, string> = {}): { cfg: Config; history: History } {
  const cfg = buildConfig(parseLaunch(fx.launch), { DATA_DIR: '.', ...env });
  const events = fx.logs.map((l) => decodeLog(l, cfg.launch, l.blockTimestamp)).filter((e): e is Ev => e !== null);
  const history = computeHistory({
    events,
    launch: cfg.launch,
    rules: cfg.rules,
    ops: cfg.ops,
    excluded: cfg.exclusions,
    contracts: new Set((fx.contracts ?? []).map((a) => a.toLowerCase())),
    uptoEpoch: fx.uptoEpoch,
  });
  return { cfg, history };
}

/** Byte-compare written ledgers with an expected directory. Returns mismatching file names. */
export function diffLedgers(ledgers: Ledger[], expectedDir: string): string[] {
  const bad: string[] = [];
  for (const l of ledgers) {
    const f = join(expectedDir, ledgerFileName(l.epochIndex));
    if (!existsSync(f) || readFileSync(f, 'utf8') !== canonicalLedger(l)) bad.push(ledgerFileName(l.epochIndex));
  }
  return bad;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fixture = arg('--fixture');
  if (fixture) {
    const fx = JSON.parse(readFileSync(resolve(fixture), 'utf8')) as Fixture;
    const { history } = replayFixture(fx);
    const out = resolve(arg('--out') ?? 'replay-out');
    mkdirSync(out, { recursive: true });
    for (const l of history.ledgers) writeLedger(out, l);
    console.log(`replayed ${history.epochs.length} epochs, ${history.ledgers.length} drops -> ${out}`);
    for (const e of history.epochs) console.log(`  epoch ${e.epochIndex}: pot=${e.book.pot} paid=${e.ledger?.paidTotal ?? 0n} hash=${e.ledgerHash ?? '-'}`);
    const expected = arg('--expected');
    if (expected) {
      const bad = diffLedgers(history.ledgers, resolve(expected));
      console.log(bad.length ? `MISMATCH: ${bad.join(', ')}` : 'all ledgers match byte-for-byte');
      process.exit(bad.length ? 1 : 0);
    }
    return;
  }

  // Live: recompute from the local index and compare with RoundPaid on chain.
  const cfg = loadConfig();
  const progress = readProgress(cfg.ops.dataDir);
  const idx = loadIndex(cfg.ops.dataDir, cfg.launch);
  if (!progress || idx.events.length === 0) throw new Error('no index yet: run `npm run rounds:once` first');
  const history = computeHistory({
    events: idx.events,
    launch: cfg.launch,
    rules: cfg.rules,
    ops: cfg.ops,
    excluded: cfg.exclusions,
    contracts: readContracts(cfg.ops.dataDir),
    uptoEpoch: progress.uptoEpoch,
    manualClaims: loadManualClaims(cfg.ops.dataDir),
  });
  const out = resolve(arg('--out') ?? join(cfg.ops.dataDir, 'replay'));
  for (const l of history.ledgers) writeLedger(out, l);

  const chain = new ChainReader({ rpc: cfg.rpc, cacheDir: join(cfg.ops.dataDir, 'cache') });
  const abi = (cfg.launch.roundPayoutAbi ?? defaultRoundPayoutAbi) as Abi;
  const head = await chain.safeHead();
  const logs = await chain.getLogs({ address: cfg.launch.roundPayout, topics: [TOPIC.roundPaid] }, cfg.launch.launchBlock, head);
  const onchain = new Map<string, Hex>();
  for (const lg of logs) {
    try {
      const d = decodeEventLog({ abi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as { args: any };
      onchain.set(BigInt(d.args.roundId).toString(), d.args.ledgerHash as Hex);
    } catch {
      console.log(`undecodable RoundPaid log in ${lg.transactionHash}`);
    }
  }
  let mismatches = 0;
  const expected = new Set<string>();
  for (const e of history.epochs) {
    for (const c of e.ledger?.chunks ?? []) {
      const id = c.roundId.toString();
      expected.add(id);
      const got = onchain.get(id);
      const status = got === undefined ? 'NOT PAID ON CHAIN' : got.toLowerCase() === e.ledgerHash ? 'ok' : `HASH MISMATCH (chain ${got})`;
      if (status !== 'ok') mismatches++;
      console.log(`round ${id} (epoch ${e.epochIndex}): ${status}`);
    }
  }
  for (const id of onchain.keys()) {
    if (!expected.has(id)) {
      mismatches++;
      console.log(`round ${id}: paid on chain but not produced by replay`);
    }
  }
  console.log(`${history.ledgers.length} drops replayed into ${out}; ${mismatches} discrepancies`);
  process.exit(mismatches ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
