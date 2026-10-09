// Fee realisation each epoch: hook.sweep() moves accrued IMD from the PoolManager to the payout
// wallet (permissionless), and the launch Merkle distributor is triggered so the 1% LP share lands.
import { parseAbi, type Abi } from 'viem';
import { hookAbi } from './abi.js';
import type { Config } from './config.js';
import type { ChainReader } from './rpc.js';
import type { Signer } from './wallet.js';

export class Fees {
  constructor(
    private readonly cfg: Config,
    private readonly chain: ChainReader,
    private readonly signer: Signer | null, // null in dry-run: reads only
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  /** Hook fees accrued but not yet swept (IMD wei). */
  async pending(): Promise<bigint> {
    return this.chain.client().readContract({ address: this.cfg.launch.hook, abi: hookAbi, functionName: 'pending' });
  }

  async sweep(): Promise<void> {
    if (!this.signer) return;
    const p = await this.pending();
    if (p === 0n) return;
    const r = await this.signer.send({ address: this.cfg.launch.hook, abi: hookAbi as Abi, functionName: 'sweep', args: [] });
    this.log('swept', { tx: r.hash, pending: p.toString(), status: r.status });
  }

  async triggerDistributor(): Promise<void> {
    const t = this.cfg.launch.distributorTrigger;
    if (!this.signer) return;
    if (!t) {
      this.log('distributorTrigger not set in launch.json; the 1% LP share is not being realised by the engine');
      return;
    }
    const abi = parseAbi([t.signature]) as Abi;
    const name = (abi[0] as { name: string }).name;
    const r = await this.signer.send({ address: this.cfg.launch.distributor, abi, functionName: name, args: t.args ?? [] });
    this.log('distributor triggered', { tx: r.hash, status: r.status });
  }

  /** Sweep then trigger; a failure in either is logged and does not block the round. */
  async realise(): Promise<void> {
    for (const step of [() => this.sweep(), () => this.triggerDistributor()]) {
      try {
        await step();
      } catch (e) {
        this.log('fee realisation step failed', { error: (e as Error).message });
      }
    }
  }
}
