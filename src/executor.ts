// Live executor: funds RoundPayout, proves the funding (receipt log AND a priority-node balance
// read), pays a drop in payRound chunks with an isPaid re-check before every send, then retries or
// writes off failed legs. A pause file halts every send; an absurdly large drop is refused.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeAbiParameters, getAddress, type Abi, type Address, type Hex } from 'viem';
import { TOPIC, defaultRoundPayoutAbi, erc20Abi } from './abi.js';
import type { Alerts } from './alerts.js';
import { IMD, type Config } from './config.js';
import { ledgerHash, type Ledger } from './ledger.js';
import type { ChainReader } from './rpc.js';
import type { Signer, TxReceiptLite } from './wallet.js';

export interface ChainOps {
  /** Head of the priority node. */
  blockNumber(): Promise<bigint>;
  /** IMD balance read on the priority node (optionally at a block). */
  imdBalanceOf(addr: Address, block?: bigint): Promise<bigint>;
  imdAllowance(owner: Address, spender: Address): Promise<bigint>;
  isPaid(roundId: bigint): Promise<boolean>;
  failedAmount(roundId: bigint, to: Address): Promise<bigint>;
  send(target: 'imd' | 'roundPayout', fn: string, args: unknown[]): Promise<TxReceiptLite>;
}

interface FailedLeg {
  amount: string;
  attempts: number;
  status: 'open' | 'resolved' | 'written-off';
}

interface DropState {
  status: 'pending' | 'paid' | 'refused';
  funding?: { tx: Hex; block: string; amount: string };
  chunks: Record<string, { tx: Hex | null; paid: boolean }>;
  failed: Record<string, Record<string, FailedLeg>>; // roundId -> payee -> leg
}

export interface ExecState {
  drops: Record<string, DropState>;
}

export interface DropResult {
  status: 'paid' | 'paused' | 'refused' | 'deferred' | 'error';
  detail?: string;
}

