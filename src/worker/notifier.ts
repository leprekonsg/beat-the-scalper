/**
 * Restock notifiers. The worker calls `notify` without awaiting it: delivery must never delay the
 * tick, and a failed delivery is recorded as an event, never thrown.
 *
 * `WebhookNotifier` posts plain text with ntfy-style headers (Title, Priority, Click, Tags), so an
 * ntfy topic URL (https://ntfy.sh/<topic> or a self-hosted server) reaches a phone with no extra
 * service; any endpoint that accepts a text POST also works. It is off unless BTS_ALERT_WEBHOOK_URL
 * is set, and sends only the product title, price, seller, URL and unresolved checks.
 */

export interface RestockNotification {
  kind: 'go' | 'retract';
  missionId: string;
  headline: string;
  /** Lines shown under the headline (unresolved checks, or the retraction reason). */
  details: string[];
  productUrl: string | null;
  at: string;
  /** A timing drill (scripts/alert-drill.ts): same delivery path and priority, titled as a test. */
  drill?: boolean;
}

export interface RestockNotifier {
  readonly name: string;
  notify(n: RestockNotification): Promise<void>;
}

export function notificationText(n: RestockNotification): string {
  const lines = [n.headline, ...n.details.map((d) => `- ${d}`)];
  if (n.productUrl) lines.push(n.productUrl);
  return lines.join('\n');
}

/** Terminal bell plus one log line. Always on for the server and live harnesses. */
export class ConsoleNotifier implements RestockNotifier {
  readonly name = 'console';
  constructor(private readonly write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {}
  async notify(n: RestockNotification): Promise<void> {
    this.write(`\x07[BTS ${n.kind === 'go' ? 'RESTOCK' : 'RETRACTED'}] ${notificationText(n).replace(/\n/g, ' | ')}`);
  }
}

export class WebhookNotifier implements RestockNotifier {
  readonly name = 'webhook';
  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      throw new Error(`BTS_ALERT_WEBHOOK_URL must be https (or loopback http), got ${u.protocol}//${u.hostname}`);
    }
  }
  async notify(n: RestockNotification): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: `${n.drill ? 'BTS drill (test, not a restock): ' : 'BTS: '}${n.kind === 'go' ? 'in stock now' : 'do not buy'}`,
      Priority: n.kind === 'go' ? 'urgent' : 'high',
      Tags: n.kind === 'go' ? 'restock' : 'retracted',
    };
    if (n.productUrl && n.kind === 'go') headers.Click = n.productUrl;
    const res = await this.fetchFn(this.url, { method: 'POST', headers, body: notificationText(n), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`webhook responded HTTP ${res.status}`);
  }
}

/** Fans out to every notifier; rejects with every failure message if any delivery failed. */
export class MultiNotifier implements RestockNotifier {
  readonly name: string;
  constructor(private readonly notifiers: RestockNotifier[]) {
    this.name = notifiers.map((x) => x.name).join('+');
  }
  async notify(n: RestockNotification): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((x) => x.notify(n)));
    const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${this.notifiers[i]!.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []));
    if (failures.length > 0) throw new Error(failures.join('; '));
  }
}

export function createNotifier(opts: { webhookUrl: string | null; log?: (line: string) => void }): RestockNotifier {
  const console = new ConsoleNotifier(opts.log);
  return opts.webhookUrl ? new MultiNotifier([console, new WebhookNotifier(opts.webhookUrl)]) : console;
}
