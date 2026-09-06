import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { CloudError } from '@agent-cloud/contracts';

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const sealedTokenSchema = z.strictObject({
  version: z.literal(1),
  nonce: base64.length(16),
  ciphertext: base64.length(60),
  tag: base64.length(24),
});
export type SealedToken = z.infer<typeof sealedTokenSchema>;
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The binding is canonical persisted allocation metadata, never a caller-provided context. */
export class BootstrapSeal {
  private readonly key: Buffer;
  constructor(encodedKey: string) {
    const key = Buffer.from(base64.parse(encodedKey), 'base64');
    if (key.length !== 32 || key.toString('base64') !== encodedKey)
      throw new Error('Bootstrap sealing key must be exactly 32 random bytes encoded as base64.');
    this.key = key;
  }

  issue(binding: string): { sealed: SealedToken; hash: string } {
    const token = randomBytes(32).toString('base64url');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(binding, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
      sealed: {
        version: 1,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
      hash: this.hash(token),
    };
  }

  recover(value: unknown, binding: string): string {
    try {
      const sealed = sealedTokenSchema.parse(value);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(sealed.nonce, 'base64'),
      );
      decipher.setAAD(Buffer.from(binding, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return tokenSchema.parse(
        Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch {
      throw new CloudError(
        'internal_error',
        'Guest bootstrap material could not be authenticated.',
      );
    }
  }

  matches(token: string, expectedHash: string): boolean {
    if (!tokenSchema.safeParse(token).success || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
    return timingSafeEqual(Buffer.from(this.hash(token), 'hex'), Buffer.from(expectedHash, 'hex'));
  }

  private hash(token: string) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
}
