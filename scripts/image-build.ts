import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  CloudError,
  imageBuildAdmissionSchema,
  imageBuildIdSchema,
  imageBuildLimitsSchema,
  selectOffer,
  sizeSchema,
  regionSchema,
} from '../packages/contracts/dist/index.js';
import { connect } from '../packages/db/dist/index.js';
import { verifyImageInputs } from '../packages/images/dist/index.js';
import {
  createHetznerRequest,
  readHetznerCatalog,
  offerConfigurationSchema,
} from '../packages/hetzner/dist/index.js';
import { readHetznerImagePrice } from '../packages/hetzner/dist/image-pricing.js';
import {
  admitImageBuild,
  inspectImageBuild,
  requestImageCleanup,
} from '../apps/control/dist/image-builds.js';
import { readPrivateFile } from '../apps/control/dist/private-file.js';
import { createImageAccessStore } from '../apps/control/dist/image-access.js';

const configSchema = z.strictObject({
  id: imageBuildIdSchema,
  sourceDirectory: z.string().min(1),
  manifestDigest: imageBuildAdmissionSchema.shape.source.shape.manifestDigest,
  offer: z.strictObject({ size: sizeSchema, region: regionSchema }),
  provider: offerConfigurationSchema,
  baseImageId: imageBuildAdmissionSchema.shape.baseImageId,
  access: imageBuildAdmissionSchema.shape.access,
  budget: imageBuildAdmissionSchema.shape.budget,
  limits: imageBuildLimitsSchema,
  durationMinutes: z.int().positive().max(1440),
  retention: imageBuildAdmissionSchema.shape.retention,
});
const prepareSchema = configSchema.extend({
  access: imageBuildAdmissionSchema.shape.access.pick({ managementAddress: true }),
});
async function readConfiguration(argument: string): Promise<unknown> {
  const bytes = await readFile(resolve(argument));
  if (bytes.length > 65_536) throw new Error('Image build configuration exceeds 64 KiB.');
  return JSON.parse(bytes.toString('utf8'));
}

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (
    !['prepare', 'admit', 'inspect', 'cancel'].includes(command ?? '') ||
    !argument ||
    extra.length
  )
    throw new Error(
      'Usage: pnpm image:build prepare <config.json> | admit <config.json> | inspect <build-id> | cancel <build-id>',
    );
  const store = createImageAccessStore({
    directory: resolve(process.env.IMAGE_ACCESS_DIRECTORY ?? '.local/image-access'),
  });
  if (command === 'prepare') {
    const config = prepareSchema.parse(await readConfiguration(argument));
    const sourceDirectory = resolve(config.sourceDirectory);
    const source = await verifyImageInputs(sourceDirectory, config.manifestDigest);
    const access = await store.prepare({
      buildId: config.id,
      manifestDigest: source.manifestDigest,
      managementAddress: config.access.managementAddress,
    });
    return { ...config, sourceDirectory, access };
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required. Apply database migrations first.');
  const connection = connect(url);
  try {
    if (command === 'admit') {
      const config = configSchema.parse(await readConfiguration(argument));
      const sourceDirectory = resolve(config.sourceDirectory);
      const source = await verifyImageInputs(sourceDirectory, config.manifestDigest);
      let previous;
      try {
        previous = await inspectImageBuild(connection.db, config.id);
      } catch (error) {
        if (!(error instanceof CloudError) || error.failure.code !== 'not_found') throw error;
      }
      if (previous) {
        const original = previous.admission;
        const replay = imageBuildAdmissionSchema.parse({
          ...original,
          source,
          baseImageId: config.baseImageId,
          access: config.access,
          budget: config.budget,
          retention: config.retention,
        });
        if (
          JSON.stringify(replay) !== JSON.stringify(original) ||
          config.offer.size !== original.offer.size ||
          config.offer.region !== original.offer.region ||
          config.provider.serverTypes[config.offer.size] !== original.offer.serverType ||
          config.provider.currency !== original.offer.currency ||
          config.provider.architecture !== original.offer.architecture ||
          config.durationMinutes * 60_000 !==
            Date.parse(original.deadlineAt) - Date.parse(original.admittedAt)
        )
          throw new CloudError(
            'idempotency_conflict',
            'This build ID already describes a different admission.',
          );
        return previous;
      }
      await store.recover({ id: config.id, source, access: config.access });
      const request = createHetznerRequest({
        token: await readPrivateFile(
          resolve(process.env.HCLOUD_TOKEN_FILE ?? '.local/hcloud-token'),
        ),
      });
      const [catalog, storagePrice] = await Promise.all([
        readHetznerCatalog({ request, configuration: config.provider }),
        readHetznerImagePrice(request),
      ]);
      const now = Date.now();
      const admission = imageBuildAdmissionSchema.parse({
        id: config.id,
        provider: 'hetzner',
        source,
        offer: selectOffer({ catalog, ...config.offer, now }),
        storagePrice,
        baseImageId: config.baseImageId,
        access: config.access,
        budget: config.budget,
        admittedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + config.durationMinutes * 60_000).toISOString(),
        retention: config.retention,
      });
      await admitImageBuild({
        db: connection.db,
        admission,
        sourceDirectory,
        catalog,
        limits: config.limits,
      });
      return await inspectImageBuild(connection.db, config.id);
    }
    const id = imageBuildIdSchema.parse(argument);
    if (command === 'cancel') await requestImageCleanup(connection.db, id);
    return await inspectImageBuild(connection.db, id);
  } finally {
    await connection.pool.end();
  }
}

try {
  process.stdout.write(JSON.stringify(await main()) + '\n');
} catch (error) {
  // Input validation and transport failures must not echo configuration or credentials.
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof CloudError
          ? error.failure
          : {
              code: 'invalid_input',
              message:
                'Image build command failed; check its configuration, database and provider access.',
            },
    }) + '\n',
  );
  process.exitCode = 1;
}
