import { describe, expect, it } from 'vitest';
import { IMD, POOL_MANAGER } from '../src/config.js';
import { classifyTx, groupByTx, poolOrder, rebuild } from '../src/indexer.js';
import { computeHistory } from '../src/rounds.js';
import { ADDR, E18, LAUNCH_TS, LogBuilder, Q96, sqrtPow2, testConfig } from './helpers.js';

const cfg = testConfig();

/** The four swap cases, in either currency order. */
function fourCases(imdIsCurrency0: boolean) {
  const sw = (tok: bigint, imd: bigint) => (imdIsCurrency0 ? [imd, tok] : [tok, imd]) as [bigint, bigint];
  const b = new LogBuilder();
  b.tx(LAUNCH_TS, 'init').init(imdIsCurrency0, sqrtPow2(0));
  b.tx(LAUNCH_TS + 1, 'direct-buy')
    .swap(...sw(10n * E18, -10n * E18), sqrtPow2(0))
    .fee(false, E18, 0n, 10n * E18)
    .transfer('token', POOL_MANAGER, ADDR.alice, 10n * E18);
  b.tx(LAUNCH_TS + 2, 'router-buy')
    .swap(...sw(20n * E18, -20n * E18), sqrtPow2(0))
    .fee(false, 2n * E18, E18, 20n * E18)
    .transfer('token', POOL_MANAGER, ADDR.router, 20n * E18)
    .transfer('token', ADDR.router, ADDR.bob, 20n * E18);
  b.tx(LAUNCH_TS + 3, 'sell')
    .transfer('token', ADDR.alice, POOL_MANAGER, 5n * E18)
    .swap(...sw(-5n * E18, 4n * E18), sqrtPow2(0))
    .fee(true, E18, E18, 4n * E18);
  b.tx(LAUNCH_TS + 4, 'other-pool-buy').transfer('token', ADDR.otherPool, ADDR.carol, 7n * E18);
  return b;
}

describe('indexer tx grouping', () => {
  for (const imd0 of [false, true]) {
    describe(`IMD is currency${imd0 ? 0 : 1}`, () => {
      const evs = fourCases(imd0).events(cfg);
      const order = poolOrder(evs, cfg.launch.token);
      const groups = groupByTx(evs);

      it('reads the currency order from Initialize', () => {
        expect(order.imdIsCurrency0).toBe(imd0);
      });

      it('direct buy: tokens out of our pool + FeeAccrued -> qualifying, cost includes fee', () => {
        const c = classifyTx(groups[1], order);
        expect(c.qualifying).toBe(true);
        expect(c.tokensOut).toBe(10n * E18);
        expect(c.costImd).toBe(11n * E18);
      });

      it('router buy: qualifying for the final recipient, surcharge included', () => {
        const c = classifyTx(groups[2], order);
        expect(c.qualifying).toBe(true);
        expect(c.costImd).toBe(23n * E18);
        const st = rebuild(evs, cfg.launch, cfg.exclusions);
        expect(st.wallets.get(ADDR.bob.toLowerCase())!.qualTokens).toBe(20n * E18);
        expect(st.wallets.get(ADDR.router.toLowerCase())!.qualTokens).toBe(0n);
      });

      it('sell: no tokens out, seller disqualified', () => {
        const c = classifyTx(groups[3], order);
        expect(c.qualifying).toBe(false);
        expect(c.senders.has(ADDR.alice.toLowerCase())).toBe(true);
        const st = rebuild(evs, cfg.launch, cfg.exclusions);
        expect(st.wallets.get(ADDR.alice.toLowerCase())!.disqualified).not.toBeNull();
      });

      it('other-pool buy: no Swap on our pool id -> zero basis', () => {
        const c = classifyTx(groups[4], order);
        expect(c.qualifying).toBe(false);
        const st = rebuild(evs, cfg.launch, cfg.exclusions);
        const carol = st.wallets.get(ADDR.carol.toLowerCase())!;
        expect([carol.qualTokens, carol.unqualifiedIn]).toEqual([0n, 7n * E18]);
      });

      it('prices every swap as IMD per token', () => {
        const st = rebuild(evs, cfg.launch, cfg.exclusions);
        expect(st.observations.length).toBe(3);
        expect(st.observations.every((o) => o.priceX96 === Q96)).toBe(true);
      });
    });
  }

  it('groups logs by tx in (block, logIndex) order and ignores swaps of other pools', () => {
    const b = fourCases(false);
    b.tx(LAUNCH_TS + 5, 'foreign').swap(1n, -1n, sqrtPow2(3), `0x${'11'.repeat(32)}`);
    const evs = b.events(cfg);
    expect(evs.filter((e) => e.kind === 'swap').length).toBe(3);
    expect(groupByTx([...evs].reverse()).map((g) => g.events.length)).toEqual(groupByTx(evs).map((g) => g.events.length));
  });

  it('books only Swept and distributor transfers as inflows (other IMD inflows never count)', () => {
    const b = fourCases(false);
    b.tx(LAUNCH_TS + 100, 'sweep').swept(9n * E18);
    b.tx(LAUNCH_TS + 101, 'dist').transfer('imd', ADDR.distributor, ADDR.payoutWallet, 8n * E18);
    b.tx(LAUNCH_TS + 102, 'gift').transfer('imd', ADDR.carol, ADDR.payoutWallet, 1000n * E18);
    const h = computeHistory({
      events: b.events(cfg),
      launch: cfg.launch,
      rules: cfg.rules,
      ops: cfg.ops,
      excluded: cfg.exclusions,
      contracts: new Set(),
      uptoEpoch: 0,
    });
    expect(h.treasury.sweeps).toBe(9n * E18);
    expect(h.treasury.distributorGross).toBe(8n * E18);
    expect(h.treasury.team).toBe(6n * E18);
    expect(IMD).toBe('0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127');
  });
});
