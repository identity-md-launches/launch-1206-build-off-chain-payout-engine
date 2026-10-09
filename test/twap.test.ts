import { describe, expect, it } from 'vitest';
import { collapse, priceX96FromSqrt, twapClose, type Observation } from '../src/twap.js';

const Q96 = 1n << 96n;
const o = (ts: number, p: bigint, logIndex = 0, block = BigInt(ts)): Observation => ({ ts, block, logIndex, priceX96: p * Q96 });

describe('twap', () => {
  it('time-weights observations inside the window, starting from the price in force at window start', () => {
    // window (820, 1000]: price 10 until 900, then 20 until 1000 -> (10*80 + 20*100)/180
    const obs = [o(500, 10n), o(900, 20n)];
    expect(twapClose(obs, 1000, 180)).toBe(((10n * 80n + 20n * 100n) * Q96) / 180n);
  });

  it('ignores observations after the boundary', () => {
    expect(twapClose([o(500, 10n), o(1001, 99n)], 1000, 180)).toBe(10n * Q96);
  });

  it('carries the last price through an empty window', () => {
    expect(twapClose([o(100, 7n)], 5000, 180)).toBe(7n * Q96);
  });

  it('same timestamp: the last observation wins', () => {
    const obs = [o(900, 50n, 3, 900n), o(900, 20n, 5, 900n), o(900, 99n, 1, 900n), o(500, 10n)];
    expect(collapse(obs).map((x) => x.priceX96 / Q96)).toEqual([10n, 20n]);
    expect(twapClose(obs, 1000, 180)).toBe(((10n * 80n + 20n * 100n) * Q96) / 180n);
    // later block beats earlier block at equal ts regardless of logIndex
    expect(collapse([o(900, 1n, 9, 10n), o(900, 2n, 0, 11n)])[0].priceX96).toBe(2n * Q96);
  });

  it('averages only the covered part when nothing precedes the window, and null with no data', () => {
    expect(twapClose([o(910, 4n), o(955, 8n)], 1000, 180)).toBe(((4n * 45n + 8n * 45n) * Q96) / 90n);
    expect(twapClose([], 1000, 180)).toBeNull();
    expect(twapClose([o(1000, 3n)], 1000, 180)).toBe(3n * Q96);
  });

  it('derives IMD per token from sqrtPriceX96 in either currency order', () => {
    const sqrt = Q96 * 2n; // currency1/currency0 = 4
    expect(priceX96FromSqrt(sqrt, false)).toBe(4n * Q96); // token is currency0 -> 4 IMD per token
    expect(priceX96FromSqrt(sqrt, true)).toBe(Q96 / 4n); // IMD is currency0 -> 0.25 IMD per token
  });
});
