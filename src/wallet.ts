// Payout signer. The key comes from PAYOUT_PRIVATE_KEY only; it is never logged, written to disk or
// included in error messages. Nonces are managed locally; every send waits for a receipt with
// `confirmationBlocks` confirmations or times out.
import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID, type Config } from './config.js';

export interface TxReceiptLite {
  hash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: { address: Hex; topics: Hex[]; data: Hex }[];
}

export interface SendRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args: unknown[];
}

export const robinhood = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/** Remove anything that looks like a 32-byte secret from a message before it is logged. */
export function scrub(msg: string, secret?: string): string {
  let out = msg;
  if (secret) out = out.split(secret).join('<redacted>').split(secret.replace(/^0x/, '')).join('<redacted>');
  return out;
}

export class Signer {
  readonly address: Address;
  private nonce: number | null = null;
  private readonly wallet;
  private readonly reader: PublicClient;
  private readonly scrubKey: (m: string) => string;

  constructor(
    private readonly cfg: Config,
    env: Record<string, string | undefined> = process.env,
  ) {
    const pk = env.PAYOUT_PRIVATE_KEY;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('PAYOUT_PRIVATE_KEY missing or malformed (0x + 64 hex)');
    const account = privateKeyToAccount(pk as Hex);
    this.scrubKey = (m) => scrub(m, pk);
    this.address = account.address;
    if (account.address.toLowerCase() !== cfg.launch.payoutWallet.toLowerCase()) {
      throw new Error(`PAYOUT_PRIVATE_KEY controls ${account.address}, not the payout wallet ${cfg.launch.payoutWallet}`);
    }
    const url = cfg.rpc.priorityUrl ?? cfg.rpc.urls[0];
    this.wallet = createWalletClient({ account, chain: robinhood, transport: http(url) });
    this.reader = createPublicClient({ chain: robinhood, transport: http(url), pollingInterval: cfg.rpc.pollMs }) as PublicClient;
  }

  private async nextNonce(): Promise<number> {
    if (this.nonce === null) {
      this.nonce = await this.reader.getTransactionCount({ address: this.address, blockTag: 'pending' });
    }
    return this.nonce++;
  }

  async send(req: SendRequest): Promise<TxReceiptLite> {
    try {
      const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
      // Simulate first so a revert costs nothing and never consumes a nonce.
      await this.reader.call({ account: this.address, to: req.address, data });
      const nonce = await this.nextNonce();
      let hash: Hex;
      try {
        hash = await this.wallet.sendTransaction({ to: req.address, data, nonce });
      } catch (e) {
        this.nonce = null; // resync from chain on the next send
        throw e;
      }
      const r = await this.reader.waitForTransactionReceipt({
        hash,
        confirmations: this.cfg.exec.confirmationBlocks,
        timeout: this.cfg.exec.txTimeoutMs,
        pollingInterval: this.cfg.rpc.pollMs,
      });
      return {
        hash,
        status: r.status,
        blockNumber: r.blockNumber,
        logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data })),
      };
    } catch (e) {
      throw new Error(this.scrubKey(`${req.functionName} failed: ${(e as Error).message?.split('\n')[0]}`));
    }
  }
}
