import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { Signer, scrub } from '../src/wallet.js';
import { testConfig } from './helpers.js';

describe('payout key handling', () => {
  it('refuses a key that does not control the payout wallet, without echoing the key', () => {
    const pk = generatePrivateKey();
    let msg = '';
    try {
      new Signer({ ...testConfig(), rpc: { ...testConfig().rpc, urls: ['http://127.0.0.1:1'] } }, { PAYOUT_PRIVATE_KEY: pk });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not the payout wallet/);
    expect(msg).not.toContain(pk.slice(2));
  });

  it('rejects a missing key and scrubs a key from any message', () => {
    expect(() => new Signer(testConfig(), {})).toThrow(/PAYOUT_PRIVATE_KEY missing/);
    const pk = generatePrivateKey();
    expect(scrub(`boom ${pk} and ${pk.slice(2)}`, pk)).toBe('boom <redacted> and <redacted>');
  });

  it('the config object never carries the key', () => {
    const pk = generatePrivateKey();
    const cfg = testConfig({ PAYOUT_PRIVATE_KEY: pk });
    const dump = JSON.stringify(cfg, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Set ? [...v] : v));
    expect(dump).not.toContain(pk.slice(2));
    expect(cfg.exec.mode).toBe('dry-run');
  });
});
