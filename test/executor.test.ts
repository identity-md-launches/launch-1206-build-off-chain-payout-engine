import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOPIC } from '../src/abi.js';
import { IMD } from '../src/config.js';
import { Executor, type ChainOps } from '../src/executor.js';
import type { Ledger } from '../src/ledger.js';
import { computeDrop } from '../src/payout.js';
import type { TxReceiptLite } from '../src/wallet.js';
import { ADDR, E18, testConfig } from './helpers.js';

const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;

/** In-memory RoundPayout + IMD + a priority node that can lag behind. */
class MockChain implements ChainOps {
  head = 1000n;
  nodeLag = 0n; // priority node head = head - nodeLag
  staleZeroReads = 0; // the next N balance reads return 0 (lagging node)
  balances = new Map<string, bigint>([[ADDR.payoutWallet.toLowerCase(), 10_000n * E18]]);
  allowance = 0n;
  paid = new Set<bigint>();
  failed = new Map<string, bigint>();
  sends: { fn: string; args: unknown[] }[] = [];
  fundEmitsLog = true;
  failNext = new Set<string>(); // payees whose next leg fails
  onSend?: (fn: string) => void;

  async blockNumber() {
    return this.head - this.nodeLag;
  }
  async imdBalanceOf(addr: Address) {
    if (this.staleZeroReads > 0) {
      this.staleZeroReads--;
      return 0n;
    }
    return this.balances.get(addr.toLowerCase()) ?? 0n;
  }
  async imdAllowance() {
    return this.allowance;
  }
  async isPaid(roundId: bigint) {
    return this.paid.has(roundId);
  }
  async failedAmount(roundId: bigint, to: Address) {
    return this.failed.get(`${roundId}:${to.toLowerCase()}`) ?? 0n;
  }
  private move(from: string, to: string, v: bigint) {
    this.balances.set(from.toLowerCase(), (this.balances.get(from.toLowerCase()) ?? 0n) - v);
    this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0n) + v);
  }
  async send(_target: string, fn: string, args: unknown[]): Promise<TxReceiptLite> {
    this.sends.push({ fn, args });
    this.onSend?.(fn);
    this.head += 1n;
    const r: TxReceiptLite = { hash: `0x${this.sends.length.toString(16).padStart(64, '0')}`, status: 'success', blockNumber: this.head, logs: [] };
    if (fn === 'approve') this.allowance = args[1] as bigint;
    if (fn === 'fund') {
      const amount = args[1] as bigint;
      this.move(ADDR.payoutWallet, ADDR.roundPayout, amount);
      if (this.fundEmitsLog)
        r.logs.push({
          address: IMD,
          topics: [TOPIC.transfer, pad(ADDR.payoutWallet), pad(ADDR.roundPayout)],
          data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
        });
    }
    if (fn === 'payRound') {
      const [roundId, , to, amounts] = args as [bigint, string, string[], bigint[]];
      to.forEach((p, i) => {
        if (this.failNext.has(p.toLowerCase())) {
          this.failNext.delete(p.toLowerCase());
          this.failed.set(`${roundId}:${p.toLowerCase()}`, amounts[i]);
        } else this.move(ADDR.roundPayout, p, amounts[i]);
      });
      this.paid.add(roundId);
    }
    if (fn === 'retryFailed') {
      const [roundId, to] = args as [bigint, string[]];
      for (const p of to) if (!this.failNext.has(p.toLowerCase())) this.failed.delete(`${roundId}:${p.toLowerCase()}`);
    }
    if (fn === 'writeOffFailed') this.failed.delete(`${args[0]}:${String(args[1]).toLowerCase()}`);
    return r;
  }
}

function ledger(nPayees = 3, maxRecipientsPerTx = 2): Ledger {
  const cfg = testConfig();
  return computeDrop({
    epochIndex: 5,
    boundaryTs: 1,
    token: cfg.launch.token,
    closeX96: 1n,
    pot: 30n * E18,
    statuses: Array.from({ length: nPayees }, (_, i) => ({
      address: `0x${(0xbeef00 + i).toString(16).padStart(40, '0')}`,
      eligible: true,
      reason: '',
      heldQualifying: 1n,
      costBasis: 100n * E18,
      entryX96: 1n,
      loss: 90n * E18,
      pctBps: 9000,
    })),
    paidSoFar: new Map(),
    rules: { ...cfg.rules, maxRecipientsPerTx },
  });
}

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mb-exec-'));
  const cfg = testConfig({ DATA_DIR: dir, FUNDING_PROOF_ATTEMPTS: '5', FUNDING_PROOF_DELAY_MS: '0', ...env });
  const chain = new MockChain();
  const alerts: string[] = [];
  const ex = new Executor({ cfg, ops: chain, alerts: { send: async (m) => void alerts.push(m) }, sleep: async () => {} });
  return { cfg, chain, alerts, ex, dir };
}

