import { expect, it } from 'vitest';
import { createWorkerLogger } from '../apps/control/dist/worker-logger.js';

it('keeps failed SQL parameters, error metadata and untrusted scope values out of worker logs', () => {
  const lines: string[] = [];
  const logger = createWorkerLogger((line) => {
    lines.push(line);
  });
  logger
    .scope({ jobId: '42', taskIdentifier: 'advance_image_build' })
    .error('Failed query; params: private-bootstrap-token', {
      error: new Error('private-password'),
    });
  logger
    .scope({ jobId: 'private-token', taskIdentifier: 'private command --secret' })
    .warn('private-application-data');
  logger.info('private-unstructured-message');
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({ jobId: '42', task: 'advance_image_build' });
  expect(lines.join('')).not.toContain('private');
});
