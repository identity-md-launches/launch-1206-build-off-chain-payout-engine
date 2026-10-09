import { describe, expect, it } from 'vitest';
import { ChainReader, Timestamps, gridCritical, type Fetcher } from '../src/rpc.js';
import { testConfig } from './helpers.js';

const rpc = { ...testConfig().rpc, urls: ['http://a', 'http://b'], backoffMs: 1, maxRetries: 2, minIntervalMs: 0, logChunk: 1000 };

describe('rpc', () => {
  it('uses the lowest head across endpoints minus followMargin', async () => {
    const fetcher: Fetcher = async (url) => ({ result: url === 'http://a' ? '0x64' : '0x5a' });
    const r = new ChainReader({ rpc: { ...rpc, followMargin: 5 }, fetcher });
    expect(await r.safeHead()).toBe(85n); // min(100, 90) - 5
  });

  it('bisects refused getLogs ranges and returns sorted logs', async () => {
    const calls: [number, number][] = [];
    const fetcher: Fetcher = async (_url, body: any) => {
      const { fromBlock, toBlock } = body.params[0];
      const [a, b] = [Number(fromBlock), Number(toBlock)];
      calls.push([a, b]);
      if (b - a > 250) return { error: { code: -32602, message: 'query exceeds max block range' } };
      return {
        result: [{ address: '0x1', topics: [], data: '0x', blockNumber: `0x${b.toString(16)}`, transactionHash: '0x', transactionIndex: '0x0', logIndex: '0x0' }],
      };
    };
    const r = new ChainReader({ rpc, fetcher });
    const logs = await r.getLogs({ address: '0x1', topics: [] }, 0n, 999n);
    expect(logs.length).toBe(4);
    expect(logs.map((l) => Number(l.blockNumber))).toEqual([...logs.map((l) => Number(l.blockNumber))].sort((x, y) => x - y));
    expect(calls[0]).toEqual([0, 999]);
  });

  it('does not retry a revert', async () => {
    let n = 0;
    const fetcher: Fetcher = async () => {
      n++;
      return { error: { code: 3, message: 'execution reverted' } };
    };
    const r = new ChainReader({ rpc, fetcher });
    await expect(r.pool.call('eth_call', [])).rejects.toThrow(/reverted/);
    expect(n).toBe(1);
  });

  it('interpolates timestamps between anchors, exact when a boundary falls inside the bracket', async () => {
    const fetched: bigint[] = [];
    const exact = async (b: bigint) => {
      fetched.push(b);
      return 1000 + Math.floor(Number(b) / 10); // 0.1 s blocks
    };
    const crit = gridCritical(1000, 900, 180);
    const ts = new Timestamps(exact, 100, undefined);
    expect(await ts.at(150n, 10_000n, crit)).toBe(1015);
    expect(fetched).toEqual([100n, 200n]);
    // block 7195..7205 straddle the TWAP start 1720 (= 1000 + 900 - 180): bracket 7100..7200 contains it
    fetched.length = 0;
    expect(await ts.at(7150n, 10_000n, crit)).toBe(1715);
    expect(fetched).toContain(7150n);
  });
});
