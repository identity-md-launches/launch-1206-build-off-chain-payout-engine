// Offline fixture builders: raw logs exactly as eth_getLogs returns them, for a synthetic launch.
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex } from 'viem';
import { feeAccruedEvent, initializeEvent, sweptEvent, swapEvent, transferEvent } from '../src/abi.js';
import { IMD, POOL_MANAGER, buildConfig, parseLaunch, type Config } from '../src/config.js';
import { decodeLog, type Ev } from '../src/indexer.js';
import type { RawLog } from '../src/rpc.js';

export const E18 = 10n ** 18n;
export const Q96 = 1n << 96n;
export const a = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

export const ADDR = {
  token: a(0xaaaa01),
  hook: a(0xaaaa02),
  distributor: a(0xaaaa03),
  router: a(0xaaaa04),
  roundPayout: a(0xaaaa05),
  payoutWallet: a(0xaaaa06),
  deployer: a(0xaaaa07),
  factory: a(0xaaaa08),
  otherPool: a(0xaaaa09),
  alice: a(0xa11ce),
  bob: a(0xb0b),
  carol: a(0xca201),
  dave: a(0xda7e),
  erin: a(0xe219),
};

export const LAUNCH_TS = 1_000_000;
export const POOL_ID = keccak256(toHex('moneyback-test-pool'));

export const launchJson = {
  chainId: 4663,
  token: ADDR.token,
  poolId: POOL_ID,
  hook: ADDR.hook,
  distributor: ADDR.distributor,
  router: ADDR.router,
  roundPayout: ADDR.roundPayout,
  payoutWallet: ADDR.payoutWallet,
  deployer: ADDR.deployer,
  factory: ADDR.factory,
  launchBlock: '100',
  launchTs: LAUNCH_TS,
  launchTx: keccak256(toHex('launch-tx')),
};

export function testConfig(env: Record<string, string> = {}): Config {
  return buildConfig(parseLaunch(launchJson), { DATA_DIR: '/tmp/moneyback-test', ...env });
}

/** Raw log with the block timestamp attached (as the fixture files store them). */
export type TsLog = RawLog & { blockTimestamp: number };

export class LogBuilder {
  logs: TsLog[] = [];
  private logIndex = 0;
  private block = 100n;
  private ts = LAUNCH_TS;
  private txHash: Hex = '0x';
  private txIndex = 0;

  /** Start a new transaction at `ts` (each tx gets its own block). */
  tx(ts: number, label: string): this {
    this.ts = ts;
    this.block += 1n;
    this.logIndex = 0;
    this.txIndex = 0;
    this.txHash = keccak256(toHex(label));
    return this;
  }

  private push(address: Address, topics: Hex[], data: Hex) {
    this.logs.push({
      address,
      topics,
      data,
      blockNumber: toHex(this.block),
      transactionHash: this.txHash,
      transactionIndex: toHex(this.txIndex),
      logIndex: toHex(this.logIndex++),
      blockTimestamp: this.ts,
    });
    return this;
  }

  init(imdIsCurrency0: boolean, sqrtPriceX96: bigint) {
    const [c0, c1] = imdIsCurrency0 ? [IMD, ADDR.token] : [ADDR.token, IMD];
    const topics = encodeEventTopics({ abi: [initializeEvent], args: { id: POOL_ID, currency0: c0, currency1: c1 } }) as Hex[];
    const data = encodeAbiParameters(
      [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
      [12500, 200, ADDR.hook, sqrtPriceX96, 0],
    );
    return this.push(POOL_MANAGER, topics, data);
  }

  swap(amount0: bigint, amount1: bigint, sqrtPriceX96: bigint, poolId: Hex = POOL_ID) {
    const topics = encodeEventTopics({ abi: [swapEvent], args: { id: poolId, sender: ADDR.router } }) as Hex[];
    const data = encodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
      [amount0, amount1, sqrtPriceX96, 10n ** 24n, 0, 12500],
    );
    return this.push(POOL_MANAGER, topics, data);
  }

  transfer(asset: 'token' | 'imd', from: Address, to: Address, value: bigint) {
    const topics = encodeEventTopics({ abi: [transferEvent], args: { from, to } }) as Hex[];
    return this.push(asset === 'token' ? ADDR.token : IMD, topics, encodeAbiParameters([{ type: 'uint256' }], [value]));
  }

