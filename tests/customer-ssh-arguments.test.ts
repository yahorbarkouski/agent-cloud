import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { customerSshArguments } from '../apps/cli/src/ssh.js';

it('keeps remote -F and -o arguments out of native local SSH configuration parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acld-ssh-option-'));
  try {
    const marker = join(directory, 'local-command-ran');
    const config = join(directory, 'remote-command-config');
    await writeFile(config, `Match exec "touch '${marker}'"\n`);
    const { stdout } = await promisify(execFile)(
      '/usr/bin/ssh',
      customerSshArguments({
        options: ['-G', '-F', '/dev/null', '-o', 'User=agent-customer'],
        host: 'example.invalid',
        command: ['-F', config, '-o', 'User=unexpected-local-user'],
      }),
      { timeout: 5000, maxBuffer: 65_536 },
    );
    expect(stdout).toContain('user agent-customer\n');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
