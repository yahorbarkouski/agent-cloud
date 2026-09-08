import { Logger } from 'graphile-worker';

/** Database errors can embed SQL parameters. Runtime logs contain only bounded job identifiers. */
export function createWorkerLogger(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
) {
  return new Logger((scope) => (level) => {
    if (!['error', 'warning'].includes(level)) return;
    write(
      JSON.stringify({
        event: 'worker.runtime_error',
        level,
        ...(scope.taskIdentifier && /^[a-z_]{1,100}$/.test(scope.taskIdentifier)
          ? { task: scope.taskIdentifier }
          : {}),
        ...(scope.jobId && /^[0-9]{1,20}$/.test(scope.jobId) ? { jobId: scope.jobId } : {}),
      }) + '\n',
    );
  });
}
