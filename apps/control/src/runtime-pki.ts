import { CloudError } from '@agent-cloud/contracts';
import { createSigner } from '@agent-cloud/pki';
import { readPrivateFile, readPublicTrustFile } from './private-file.js';
import type { RuntimeConfig } from './runtime-config.js';

export async function readRuntimeSigner(config: RuntimeConfig['pki']) {
  try {
    const [tlsRoot, sshHostCa, sshUserCa, provisionerPassword] = await Promise.all([
      readPublicTrustFile(config.tlsRootFile),
      readPublicTrustFile(config.sshHostCaFile),
      readPublicTrustFile(config.sshUserCaFile),
      readPrivateFile(config.provisionerPasswordFile),
    ]);
    return createSigner({
      binary: config.binary,
      caUrl: config.caUrl,
      provisioner: config.provisioner,
      tlsRoot,
      sshHostCa,
      sshUserCa,
      provisionerPassword,
    });
  } catch {
    throw new CloudError('permission_denied', 'PKI configuration is unavailable or invalid.');
  }
}