export interface ExecutorOpts {
  cfg: Pick<Config, 'launch' | 'ops' | 'exec'>;
  ops: ChainOps;
  alerts: Pick<Alerts, 'send'>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  statePath?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmt = (wei: bigint) => {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18, -14)}`;
};

export class Executor {
  state: ExecState;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly statePath: string;
  private readonly log: NonNullable<ExecutorOpts['log']>;

  constructor(private readonly o: ExecutorOpts) {
    this.sleep = o.sleep ?? realSleep;
    this.log = o.log ?? (() => {});
    this.statePath = o.statePath ?? join(o.cfg.ops.dataDir, 'state', 'exec.json');
    this.state = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : { drops: {} };
  }

  private save() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.statePath}.tmp`, this.statePath);
  }

  paused(): boolean {
    return existsSync(this.o.cfg.ops.pauseFile);
  }

  isFinal(epochIndex: number): boolean {
    const s = this.state.drops[epochIndex]?.status;
    return s === 'paid' || s === 'refused';
  }

  async executeDrop(l: Ledger): Promise<DropResult> {
    const { ops, alerts, cfg } = this.o;
    const st: DropState = (this.state.drops[l.epochIndex] ??= { status: 'pending', chunks: {}, failed: {} });
    if (this.isFinal(l.epochIndex)) return { status: st.status as 'paid' | 'refused' };
    if (this.paused()) return { status: 'paused' };
    if (l.paidTotal > cfg.ops.maxRoundPayoutQuote) {
      st.status = 'refused';
      this.save();
      await alerts.send(
        `REFUSED epoch ${l.epochIndex}: drop of ${fmt(l.paidTotal)} IMD exceeds MAX_ROUND_PAYOUT_QUOTE ${fmt(cfg.ops.maxRoundPayoutQuote)}`,
      );
      return { status: 'refused', detail: 'exceeds maxRoundPayoutQuote' };
    }

    // Which chunks are still unpaid (on-chain truth from the priority node).
    const unpaid = [];
    for (const c of l.chunks) {
      const key = c.roundId.toString();
      if (st.chunks[key]?.paid || (await ops.isPaid(c.roundId))) {
        st.chunks[key] = { tx: st.chunks[key]?.tx ?? null, paid: true };
      } else unpaid.push(c);
    }
    if (unpaid.length === 0) return this.finish(l, st);
    const need = unpaid.reduce((s, c) => s + c.amounts.reduce((a, b) => a + b, 0n), 0n);

    // 1. Fund once per drop, proven by the receipt's Transfer log.
    if (!st.funding) {
      const owner = cfg.launch.payoutWallet;
      const spender = cfg.launch.roundPayout;
      if ((await ops.imdAllowance(owner, spender)) < need) {
        if (this.paused()) return { status: 'paused' };
        const r = await ops.send('imd', 'approve', [spender, need]);
        if (r.status !== 'success') return this.fail(l, `approve reverted ${r.hash}`);
      }
      if (this.paused()) return { status: 'paused' };
      const r = await ops.send('roundPayout', 'fund', [IMD, need]);
      if (r.status !== 'success') return this.fail(l, `fund reverted ${r.hash}`);
      if (!fundingLogMatches(r, owner, spender, need)) {
        return this.fail(l, `fund receipt ${r.hash} has no IMD Transfer ${owner} -> ${spender} of ${need}`);
      }
      st.funding = { tx: r.hash, block: r.blockNumber.toString(), amount: need.toString() };
      this.save();
      this.log('funded', { epoch: l.epochIndex, tx: r.hash, amount: need.toString() });
    }

    // 2. Prove the balance on the priority node. A node that has not reached the funding block yet
    //    (or reports a stale zero) is waited for, never treated as a failed round.
    const proven = await this.proveBalance(need, BigInt(st.funding.block));
    if (!proven) {
      this.save();
      this.log('funding not yet visible on priority node; deferring', { epoch: l.epochIndex });
      return { status: 'deferred', detail: 'funding balance not visible yet' };
    }

    // 3. Pay chunk by chunk, re-checking isPaid before each send.
    const hash = ledgerHash(l);
    for (const c of unpaid) {
      const key = c.roundId.toString();
      if (this.paused()) {
        this.save();
        return { status: 'paused' };
      }
      if (await ops.isPaid(c.roundId)) {
        st.chunks[key] = { tx: st.chunks[key]?.tx ?? null, paid: true };
        continue;
      }
      const r = await ops.send('roundPayout', 'payRound', [
        c.roundId,
        IMD,
        c.payees.map((p) => getAddress(p)),
        c.amounts,
        hash,
        l.closeX96,
        l.totalEligibleLoss,
      ]);
      if (r.status !== 'success') return this.fail(l, `payRound ${key} reverted ${r.hash}`);
      st.chunks[key] = { tx: r.hash, paid: true };
      for (const p of c.payees) {
        const f = await ops.failedAmount(c.roundId, getAddress(p));
        if (f > 0n) {
          (st.failed[key] ??= {})[p] = { amount: f.toString(), attempts: 0, status: 'open' };
          await alerts.send(`leg failed: round ${key} -> ${p} (${fmt(f)} IMD); will retry`);
        }
      }
      this.save();
    }
    return this.finish(l, st);
  }

  private async finish(l: Ledger, st: DropState): Promise<DropResult> {
    st.status = 'paid';
    this.save();
    const n = l.entries.filter((e) => e.amount > 0n).length;
    await this.o.alerts.send(
      `paid epoch ${l.epochIndex}: ${fmt(l.paidTotal)} IMD to ${n} wallets in ${l.chunks.length} tx (ledger ${ledgerHash(l)})`,
    );
    return { status: 'paid' };
  }

  private async fail(l: Ledger, detail: string): Promise<DropResult> {
    this.save();
    await this.o.alerts.send(`FAILED epoch ${l.epochIndex}: ${detail}`);
    return { status: 'error', detail };
  }

  private async proveBalance(need: bigint, fundBlock: bigint): Promise<boolean> {
    const { ops, cfg } = this.o;
    for (let i = 0; i < cfg.exec.fundingProofAttempts; i++) {
      const head = await ops.blockNumber();
      if (head >= fundBlock) {
        const bal = await ops.imdBalanceOf(cfg.launch.roundPayout, head);
        if (bal >= need) return true;
      }
      await this.sleep(cfg.exec.fundingProofDelayMs);
    }
    return false;
  }

  /** retryFailed for open legs; after maxLegRetries attempts a leg is written off. */
  async retryFailedLegs(): Promise<void> {
    const { ops, alerts, cfg } = this.o;
    for (const st of Object.values(this.state.drops)) {
      for (const [roundId, legs] of Object.entries(st.failed)) {
        const open = Object.entries(legs).filter(([, l]) => l.status === 'open');
        if (open.length === 0 || this.paused()) continue;
        const retry = open.filter(([, l]) => l.attempts < cfg.exec.maxLegRetries).map(([p]) => p);
        const writeOff = open.filter(([, l]) => l.attempts >= cfg.exec.maxLegRetries).map(([p]) => p);
        if (retry.length) {
          await ops.send('roundPayout', 'retryFailed', [BigInt(roundId), retry.map((p) => getAddress(p))]);
          for (const p of retry) {
            legs[p].attempts++;
            if ((await ops.failedAmount(BigInt(roundId), getAddress(p))) === 0n) legs[p].status = 'resolved';
          }
        }
        for (const p of writeOff) {
          await ops.send('roundPayout', 'writeOffFailed', [BigInt(roundId), getAddress(p)]);
          legs[p].status = 'written-off';
          await alerts.send(`leg written off: round ${roundId} -> ${p} (${fmt(BigInt(legs[p].amount))} IMD)`);
        }
        this.save();
      }
    }
  }
}

