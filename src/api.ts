// Read-only HTTP API: GET /api/status, GET /api/wallet/:address (eligibility, entry, loss, paid and a
// next-drop estimate computed with the SAME eligibility and payout code as the rounds), and static
// files under /data/*.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, normalize } from 'node:path';
import { isAddress } from 'viem';
import type { Config } from './config.js';
import { evaluateWallet } from './eligibility.js';
import { estimateNextDrop } from './rounds.js';
import { loadHistory, toJson } from './snapshot.js';

type Loaded = NonNullable<ReturnType<typeof loadHistory>>;

export function walletView(loaded: Loaded, address: string, nowTs: number) {
  const a = address.toLowerCase();
  const { hist, input } = loaded;
  const last = hist.epochs.filter((e) => e.closeX96 !== null).pop();
  const ledger = hist.rebuilder.state.wallets.get(a);
  const status =
    ledger && last
      ? evaluateWallet(ledger, {
          closeX96: last.closeX96!,
          minBuy: input.rules.minBuy,
          excluded: input.excluded,
          contracts: input.contracts,
        })
      : null;
  const estimate = estimateNextDrop(hist, input, nowTs);
  const next = estimate?.entries.find((e) => e.payee === a);
  return {
    address: a,
    known: !!ledger,
    asOfEpoch: last?.epochIndex ?? null,
    eligible: status?.eligible ?? false,
    reason: status?.reason ?? (ledger ? 'no close price yet' : 'never held MONEYBACK'),
    heldQualifying: status?.heldQualifying ?? 0n,
    costBasis: status?.costBasis ?? 0n,
    entryX96: status?.entryX96 ?? 0n,
    lossAtLastClose: status?.loss ?? 0n,
    paid: hist.paidSoFar.get(a) ?? 0n,
    nextDropEstimate: next ? { loss: next.loss, amount: next.amount, closeX96: next.close } : null,
    buys: ledger?.buys ?? [],
    disqualified: ledger?.disqualified ?? null,
  };
}

export function startApi(cfg: Config): Server {
  let cache: { at: number; loaded: Loaded | null } = { at: 0, loaded: null };
  const loaded = () => {
    if (Date.now() - cache.at > 15_000) cache = { at: Date.now(), loaded: loadHistory(cfg) };
    return cache.loaded;
  };
  const dataDir = cfg.ops.dataDir;
  const send = (res: any, code: number, body: string, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(body);
  };
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method !== 'GET') return send(res, 405, '{"error":"GET only"}');
      if (url.pathname === '/api/status') {
        const p = join(dataDir, 'status.json');
        return existsSync(p) ? send(res, 200, readFileSync(p, 'utf8')) : send(res, 503, '{"error":"no snapshot yet"}');
      }
      const m = /^\/api\/wallet\/([^/]+)$/.exec(url.pathname);
      if (m) {
        if (!isAddress(m[1], { strict: false })) return send(res, 400, '{"error":"bad address"}');
        const l = loaded();
        if (!l) return send(res, 503, '{"error":"index not ready"}');
        return send(res, 200, toJson(walletView(l, m[1], Math.floor(Date.now() / 1000))));
      }
      if (url.pathname.startsWith('/data/')) {
        const rel = normalize(url.pathname.slice('/data/'.length));
        if (rel.startsWith('..') || rel.includes('\0') || rel.startsWith('state') || rel.startsWith('index') || rel.startsWith('cache')) {
          return send(res, 404, '{"error":"not found"}');
        }
        const p = join(dataDir, rel);
        if (!p.startsWith(dataDir) || !existsSync(p) || !statSync(p).isFile() || !p.endsWith('.json')) {
          return send(res, 404, '{"error":"not found"}');
        }
        return send(res, 200, readFileSync(p, 'utf8'));
      }
      return send(res, 404, '{"error":"not found"}');
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(cfg.ops.apiPort, cfg.ops.apiHost);
  return server;
}
