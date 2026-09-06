import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readPrivateFile } from '../apps/control/src/private-file.js';

it('reads only bounded private regular files and refuses a symlink at the open boundary', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-cloud-secret-test-'));
  try {
    const path = join(folder, 'fake-token');
    await writeFile(path, 'fake test credential\n', { mode: 0o600 });
    expect(await readPrivateFile(path)).toBe('fake test credential');
    const link = join(folder, 'link');
    await symlink(path, link);
    await expect(readPrivateFile(link)).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(readPrivateFile(path)).rejects.toThrow('owner-only');
    await chmod(path, 0o600);
    await writeFile(path, 'x'.repeat(16_385));
    await expect(readPrivateFile(path)).rejects.toThrow('small');
    await expect(readPrivateFile(folder)).rejects.toThrow('regular file');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
