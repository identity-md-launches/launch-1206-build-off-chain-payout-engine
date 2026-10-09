// Drop computation. Pure: weights, per-drop and made-whole caps, water-filling split of the pot,
// minPayout skip, chunking into payRound calls, roundId and the resulting ledger.
import type { Rules } from './config.js';
import type { WalletStatus } from './eligibility.js';
import type { Ledger, LedgerChunk, LedgerEntry } from './ledger.js';

export type PayoutRules = Pick<
  Rules,
  'minPayout' | 'maxRoundRatio' | 'maxPayoutRatio' | 'weightLossExp' | 'weightPctExp' | 'maxRecipientsPerTx'
>;

export interface DropInput {
  epochIndex: number;
  boundaryTs: number;
  token: string;
  closeX96: bigint;
  pot: bigint;
  statuses: WalletStatus[];
  /** Cumulative IMD already paid per wallet (lowercase) across earlier drops. */
  paidSoFar: Map<string, bigint>;
  rules: PayoutRules;
}

export const roundIdOf = (epochIndex: number, chunkIndex: number) => BigInt(epochIndex) * 1000n + BigInt(chunkIndex);

/** Max a wallet may receive in this drop (rule 4). */
export function capFor(loss: bigint, paid: bigint, rules: PayoutRules): bigint {
  const [rn, rd] = rules.maxRoundRatio;
  const [pn, pd] = rules.maxPayoutRatio;
  const perDrop = (loss * rn) / rd;
  const total = (loss * pn) / pd;
  const room = total > paid ? total - paid : 0n;
  return perDrop < room ? perDrop : room;
}

/** weight = loss^a * pct^b; a=1, b=0 stays exact integer arithmetic. */
export function weightOf(st: WalletStatus, rules: PayoutRules): bigint {
  const { weightLossExp: a, weightPctExp: b } = rules;
  if (a === 1 && b === 0) return st.loss;
  if (st.loss === 0n || st.costBasis === 0n) return 0n;
  const pct = Number(st.loss) / Number(st.costBasis);
  const w = Number(st.loss) ** a * pct ** b;
  return Number.isFinite(w) && w > 0 ? BigInt(Math.floor(w)) : 0n;
}

/**
 * Split `pot` by weight with each wallet capped; whatever a capped wallet cannot take is
 * re-split among the others. Integer floors; the remainder is left over.
 */
export function waterFill(pot: bigint, legs: { key: string; weight: bigint; cap: bigint }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let active = legs.filter((l) => l.weight > 0n && l.cap > 0n);
  let remaining = pot;
  while (active.length && remaining > 0n) {
    const W = active.reduce((s, l) => s + l.weight, 0n);
    const capped = active.filter((l) => (remaining * l.weight) / W >= l.cap);
    if (capped.length === 0) {
      for (const l of active) out.set(l.key, (remaining * l.weight) / W);
      break;
    }
    for (const l of capped) {
      out.set(l.key, l.cap);
      remaining -= l.cap;
    }
    active = active.filter((l) => !capped.includes(l));
  }
  return out;
}

export function chunkLegs(epochIndex: number, legs: { payee: string; amount: bigint }[], size: number): LedgerChunk[] {
  const paid = legs.filter((l) => l.amount > 0n).sort((a, b) => (a.payee < b.payee ? -1 : 1));
  const chunks: LedgerChunk[] = [];
  for (let i = 0; i < paid.length; i += size) {
    const part = paid.slice(i, i + size);
    chunks.push({
      roundId: roundIdOf(epochIndex, chunks.length),
      payees: part.map((p) => p.payee),
      amounts: part.map((p) => p.amount),
    });
  }
  return chunks;
}

export function computeDrop(input: DropInput): Ledger {
  const { rules } = input;
  const underwater = input.statuses.filter((s) => s.eligible && s.loss > 0n);
  const legs = underwater.map((s) => ({
    key: s.address,
    weight: weightOf(s, rules),
    cap: capFor(s.loss, input.paidSoFar.get(s.address) ?? 0n, rules),
  }));
  const alloc = waterFill(input.pot, legs);
  const entries: LedgerEntry[] = underwater.map((s) => {
    let amount = alloc.get(s.address) ?? 0n;
    if (amount < rules.minPayout) amount = 0n;
    return { payee: s.address, loss: s.loss, entry: s.entryX96, close: input.closeX96, amount };
  });
  entries.sort((a, b) => (a.payee < b.payee ? -1 : 1));
  const paidTotal = entries.reduce((s, e) => s + e.amount, 0n);
  return {
    version: 1,
    epochIndex: input.epochIndex,
    boundaryTs: input.boundaryTs,
    token: input.token.toLowerCase(),
    closeX96: input.closeX96,
    pot: input.pot,
    paidTotal,
    leftover: input.pot - paidTotal,
    totalEligibleLoss: underwater.reduce((s, x) => s + x.loss, 0n),
    entries,
    chunks: chunkLegs(input.epochIndex, entries, rules.maxRecipientsPerTx),
  };
}
