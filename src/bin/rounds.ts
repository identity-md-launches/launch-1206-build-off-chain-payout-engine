// pm2 app "rounds": in-process indexer + per-epoch rounds + executor (dry-run unless EXECUTOR=live).
// `--once` runs a single tick, prints the latest drop and the next epoch's would-be payouts, and exits.
import { join } from 'node:path';
import { Alerts } from '../alerts.js';
import { loadConfig } from '../config.js';
import { Executor, liveChainOps } from '../executor.js';
import { Fees } from '../fees.js';
import { Indexer } from '../indexer.js';
import type { Ledger } from '../ledger.js';
import { acquireLock } from '../lock.js';
import { fmtImd, makeLog } from '../log.js';
import { estimateNextDrop, RoundRunner } from '../rounds.js';
import { ChainReader } from '../rpc.js';
import { writeData } from '../snapshot.js';
import { Signer } from '../wallet.js';

const log = makeLog('rounds');
const once = process.argv.includes('--once');
const cfg = loadConfig();
acquireLock(join(cfg.ops.dataDir, 'state', 'writer.lock'));
const chain = new ChainReader({ rpc: cfg.rpc, cacheDir: join(cfg.ops.dataDir, 'cache') });
const alerts = new Alerts(cfg.ops);
const signer = cfg.exec.mode === 'live' ? new Signer(cfg) : null;
const indexer = new Indexer(cfg, chain);
const fees = new Fees(cfg, chain, signer, log);
const executor = signer ? new Executor({ cfg, ops: liveChainOps(cfg, chain, signer), alerts, log }) : null;
const runner = new RoundRunner({ cfg, chain, indexer, fees, executor, alerts, log });
const tickMs = Number(process.env.ROUNDS_TICK_MS || 15_000);

function printDrop(title: string, l: Ledger | null) {
  if (!l) return console.log(`${title}: none`);
  console.log(`${title}: epoch ${l.epochIndex} close=${(Number(l.closeX96) / 2 ** 96).toPrecision(8)} IMD/token pot=${fmtImd(l.pot)} pays=${fmtImd(l.paidTotal)} leftover=${fmtImd(l.leftover)} IMD`);
  for (const e of l.entries) console.log(`  ${e.payee}  loss=${fmtImd(e.loss)}  amount=${fmtImd(e.amount)}`);
}

async function tick() {
  const r = await runner.tick();
  if (!r) return;
  writeData(join(cfg.ops.dataDir, 'state'), 'progress.json', {
    indexedBlock: r.indexedBlock.toString(),
    indexedTs: r.indexedTs,
    uptoEpoch: r.input.uptoEpoch,
  });
  for (const x of r.executed) log('drop', { epoch: x.epochIndex, result: x.result });
  return r;
}

log('start', { executor: cfg.exec.mode, token: cfg.launch.token, poolId: cfg.launch.poolId });
if (once) {
  const r = await tick();
  if (r) {
    let pending = 0n;
    try {
      pending = await fees.pending();
    } catch (e) {
      log('pending() read failed', { error: (e as Error).message });
    }
    printDrop('latest drop', r.history.ledgers[r.history.ledgers.length - 1] ?? null);
    printDrop(`next epoch (would-be, closing now, incl. ${fmtImd(pending)} unswept)`, estimateNextDrop(r.history, r.input, r.indexedTs, pending));
  }
  process.exit(0);
} else {
  alerts.heartbeat(() => `executor=${cfg.exec.mode} cursor=${indexer.cursor}`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log('tick failed', { error: (e as Error).message });
    }
    await runner.checkStall();
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
