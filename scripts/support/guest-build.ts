import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { imageDigestSchema } from '../../packages/contracts/dist/index.js';
import { verifyImageInputs } from '../../packages/images/dist/index.js';

export async function readGuestBuild() {
  const selection = process.env.AGENT_CLOUD_INPUT_DIGEST;
  const manifestDigest =
    selection === undefined
      ? z
          .strictObject({ manifestDigest: imageDigestSchema })
          .parse(JSON.parse(await readFile('.local/guest-build.json', 'utf8'))).manifestDigest
      : imageDigestSchema.parse(selection);
  const directory = resolve('.local/guest-builds', manifestDigest);
  const verified = await verifyImageInputs(directory, manifestDigest);
  return { directory, ...verified };
}