export function fundingLogMatches(r: TxReceiptLite, from: Address, to: Address, amount: bigint): boolean {
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  return r.logs.some(
    (lg) =>
      lg.address.toLowerCase() === IMD.toLowerCase() &&
      lg.topics[0] === TOPIC.transfer &&
      lg.topics[1]?.toLowerCase() === pad(from) &&
      lg.topics[2]?.toLowerCase() === pad(to) &&
      decodeAbiParameters([{ type: 'uint256' }], lg.data)[0] === amount,
  );
}

/** ChainOps backed by the priority node for reads and the payout signer for writes. */
export function liveChainOps(cfg: Config, chain: ChainReader, signer: Signer): ChainOps {
  const pinned = chain.pinned();
  const rp = cfg.launch.roundPayout;
  const rpAbi = (cfg.launch.roundPayoutAbi ?? defaultRoundPayoutAbi) as Abi;
  return {
    blockNumber: () => pinned.getBlockNumber({ cacheTime: 0 }),
    imdBalanceOf: (addr, block) =>
      pinned.readContract({ address: IMD, abi: erc20Abi, functionName: 'balanceOf', args: [addr], blockNumber: block }),
    imdAllowance: (owner, spender) =>
      pinned.readContract({ address: IMD, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    isPaid: async (roundId) =>
      (await pinned.readContract({ address: rp, abi: rpAbi, functionName: 'isPaid', args: [roundId] })) as boolean,
    failedAmount: async (roundId, to) =>
      BigInt((await pinned.readContract({ address: rp, abi: rpAbi, functionName: 'failed', args: [roundId, to] })) as bigint),
    send: (target, fn, args) =>
      target === 'imd'
        ? signer.send({ address: IMD, abi: erc20Abi as Abi, functionName: fn, args })
        : signer.send({ address: rp, abi: rpAbi, functionName: fn, args }),
  };
}
