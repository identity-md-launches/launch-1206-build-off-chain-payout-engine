import { describe, expect, it } from 'vitest';
import { bookClaim } from '../src/rounds.js';

const E18 = 10n ** 18n;
const base = {
  sweeps: 100n * E18,
  distributor: 40n * E18,
  carry: 0n,
  dexReserveRemaining: 0n,
  opsSkimFraction: [0n, 1n] as [bigint, bigint],
  pouchShareOfDistributor: [1n, 4n] as [bigint, bigint],
};

describe('bookClaim', () => {
  it('pot = sweeps + 25% of distributor receipts; 75% is team share', () => {
    const b = bookClaim(base);
    expect(b.distributorPouch).toBe(10n * E18);
    expect(b.team).toBe(30n * E18);
    expect(b.pot).toBe(110n * E18);
  });

  it('adds the carried leftover', () => {
    expect(bookClaim({ ...base, carry: 5n * E18 }).pot).toBe(115n * E18);
  });

  it('applies the ops skim to the new pouch', () => {
    const b = bookClaim({ ...base, opsSkimFraction: [1n, 10n] });
    expect(b.opsSkim).toBe(11n * E18);
    expect(b.pot).toBe(99n * E18);
  });

  it('takes the one-time DEX reserve, never more than is available', () => {
    expect(bookClaim({ ...base, dexReserveRemaining: 30n * E18 }).pot).toBe(80n * E18);
    const b = bookClaim({ ...base, dexReserveRemaining: 500n * E18 });
    expect(b.dexReserve).toBe(110n * E18);
    expect(b.pot).toBe(0n);
  });
});
