import { CloudError } from '@agent-cloud/contracts';
import { createSigner, createCustomerSshSigner } from '@agent-cloud/pki';
import { readPrivateFile, readPublicTrustFile } from './private-file.js';
import type { RuntimeConfig } from './runtime-config.js';

async function readSignerConfiguration(config: RuntimeConfig['pki']) {
  try {
    const [tlsRoot, sshHostCa, sshUserCa, provisionerPassword] = await Promise.all([
      readPublicTrustFile(config.tlsRootFile),
      readPublicTrustFile(config.sshHostCaFile),
      readPublicTrustFile(config.sshUserCaFile),
      readPrivateFile(config.provisionerPasswordFile),
    ]);
    return {
      binary: config.binary,
      caUrl: config.caUrl,
      provisioner: config.provisioner,
      tlsRoot,
      sshHostCa,
      sshUserCa,
      provisionerPassword,
    };
  } catch {
    throw new CloudError('permission_denied', 'PKI configuration is unavailable or invalid.');
  }
}
export async function readRuntimeSigner(config: RuntimeConfig['pki']) {
  return createSigner(await readSignerConfiguration(config));
}
export async function readRuntimeCustomerSigner(config: RuntimeConfig['pki']) {
  return createCustomerSshSigner(await readSignerConfiguration(config));
}
