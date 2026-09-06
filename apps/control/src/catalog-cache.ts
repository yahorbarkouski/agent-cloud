import { z } from 'zod';
import {
  CloudError,
  catalogResponseSchema,
  type Catalog,
  type CatalogSource,
  type MachineProvider,
} from '@agent-cloud/contracts';

type CatalogCacheOptions = {
  provider: MachineProvider['kind'];
  currency: string;
  load: (signal: AbortSignal) => Promise<Catalog>;
  onFailure: () => void;
  intervalMs?: number;
};

/** Periodic provider reads publish a whole validated snapshot; admission never waits on I/O. */
export class CatalogCache {
  private current: Catalog | undefined;
  private pending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly shutdown = new AbortController();
  private started = false;
  private readonly intervalMs: number;

  private readonly input: CatalogCacheOptions;

  constructor(input: CatalogCacheOptions) {
    this.input = input;
    this.intervalMs = z
      .int()
      .min(1000)
      .max(120_000)
      .parse(input.intervalMs ?? 60_000);
  }

  readonly snapshot: CatalogSource = () => {
    if (!this.current)
      throw new CloudError(
        'provider_unavailable',
        'No verified provider catalog is available yet.',
        true,
      );
    // Callers cannot mutate the next request's admitted prices.
    return structuredClone(this.current);
  };

  refresh(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async load() {
    try {
      const catalog = catalogResponseSchema.parse(await this.input.load(this.shutdown.signal));
      if (this.shutdown.signal.aborted) return;
      if (catalog.provider !== this.input.provider || catalog.currency !== this.input.currency) {
        this.current = undefined;
        throw new CloudError('budget_exceeded', 'Provider catalog identity or currency changed.');
      }
      const now = Date.now();
      if (Date.parse(catalog.expiresAt) <= now || Date.parse(catalog.observedAt) > now + 5000)
        throw new CloudError('provider_unavailable', 'Provider returned a stale catalog.', true);
      this.current = catalog;
    } catch (error) {
      // An account-currency change is not a transient network failure.
      if (error instanceof CloudError && error.failure.code === 'budget_exceeded')
        this.current = undefined;
      throw error;
    }
  }

  start(): void {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true;
    const schedule = () => {
      if (this.shutdown.signal.aborted) return;
      this.timer = setTimeout(
        () => {
          void this.refresh()
            .catch(() => {
              // The callback has no raw exception or provider response to accidentally log.
              if (!this.shutdown.signal.aborted) this.input.onFailure();
            })
            .finally(schedule);
        },
        Math.round(this.intervalMs * (0.8 + Math.random() * 0.4)),
      );
      this.timer.unref();
    };
    schedule();
  }

  stop(): void {
    this.shutdown.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}
