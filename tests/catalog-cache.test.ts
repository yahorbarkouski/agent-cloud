import { afterEach, expect, it, vi } from 'vitest';
import { CatalogCache } from '../apps/control/src/catalog-cache.js';
import {
  CloudError,
  selectOffer,
  simulatedCatalog,
  type Catalog,
} from '../packages/contracts/dist/index.js';

afterEach(() => {
  vi.useRealTimers();
});
function cache(load: (signal: AbortSignal) => Promise<Catalog>) {
  return new CatalogCache({ provider: 'simulated', currency: 'EUR', load, onFailure: () => {} });
}

it('publishes immutable snapshots and merges simultaneous refresh requests', async () => {
  const deferred = Promise.withResolvers<Catalog>();
  const load = vi.fn(() => deferred.promise);
  const source = cache(load);
  expect(() => source.snapshot()).toThrow('No verified');
  const first = source.refresh();
  expect(source.refresh()).toBe(first);
  expect(load).toHaveBeenCalledTimes(1);
  deferred.resolve(simulatedCatalog());
  await first;
  const returned = source.snapshot();
  returned.items.length = 0;
  expect(source.snapshot().items.length).toBeGreaterThan(0);
  source.stop();
});

it('keeps an unexpired snapshot through an outage but expiry still blocks fresh admission', async () => {
  vi.useFakeTimers();
  const load = vi.fn(() => Promise.resolve(simulatedCatalog()));
  const source = cache(load);
  await source.refresh();
  load.mockRejectedValue(new Error('Provider unavailable'));
  await expect(source.refresh()).rejects.toThrow();
  expect(selectOffer({ catalog: source.snapshot(), size: 'small', region: 'nbg1' }).currency).toBe(
    'EUR',
  );
  vi.advanceTimersByTime(300_001);
  expect(() => selectOffer({ catalog: source.snapshot(), size: 'small', region: 'nbg1' })).toThrow(
    'stale',
  );
  source.stop();
});

it('withdraws cached prices when the account currency or provider identity changes', async () => {
  for (const change of [
    () => Promise.resolve(simulatedCatalog('USD')),
    () => Promise.reject(new CloudError('budget_exceeded', 'Account currency changed.')),
  ]) {
    const load = vi.fn(() => Promise.resolve(simulatedCatalog()));
    const source = cache(load);
    await source.refresh();
    load.mockImplementation(change);
    await expect(source.refresh()).rejects.toThrow();
    expect(() => source.snapshot()).toThrow('No verified');
    source.stop();
  }
});

it('runs a single periodic loop, aborts an in-flight read on shutdown, and ignores late results', async () => {
  vi.useFakeTimers();
  const deferred = Promise.withResolvers<Catalog>();
  let readSignal: AbortSignal | undefined;
  const load = vi.fn((signal: AbortSignal) => {
    readSignal = signal;
    return deferred.promise;
  });
  const source = cache(load);
  source.start();
  source.start();
  await vi.advanceTimersByTimeAsync(1200 * 60);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(load).toHaveBeenCalledTimes(1);
  source.stop();
  expect(readSignal?.aborted).toBe(true);
  deferred.resolve(simulatedCatalog());
  await source.refresh();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(load).toHaveBeenCalledTimes(1);
  expect(() => source.snapshot()).toThrow('No verified');
});
