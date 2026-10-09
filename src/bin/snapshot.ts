// pm2 app "snapshot": rewrites data/*.json from the index every PRICE_INTERVAL_MS (prices included).
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { Fees } from '../fees.js';
import { makeLog } from '../log.js';
import { ChainReader } from '../rpc.js';
import { fetchPrices, loadHistory, writeSnapshot, type Prices } from '../snapshot.js';

const log = makeLog('snapshot');
const cfg = loadConfig();
const chain = new ChainReader({ rpc: cfg.rpc, cacheDir: join(cfg.ops.dataDir, 'cache') });
const fees = new Fees(cfg, chain, null, log);
let prices: Prices | null = null;

for (;;) {
  try {
    const h = loadHistory(cfg);
    if (!h) log('index not ready; waiting for the rounds app');
    else {
      prices = await fetchPrices(cfg, chain, h.events, prices);
      const pending = await fees.pending().catch(() => 0n);
      writeSnapshot(cfg, h, prices, pending);
      log('snapshot written', { epochs: h.hist.epochs.length, drops: h.hist.ledgers.length });
    }
  } catch (e) {
    log('snapshot failed', { error: (e as Error).message });
  }
  await new Promise((r) => setTimeout(r, cfg.ops.priceIntervalMs));
}
