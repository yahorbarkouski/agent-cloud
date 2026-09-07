import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Fixed executable/argv callers only. Never expose process stderr, which may contain private paths or data. */
export async function runTool(binary: string, args: string[], directory: string) {
  try {
    const { stdout } = await promisify(execFile)(binary, args, {
      cwd: directory,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', STEPPATH: directory },
      timeout: 20_000,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
    });
    return stdout;
  } catch {
    throw new Error('Guest system tool failed.');
  }
}
