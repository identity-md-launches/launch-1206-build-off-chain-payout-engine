import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalLedger, ledgerFileName } from '../src/ledger.js';
import { diffLedgers, replayFixture, type Fixture } from '../scripts/replay.js';

const dir = join(__dirname, 'fixtures', 'replay');
const fx = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as Fixture;
const E18 = 10n ** 18n;

describe('replay', () => {
  const { history } = replayFixture(fx);

  it('reproduces the expected ledgers byte-for-byte', () => {
    expect(history.ledgers.map((l) => l.epochIndex)).toEqual([0, 1, 2]);
    expect(diffLedgers(history.ledgers, join(dir, 'expected'))).toEqual([]);
    for (const l of history.ledgers) {
      expect(canonicalLedger(l)).toBe(readFileSync(join(dir, 'expected', ledgerFileName(l.epochIndex)), 'utf8'));
    }
  });

  it('matches the hand-computed reference scenario', () => {
    const [d0, d1, d2] = history.ledgers;
    // epoch 0: pot = sweep 50 + 25% of distributor 40 = 60, split by loss 79.25 : 158.5
    expect(d0.pot).toBe(60n * E18);
    expect(d0.entries.map((e) => e.amount)).toEqual([40n * E18, 20n * E18]);
    // epoch 1: pot 100, both capped at 1/3 of loss, leftover rolls
    expect(d1.entries.map((e) => e.amount)).toEqual([52_833_333_333_333_333_333n, 26_416_666_666_666_666_666n]);
    expect(d1.leftover).toBe(20_750_000_000_000_000_001n);
    expect(d2.pot).toBe(d1.leftover);
    expect(history.treasury.team).toBe(30n * E18);
    expect(history.treasury.sweeps).toBe(150n * E18); // the 999 IMD gift never counts
  });

  it('a different rule set changes the ledgers (the diff catches it)', () => {
    const { history: h2 } = replayFixture(fx, { MAX_ROUND_RATIO: '1/2' });
    expect(diffLedgers(h2.ledgers, join(dir, 'expected'))).not.toEqual([]);
  });
});
