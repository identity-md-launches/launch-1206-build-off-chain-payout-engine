import { describe, expect, it } from 'vitest';
import { POOL_MANAGER } from '../src/config.js';
import { evaluateWallet, type EligibilityCtx } from '../src/eligibility.js';
import { rebuild } from '../src/indexer.js';
import { ADDR, E18, LAUNCH_TS, LogBuilder, Q96, referenceScenario, sqrtPow2, testConfig } from './helpers.js';

const cfg = testConfig();
const ctx = (closeX96: bigint, over: Partial<EligibilityCtx> = {}): EligibilityCtx => ({
  closeX96,
  minBuy: 0n,
  excluded: cfg.exclusions,
  contracts: new Set(),
  ...over,
});
const state = () => rebuild(referenceScenario().events(cfg), cfg.launch, cfg.exclusions, LAUNCH_TS + 900);
const w = (addr: string) => state().wallets.get(addr.toLowerCase())!;
const quarter = Q96 / 4n;

describe('eligibility', () => {
  it('counts only fee-paid buys through our pool, basis including the hook fee', () => {
    const s = evaluateWallet(w(ADDR.alice), ctx(quarter));
    expect(s.eligible).toBe(true);
    expect(s.costBasis).toBe(104_250_000_000_000_000_000n);
    expect(s.loss).toBe(104_250_000_000_000_000_000n - 25n * E18);
    expect(s.entryX96).toBe((104_250_000_000_000_000_000n * Q96) / (100n * E18));
  });

  it('router (ETH) buys qualify for the recipient with basis = IMD leg + fee; router never earns', () => {
    const bob = evaluateWallet(w(ADDR.bob), ctx(quarter));
    expect(bob.eligible).toBe(true);
    expect(bob.costBasis).toBe(208_500_000_000_000_000_000n);
    expect(evaluateWallet(w(ADDR.router), ctx(quarter)).eligible).toBe(false);
  });

  it('airdrop / OTC / other-pool tokens have zero basis and never earn', () => {
    expect(evaluateWallet(w(ADDR.carol), ctx(quarter)).reason).toMatch(/no qualifying buy/);
    expect(evaluateWallet(w(ADDR.erin), ctx(quarter)).reason).toMatch(/no qualifying buy/);
    expect(w(ADDR.erin).unqualifiedIn).toBe(30n * E18);
  });

  it('a sell on any venue or a transfer out voids eligibility forever', () => {
    expect(evaluateWallet(w(ADDR.dave), ctx(quarter)).eligible).toBe(false);
    const b = referenceScenario();
    b.tx(LAUNCH_TS + 700, 'alice-transfer-out').transfer('token', ADDR.alice, ADDR.carol, 1n);
    b.tx(LAUNCH_TS + 710, 'alice-buys-again')
      .swap(10n * E18, -10n * E18, sqrtPow2(-1))
      .fee(false, 425_000_000_000_000_000n, 0n, 10n * E18)
      .transfer('token', POOL_MANAGER, ADDR.alice, 10n * E18);
    const st = rebuild(b.events(cfg), cfg.launch, cfg.exclusions);
    expect(evaluateWallet(st.wallets.get(ADDR.alice.toLowerCase())!, ctx(quarter)).reason).toMatch(/disqualified/);
  });

  it('receiving airdropped tokens does not void cover; buying more via our pool is fine', () => {
    const b = referenceScenario();
    b.tx(LAUNCH_TS + 700, 'airdrop-to-alice').transfer('token', ADDR.deployer, ADDR.alice, 5n * E18);
    b.tx(LAUNCH_TS + 710, 'alice-buys-more')
      .swap(10n * E18, -2_500_000_000_000_000_000n, sqrtPow2(-1))
      .fee(false, 106_250_000_000_000_000n, 0n, 2_500_000_000_000_000_000n)
      .transfer('token', POOL_MANAGER, ADDR.alice, 10n * E18);
    const st = rebuild(b.events(cfg), cfg.launch, cfg.exclusions);
    const s = evaluateWallet(st.wallets.get(ADDR.alice.toLowerCase())!, ctx(quarter));
    expect(s.eligible).toBe(true);
    expect(s.heldQualifying).toBe(110n * E18);
    expect(s.costBasis).toBe(104_250_000_000_000_000_000n + 2_606_250_000_000_000_000n);
  });

  it('a swap on our pool without FeeAccrued in the tx does not qualify', () => {
    const b = new LogBuilder();
    b.tx(LAUNCH_TS, 'init').init(false, sqrtPow2(0));
    b.tx(LAUNCH_TS + 5, 'no-fee').swap(10n * E18, -10n * E18, sqrtPow2(0)).transfer('token', POOL_MANAGER, ADDR.alice, 10n * E18);
    const st = rebuild(b.events(cfg), cfg.launch, cfg.exclusions);
    expect(st.wallets.get(ADDR.alice.toLowerCase())!.qualTokens).toBe(0n);
  });

  it('enforces minBuy, exclusions and addresses with code', () => {
    expect(evaluateWallet(w(ADDR.alice), ctx(quarter, { minBuy: 105n * E18 })).reason).toMatch(/minBuy/);
    expect(evaluateWallet(w(ADDR.alice), ctx(quarter, { contracts: new Set([ADDR.alice.toLowerCase()]) })).reason).toMatch(/code/);
    const ex = testConfig({ EXCLUDE_ADDRESSES: ADDR.bob });
    expect(evaluateWallet(w(ADDR.bob), ctx(quarter, { excluded: ex.exclusions })).reason).toMatch(/excluded/);
    for (const sys of [ADDR.deployer, ADDR.factory, ADDR.distributor, POOL_MANAGER, ADDR.hook, ADDR.router, ADDR.roundPayout, ADDR.payoutWallet]) {
      expect(cfg.exclusions.has(sys.toLowerCase())).toBe(true);
    }
  });

  it('loss is zero when in profit', () => {
    const s = evaluateWallet(w(ADDR.alice), ctx(2n * Q96));
    expect(s.eligible).toBe(true);
    expect(s.loss).toBe(0n);
  });
});
