// Record an out-of-band claim (a sweep or distributor payment made outside the engine that the
// indexer did not book, e.g. through an older hook or a manual transfer path) so the next drop's
// pot includes it.
//
//   npm run reconcile -- <txHash> [--kind sweep|distributor] [--note "text"]
//
// The receipt must contain an IMD Transfer into the payout wallet; for kind=distributor it must come
// from the launch distributor (other inflows never count toward the pot). Entries are appended to
// data/claims-manual.json and de-duplicated by (tx, logIndex) against indexed events.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeAbiParameters, type Hex } from 'viem';
import { TOPIC } from '../src/abi.js';
import { IMD, loadConfig } from '../src/config.js';
import { ChainReader } from '../src/rpc.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const hash = process.argv[2] as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) {
    console.error('usage: npm run reconcile -- <txHash> [--kind sweep|distributor] [--note "text"]');
    process.exit(2);
  }
  const kind = (arg('--kind') ?? 'sweep') as 'sweep' | 'distributor';
  if (kind !== 'sweep' && kind !== 'distributor') throw new Error('--kind must be sweep or distributor');
  const cfg = loadConfig();
  const chain = new ChainReader({ rpc: cfg.rpc });
  const r = await chain.getReceipt(hash);
  if (!r || r.status !== '0x1') throw new Error(`tx ${hash} not found or reverted`);
  const ts = await chain.exactTimestamp(BigInt(r.blockNumber));
  const payout = cfg.launch.payoutWallet.toLowerCase();
  const found = (r.logs as { address: string; topics: Hex[]; data: Hex; logIndex: Hex }[]).filter(
    (l) =>
      l.address.toLowerCase() === IMD.toLowerCase() &&
      l.topics[0] === TOPIC.transfer &&
      `0x${l.topics[2].slice(26)}`.toLowerCase() === payout &&
      (kind === 'sweep' || `0x${l.topics[1].slice(26)}`.toLowerCase() === cfg.launch.distributor.toLowerCase()),
  );
  if (found.length === 0) throw new Error(`no qualifying IMD transfer into ${cfg.launch.payoutWallet} in ${hash}`);
  const p = join(cfg.ops.dataDir, 'claims-manual.json');
  const list: any[] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
  for (const l of found) {
    const logIndex = Number(BigInt(l.logIndex));
    if (list.some((c) => c.tx === hash.toLowerCase() && c.logIndex === logIndex)) continue;
    const [amount] = decodeAbiParameters([{ type: 'uint256' }], l.data);
    list.push({ kind, tx: hash.toLowerCase(), logIndex, ts, amount: amount.toString(), note: arg('--note') ?? '' });
    console.log(`recorded ${kind} of ${amount} IMD wei at ts ${ts} (log ${logIndex})`);
  }
  writeFileSync(p, JSON.stringify(list, null, 2));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
