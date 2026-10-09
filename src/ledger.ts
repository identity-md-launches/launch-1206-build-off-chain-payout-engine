// The per-drop ledger: canonical JSON (fixed key order, integers as decimal strings, no whitespace),
// its keccak256 (passed to payRound as ledgerHash) and the files under data/ledgers/.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, stringToBytes, type Hex } from 'viem';

export interface LedgerEntry {
  payee: string; // lowercase address
  loss: bigint; // IMD wei at the close
  entry: bigint; // entry VWAP, Q96
  close: bigint; // close TWAP, Q96
  amount: bigint; // IMD wei paid this drop
}

export interface LedgerChunk {
  roundId: bigint;
  payees: string[];
  amounts: bigint[];
}

export interface Ledger {
  version: 1;
  epochIndex: number;
  boundaryTs: number;
  token: string;
  closeX96: bigint;
  pot: bigint;
  paidTotal: bigint;
  leftover: bigint;
  totalEligibleLoss: bigint;
  entries: LedgerEntry[];
  chunks: LedgerChunk[];
}

const s = (v: bigint) => JSON.stringify(v.toString());
const q = (v: string | number) => JSON.stringify(v);

/** Canonical serialisation. Key order is fixed here; entries are sorted by payee. */
export function canonicalLedger(l: Ledger): string {
  const entries = [...l.entries]
    .sort((a, b) => (a.payee < b.payee ? -1 : a.payee > b.payee ? 1 : 0))
    .map(
      (e) =>
        `{"payee":${q(e.payee.toLowerCase())},"loss":${s(e.loss)},"entry":${s(e.entry)},"close":${s(e.close)},"amount":${s(e.amount)}}`,
    );
  const chunks = l.chunks.map(
    (c) =>
      `{"roundId":${s(c.roundId)},"payees":[${c.payees.map((p) => q(p.toLowerCase())).join(',')}],"amounts":[${c.amounts.map(s).join(',')}]}`,
  );
  return (
    `{"version":${l.version},"epochIndex":${l.epochIndex},"boundaryTs":${l.boundaryTs},"token":${q(l.token.toLowerCase())},` +
    `"closeX96":${s(l.closeX96)},"pot":${s(l.pot)},"paidTotal":${s(l.paidTotal)},"leftover":${s(l.leftover)},` +
    `"totalEligibleLoss":${s(l.totalEligibleLoss)},"entries":[${entries.join(',')}],"chunks":[${chunks.join(',')}]}`
  );
}

export function ledgerHash(l: Ledger): Hex {
  return keccak256(stringToBytes(canonicalLedger(l)));
}

export function parseLedger(text: string): Ledger {
  const o = JSON.parse(text);
  const b = (v: string) => BigInt(v);
  return {
    version: 1,
    epochIndex: o.epochIndex,
    boundaryTs: o.boundaryTs,
    token: o.token,
    closeX96: b(o.closeX96),
    pot: b(o.pot),
    paidTotal: b(o.paidTotal),
    leftover: b(o.leftover),
    totalEligibleLoss: b(o.totalEligibleLoss),
    entries: o.entries.map((e: any) => ({
      payee: e.payee,
      loss: b(e.loss),
      entry: b(e.entry),
      close: b(e.close),
      amount: b(e.amount),
    })),
    chunks: o.chunks.map((c: any) => ({ roundId: b(c.roundId), payees: c.payees, amounts: c.amounts.map(b) })),
  };
}

export const ledgerFileName = (epochIndex: number) => `epoch-${String(epochIndex).padStart(7, '0')}.json`;

/** Write the canonical bytes; the file's keccak256 is exactly the on-chain ledgerHash. */
export function writeLedger(dir: string, l: Ledger): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, ledgerFileName(l.epochIndex));
  writeFileSync(`${p}.tmp`, canonicalLedger(l));
  renameSync(`${p}.tmp`, p);
  return p;
}

export function readLedger(dir: string, epochIndex: number): Ledger | null {
  const p = join(dir, ledgerFileName(epochIndex));
  return existsSync(p) ? parseLedger(readFileSync(p, 'utf8')) : null;
}

export function listLedgers(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^epoch-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}
