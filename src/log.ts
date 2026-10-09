// One-line JSON logs. Callers never pass secrets; values are stringified (bigints as decimals).
export function makeLog(app: string) {
  return (msg: string, extra: Record<string, unknown> = {}) =>
    console.log(
      JSON.stringify({ at: new Date().toISOString(), app, msg, ...extra }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
}

export function fmtImd(wei: bigint): string {
  const neg = wei < 0n;
  const s = (neg ? -wei : wei).toString().padStart(19, '0');
  return `${neg ? '-' : ''}${s.slice(0, -18)}.${s.slice(-18, -12)}`;
}
