// Close price for an epoch: time-weighted average of IMD per MONEYBACK over the `window` seconds
// ending at the boundary, built from Swap observations (price after each swap). Pure.
//
// Prices are Q96 fixed point in raw units: priceX96 = rawIMD * 2^96 / rawMONEYBACK.

export interface Observation {
  ts: number;
  block: bigint;
  logIndex: number;
  priceX96: bigint;
}

const Q96 = 1n << 96n;

/** IMD per MONEYBACK (Q96) from a v4 sqrtPriceX96 (currency1 per currency0). */
export function priceX96FromSqrt(sqrtPriceX96: bigint, imdIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96; // currency1/currency0 in Q192
  return imdIsCurrency0 ? (Q96 * Q96 * Q96) / sq : sq / Q96;
}

/**
 * Collapse observations sharing a timestamp to the last one (block, logIndex order) and sort by time.
 */
export function collapse(obs: Observation[]): Observation[] {
  const sorted = [...obs].sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex,
  );
  const out: Observation[] = [];
  for (const o of sorted) {
    if (out.length && out[out.length - 1].ts === o.ts) out[out.length - 1] = o;
    else out.push(o);
  }
  return out;
}

/**
 * TWAP over (boundary - window, boundary]. The price in force at the window start is the last
 * observation at or before it (an empty window therefore carries the last price). If nothing was
 * observed before the window, the average covers only the part after the first observation.
 * Returns null when no observation exists at or before the boundary.
 */
export function twapClose(obs: Observation[], boundary: number, window: number): bigint | null {
  const c = collapse(obs.filter((o) => o.ts <= boundary));
  if (c.length === 0) return null;
  const start = boundary - window;
  let i = 0;
  let price: bigint | null = null;
  while (i < c.length && c[i].ts <= start) price = c[i++].priceX96;
  let t = start;
  if (price === null) {
    price = c[i].priceX96;
    t = c[i].ts;
    i++;
  }
  if (t >= boundary) return price; // first observation exactly at the boundary
  let acc = 0n;
  const from = t;
  for (; i < c.length; i++) {
    acc += price * BigInt(c[i].ts - t);
    t = c[i].ts;
    price = c[i].priceX96;
  }
  acc += price * BigInt(boundary - t);
  return acc / BigInt(boundary - from);
}

/** Latest observed price at or before `ts` (spot), or null. */
export function spotAt(obs: Observation[], ts: number): bigint | null {
  const c = collapse(obs.filter((o) => o.ts <= ts));
  return c.length ? c[c.length - 1].priceX96 : null;
}
