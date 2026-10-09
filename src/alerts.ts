// Telegram alerts (paid / failed / stalled) and a heartbeat. Without a bot token alerts go to stdout.
import type { Ops } from './config.js';

export class Alerts {
  constructor(
    private readonly ops: Pick<Ops, 'telegramToken' | 'telegramChatId' | 'heartbeatMinutes'>,
    private readonly prefix = '[moneyback]',
  ) {}

  async send(text: string): Promise<void> {
    const msg = `${this.prefix} ${text}`;
    console.log(JSON.stringify({ at: new Date().toISOString(), alert: msg }));
    const { telegramToken: token, telegramChatId: chat } = this.ops;
    if (!token || !chat) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'telegram send failed', error: (e as Error).message }));
    }
  }

  /** Periodic "still alive" message with a status line from `describe`. */
  heartbeat(describe: () => string): NodeJS.Timeout {
    return setInterval(() => void this.send(`heartbeat: ${describe()}`), this.ops.heartbeatMinutes * 60_000);
  }
}
