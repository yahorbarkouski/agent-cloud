import { simulatedCatalog } from '@agent-cloud/contracts';
import { createHetznerRequest, readHetznerCatalog } from '@agent-cloud/hetzner';
import type { Config } from './config.js';
import { CatalogCache } from './catalog-cache.js';
import { readPrivateFile } from './private-file.js';

/** Read-only runtime: this module has no VM/IP submission dependency. */
export function createCatalogRuntime(config: Config, onFailure: () => void) {
  return new CatalogCache({
    provider: config.provider,
    currency: config.limits.currency,
    load: async (signal) => {
      if (config.provider === 'simulated') return simulatedCatalog(config.limits.currency);
      const request = createHetznerRequest({
        token: await readPrivateFile(config.providerTokenFile),
        signal,
      });
      return readHetznerCatalog({ request, configuration: config.offers });
    },
    onFailure,
  });
}
