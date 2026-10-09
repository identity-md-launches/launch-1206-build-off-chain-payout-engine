import { describe, expect, it } from 'vitest';
import type { WalletStatus } from '../src/eligibility.js';
import { canonicalLedger, ledgerHash, parseLedger } from '../src/ledger.js';
import { capFor, chunkLegs, computeDrop, roundIdOf, type PayoutRules } from '../src/payout.js';
import { keccak256, stringToBytes } from 'viem';

const E18 = 10n ** 18n;
const rules: PayoutRules = {
  minPayout: 0n,
  maxRoundRatio: [1n, 3n],
  maxPayoutRatio: [1n, 1n],
  weightLossExp: 1,
  weightPctExp: 0,
  maxRecipientsPerTx: 200,
};
const st = (n: number, loss: bigint, eligible = true): WalletStatus => ({
  address: `0x${n.toString(16).padStart(40, '0')}`,
  eligible,
  reason: '',
  heldQualifying: 1n,
  costBasis: loss * 2n,
  entryX96: 1n,
  loss,
  pctBps: 5000,
});
const drop = (pot: bigint, statuses: WalletStatus[], paid = new Map<string, bigint>(), r = rules) =>
  computeDrop({ epochIndex: 7, boundaryTs: 1, token: '0xT', closeX96: 5n, pot, statuses, paidSoFar: paid, rules: r });

describe('payout', () => {
  it('caps each drop at 1/3 of the current loss and rolls the leftover', () => {
    const l = drop(1000n * E18, [st(1, 30n * E18)]);
    expect(l.entries[0].amount).toBe(10n * E18);
    expect(l.leftover).toBe(990n * E18);
  });

  it('never pays more than the loss in total (made whole), and nothing once covered', () => {
    expect(capFor(30n * E18, 25n * E18, rules)).toBe(5n * E18);
    expect(capFor(30n * E18, 30n * E18, rules)).toBe(0n);
    const paid = new Map([[st(1, 0n).address, 30n * E18]]);
    expect(drop(100n * E18, [st(1, 30n * E18)], paid).paidTotal).toBe(0n);
    // a deeper loss re-opens room
    expect(drop(100n * E18, [st(1, 60n * E18)], paid).paidTotal).toBe(20n * E18);
  });

  it('splits by loss share, re-splitting what a capped wallet cannot take', () => {
    // pot 30, losses 300 and 30: shares 27.27/2.73; small cap 10 not hit; big cap 100 not hit
    const l = drop(30n * E18, [st(1, 300n * E18), st(2, 30n * E18)]);
    expect(l.entries.map((e) => e.amount)).toEqual([(30n * E18 * 300n) / 330n, (30n * E18 * 30n) / 330n]);
    // pot 66, losses 30 (25 already paid -> cap 5) and 300: shares 6/60, the small one is capped
    // at 5 and the big one takes the remaining 61
    const paid = new Map([[st(1, 0n).address, 25n * E18]]);
    const m = drop(66n * E18, [st(1, 30n * E18), st(2, 300n * E18)], paid);
    expect(m.entries.map((e) => e.amount)).toEqual([5n * E18, 61n * E18]);
    expect(m.leftover).toBe(0n);
  });

  it('ignores ineligible and in-profit wallets and skips legs under minPayout', () => {
    const l = drop(30n * E18, [st(1, 0n), st(2, 90n * E18, false), st(3, 90n * E18), st(4, 1n)], new Map(), {
      ...rules,
      minPayout: E18,
    });
    expect(l.entries.map((e) => [e.payee.slice(-1), e.amount])).toEqual([
      ['3', 30n * E18], // wallet 4's cap (1/3 of 1 wei) floors to 0, so wallet 3 takes its full cap
      ['4', 0n],
    ]);
    expect(l.totalEligibleLoss).toBe(90n * E18 + 1n);
    expect(l.paidTotal + l.leftover).toBe(30n * E18);
  });

  it('chunks at maxRecipientsPerTx with roundId = epoch*1000 + chunk', () => {
    const legs = Array.from({ length: 450 }, (_, i) => ({ payee: `0x${(i + 1).toString(16).padStart(40, '0')}`, amount: 1n }));
    const chunks = chunkLegs(12, legs, 200);
    expect(chunks.map((c) => c.payees.length)).toEqual([200, 200, 50]);
    expect(chunks.map((c) => c.roundId)).toEqual([12000n, 12001n, 12002n]);
    expect(roundIdOf(3, 4)).toBe(3004n);
    const l = drop(450n * E18, Array.from({ length: 450 }, (_, i) => st(i + 1, 3n * E18)));
    expect(l.chunks.length).toBe(3);
    expect(l.chunks[2].roundId).toBe(7002n);
  });

  it('ledger hash is keccak256 of the canonical bytes and survives a round trip', () => {
    const l = drop(30n * E18, [st(2, 300n * E18), st(1, 30n * E18)]);
    const text = canonicalLedger(l);
    expect(ledgerHash(l)).toBe(keccak256(stringToBytes(text)));
    expect(canonicalLedger(parseLedger(text))).toBe(text);
    expect(text.indexOf('"payee":"0x0000000000000000000000000000000000000001"')).toBeLessThan(text.indexOf('0000000000000002"'));
    const changed = { ...l, entries: l.entries.map((e, i) => (i === 0 ? { ...e, amount: e.amount + 1n } : e)) };
    expect(ledgerHash(changed)).not.toBe(ledgerHash(l));
  });
});
