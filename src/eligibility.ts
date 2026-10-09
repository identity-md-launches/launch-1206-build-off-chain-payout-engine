// Eligibility and loss for one wallet at one close price. Pure; shared by rounds, snapshot and api.
import type { WalletLedger } from './indexer.js';

const Q96 = 1n << 96n;

export interface EligibilityCtx {
  closeX96: bigint;
  minBuy: bigint;
  excluded: Set<string>; // lowercase: system addresses + configured list
  contracts: Set<string>; // lowercase: addresses with code
}

export interface WalletStatus {
  address: string;
  eligible: boolean;
  reason: string;
  heldQualifying: bigint;
  costBasis: bigint;
  entryX96: bigint; // VWAP, IMD per token (Q96)
  loss: bigint; // IMD wei
  pctBps: number; // drawdown in basis points
}

export function evaluateWallet(w: WalletLedger, ctx: EligibilityCtx): WalletStatus {
  const a = w.address.toLowerCase();
  const entryX96 = w.qualTokens > 0n ? (w.qualCost * Q96) / w.qualTokens : 0n;
  const base = {
    address: a,
    heldQualifying: w.qualTokens,
    costBasis: w.qualCost,
    entryX96,
    loss: 0n,
    pctBps: 0,
  };
  const no = (reason: string): WalletStatus => ({ ...base, eligible: false, reason });
  if (ctx.excluded.has(a)) return no('excluded system address');
  if (ctx.contracts.has(a)) return no('address has code');
  if (w.disqualified) return no(`disqualified: ${w.disqualified.reason} in ${w.disqualified.tx}`);
  if (w.qualTokens === 0n) return no('no qualifying buy through the pool');
  if (w.balance < w.qualTokens) return no('does not hold every qualifying token');
  if (w.qualCost < ctx.minBuy) return no('qualifying buys below minBuy');
  // loss = (entry - close) * held = cost - close * held, floored at 0
  const value = (ctx.closeX96 * w.qualTokens) / Q96;
  const loss = w.qualCost > value ? w.qualCost - value : 0n;
  const pctBps = w.qualCost > 0n ? Number((loss * 10_000n) / w.qualCost) : 0;
  return { ...base, eligible: true, reason: loss > 0n ? 'underwater' : 'in profit', loss, pctBps };
}

export function evaluateAll(wallets: Iterable<WalletLedger>, ctx: EligibilityCtx): WalletStatus[] {
  return [...wallets].map((w) => evaluateWallet(w, ctx)).sort((x, y) => (x.address < y.address ? -1 : 1));
}