describe('executor state machine', () => {
  it('approves, funds, proves funding, pays every chunk and records the drop as paid', async () => {
    const { chain, ex, alerts } = setup();
    const l = ledger();
    expect(await ex.executeDrop(l)).toEqual({ status: 'paid' });
    expect(chain.sends.map((s) => s.fn)).toEqual(['approve', 'fund', 'payRound', 'payRound']);
    expect(chain.sends[2].args[0]).toBe(5000n);
    expect(chain.sends[3].args[0]).toBe(5001n);
    expect(chain.balances.get(ADDR.roundPayout.toLowerCase())).toBe(0n);
    expect(ex.isFinal(5)).toBe(true);
    expect(alerts.some((a) => a.includes('paid epoch 5'))).toBe(true);
  });

  it('refuses to pay without a funding Transfer log in the receipt', async () => {
    const { chain, ex } = setup();
    chain.fundEmitsLog = false;
    const r = await ex.executeDrop(ledger());
    expect(r.status).toBe('error');
    expect(chain.sends.some((s) => s.fn === 'payRound')).toBe(false);
  });

  it('a lagging priority node reading zero does not fail the round', async () => {
    const { chain, ex } = setup();
    chain.staleZeroReads = 3;
    expect((await ex.executeDrop(ledger())).status).toBe('paid');
  });

  it('a node that never catches up defers (not fails) and resumes without re-funding', async () => {
    const { chain, ex } = setup();
    chain.nodeLag = 50n;
    expect((await ex.executeDrop(ledger())).status).toBe('deferred');
    expect(chain.sends.map((s) => s.fn)).toEqual(['approve', 'fund']);
    chain.nodeLag = 0n;
    expect((await ex.executeDrop(ledger())).status).toBe('paid');
    expect(chain.sends.filter((s) => s.fn === 'fund').length).toBe(1);
  });

  it('re-checks isPaid before each send and skips chunks already paid', async () => {
    const { chain, ex } = setup();
    // someone else's process pays chunk 5001 right after our funding lands
    chain.onSend = (fn) => {
      if (fn === 'payRound') chain.paid.add(5001n);
    };
    expect((await ex.executeDrop(ledger())).status).toBe('paid');
    expect(chain.sends.filter((s) => s.fn === 'payRound').map((s) => s.args[0])).toEqual([5000n]);
  });

  it('pause file halts all sends', async () => {
    const { cfg, chain, ex } = setup();
    writeFileSync(cfg.ops.pauseFile, '');
    expect((await ex.executeDrop(ledger())).status).toBe('paused');
    expect(chain.sends).toEqual([]);
  });

  it('refuses and alerts on a drop above maxRoundPayoutQuote', async () => {
    const { chain, ex, alerts } = setup({ MAX_ROUND_PAYOUT_QUOTE: '10' });
    expect((await ex.executeDrop(ledger())).status).toBe('refused');
    expect(chain.sends).toEqual([]);
    expect(alerts[0]).toMatch(/REFUSED/);
  });

  it('records failed legs, retries them, then writes off', async () => {
    const { chain, ex } = setup({ MAX_LEG_RETRIES: '1' });
    const l = ledger();
    const victim = l.chunks[0].payees[0];
    chain.failNext.add(victim);
    expect((await ex.executeDrop(l)).status).toBe('paid');
    expect(ex.state.drops[5].failed['5000'][victim].status).toBe('open');
    chain.failNext.add(victim); // retry fails too
    await ex.retryFailedLegs();
    expect(ex.state.drops[5].failed['5000'][victim].attempts).toBe(1);
    await ex.retryFailedLegs();
    expect(ex.state.drops[5].failed['5000'][victim].status).toBe('written-off');
    expect(chain.sends.map((s) => s.fn).slice(-2)).toEqual(['retryFailed', 'writeOffFailed']);
  });
});
