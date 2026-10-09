// Find a token's launch on Robinhood Chain and print the launch.json fields that can be read from chain.
//
//   RPC_URLS=https://... npm run discover -- <tokenAddress> [--from <block>] [--to <block>]
//
// Finds the PoolManager Initialize log pairing the token with IMD (pool id, hook, currency order,
// launchBlock/Ts/Tx), the launch tx's sender (deployer) and target (factory), and lists the contracts
// that received tokens in the launch tx as distributor candidates. router, roundPayout and
// payoutWallet are not derivable from the token and must be filled in from the deployment.
import { decodeAbiParameters, getAddress, isAddress, pad, type Hex } from 'viem';
import { TOPIC } from '../src/abi.js';
import { IMD, POOL_MANAGER } from '../src/config.js';
import { ChainReader } from '../src/rpc.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const token = process.argv[2];
  if (!token || !isAddress(token, { strict: false })) {
    console.error('usage: npm run discover -- <tokenAddress> [--from <block>] [--to <block>]');
    process.exit(2);
  }
  const urls = (process.env.RPC_URLS ?? '').split(',').filter(Boolean);
  if (!urls.length) throw new Error('set RPC_URLS');
  const chain = new ChainReader({
    rpc: {
      urls,
      logsUrl: process.env.RPC_LOGS_URL || undefined,
      pollMs: 750,
      followMargin: 0,
      anchorSpacing: 100,
      logChunk: Number(process.env.LOG_CHUNK || 5_000_000),
      maxRetries: 4,
      backoffMs: 500,
      minIntervalMs: 100,
    },
  });
  const head = arg('--to') ? BigInt(arg('--to')!) : await chain.safeHead();
  const from = BigInt(arg('--from') ?? 0);
  const t = pad(token.toLowerCase() as Hex);
  const imd = pad(IMD.toLowerCase() as Hex);
  const logs = [
    ...(await chain.getLogs({ address: POOL_MANAGER, topics: [TOPIC.initialize, null, t, imd] }, from, head)),
    ...(await chain.getLogs({ address: POOL_MANAGER, topics: [TOPIC.initialize, null, imd, t] }, from, head)),
  ];
  if (logs.length === 0) {
    console.error(`no ${token}/IMD pool initialised on PoolManager ${POOL_MANAGER} in blocks ${from}..${head}`);
    process.exit(1);
  }
  if (logs.length > 1) console.error(`note: ${logs.length} ${token}/IMD pools found; using the first, others listed below`);
  const init = logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)))[0];
  const [fee, tickSpacing, hooks] = decodeAbiParameters(
    [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
    init.data,
  );
  const launchBlock = BigInt(init.blockNumber);
  const launchTs = await chain.exactTimestamp(launchBlock);
  const tx = await chain.getTx(init.transactionHash);
  const receipt = await chain.getReceipt(init.transactionHash);
  const recipients = new Set<string>();
  for (const l of receipt.logs as { address: string; topics: Hex[] }[]) {
    if (l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TOPIC.transfer) {
      recipients.add(getAddress(`0x${l.topics[2].slice(26)}`));
    }
  }
  const candidates: string[] = [];
  for (const r of recipients) {
    const skip = [POOL_MANAGER, String(hooks), String(tx?.to ?? '')].map((x) => x.toLowerCase());
    if (skip.includes(r.toLowerCase())) continue;
    if (await chain.hasCode(r as Hex)) candidates.push(r);
  }
  const imdIsCurrency0 = init.topics[2].toLowerCase() === imd;
  console.log(
    JSON.stringify(
      {
        chainId: 4663,
        token: getAddress(token),
        poolId: init.topics[1],
        hook: getAddress(hooks),
        distributor: candidates.length === 1 ? candidates[0] : null,
        router: null,
        roundPayout: null,
        payoutWallet: null,
        deployer: tx?.from ? getAddress(tx.from) : null,
        factory: tx?.to ? getAddress(tx.to) : null,
        launchBlock: launchBlock.toString(),
        launchTs,
        launchTx: init.transactionHash,
        _discovered: {
          currency0: imdIsCurrency0 ? IMD : getAddress(token),
          currency1: imdIsCurrency0 ? getAddress(token) : IMD,
          fee: Number(fee),
          tickSpacing: Number(tickSpacing),
          distributorCandidates: candidates,
          otherPools: logs.slice(1).map((l) => l.topics[1]),
          todo: 'fill router, roundPayout, payoutWallet (and distributor if null) from the deployment; drop _discovered',
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