  fee(isSell: boolean, base: bigint, surcharge: bigint, imdLeg: bigint) {
    const topics = encodeEventTopics({ abi: [feeAccruedEvent] }) as Hex[];
    const data = encodeAbiParameters(
      [{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [isSell, base, surcharge, imdLeg],
    );
    return this.push(ADDR.hook, topics, data);
  }

  swept(amount: bigint, to: Address = ADDR.payoutWallet) {
    const topics = encodeEventTopics({ abi: [sweptEvent] }) as Hex[];
    return this.push(ADDR.hook, topics, encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [amount, to]));
  }

  events(cfg: Config = testConfig()): Ev[] {
    return this.logs.map((l) => decodeLog(l, cfg.launch, l.blockTimestamp)).filter((e): e is Ev => e !== null);
  }
}

/** sqrtPriceX96 for IMD-per-token price 2^k with IMD as currency1 (token is currency0). */
export const sqrtPow2 = (k: number) => (k >= 0 ? Q96 << BigInt(k) : Q96 >> BigInt(-k));

/**
 * The reference scenario (IMD is currency1, price 1 at launch, 0.25 after dave's sell):
 *  - alice buys 100 directly (IMD 100 + 4.25 hook fee)
 *  - bob buys 200 through the ETH router (IMD leg 200 + 8.5 fee)
 *  - carol gets 50 from the deployer (airdrop, zero basis)
 *  - dave buys 100 then sells 10 on our pool (disqualified)
 *  - erin receives 30 from another pool (no Swap on our pool id)
 *  - sweeps and a distributor receipt feed two drops.
 */
export function referenceScenario(): LogBuilder {
  const L = LAUNCH_TS;
  const b = new LogBuilder();
  const PM = POOL_MANAGER;
  b.tx(L, 'init').init(false, sqrtPow2(0)).transfer('token', a(0), ADDR.deployer, 1_000_000n * E18);
  b.tx(L + 10, 'alice-buy')
    .transfer('imd', ADDR.alice, PM, 104_250_000_000_000_000_000n)
    .swap(100n * E18, -100n * E18, sqrtPow2(0))
    .fee(false, 4_250_000_000_000_000_000n, 0n, 100n * E18)
    .transfer('token', PM, ADDR.alice, 100n * E18);
  b.tx(L + 20, 'bob-router-buy')
    .swap(200n * E18, -200n * E18, sqrtPow2(0))
    .fee(false, 8_500_000_000_000_000_000n, 0n, 200n * E18)
    .transfer('token', PM, ADDR.router, 200n * E18)
    .transfer('token', ADDR.router, ADDR.bob, 200n * E18);
  b.tx(L + 30, 'carol-airdrop').transfer('token', ADDR.deployer, ADDR.carol, 50n * E18);
  b.tx(L + 40, 'dave-buy')
    .swap(100n * E18, -100n * E18, sqrtPow2(0))
    .fee(false, 4_250_000_000_000_000_000n, 0n, 100n * E18)
    .transfer('token', PM, ADDR.dave, 100n * E18);
  b.tx(L + 50, 'erin-other-pool').transfer('token', ADDR.otherPool, ADDR.erin, 30n * E18);
  b.tx(L + 600, 'dave-sell')
    .transfer('token', ADDR.dave, PM, 10n * E18)
    .swap(-10n * E18, 2n * E18, sqrtPow2(-1))
    .fee(true, 85_000_000_000_000_000n, 0n, 2n * E18);
  b.tx(L + 905, 'sweep-0').swept(50n * E18).transfer('imd', PM, ADDR.payoutWallet, 50n * E18);
  b.tx(L + 910, 'distributor-0').transfer('imd', ADDR.distributor, ADDR.payoutWallet, 40n * E18);
  b.tx(L + 950, 'otc-imd-in').transfer('imd', ADDR.carol, ADDR.payoutWallet, 999n * E18);
  b.tx(L + 1810, 'sweep-1').swept(100n * E18).transfer('imd', PM, ADDR.payoutWallet, 100n * E18);
  return b;
}
