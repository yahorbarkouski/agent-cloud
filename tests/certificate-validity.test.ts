import { expect, test } from 'vitest';
import { inspectValidity } from '../packages/pki/src/validity.js';

test('persisting after slow signing does not reinterpret issuedAt as signing start', () => {
  const now = Date.now();
  const input = { after: now - 120_000, before: now + 3_480_000, maximum: 3_600_000 };
  expect(() => {
    inspectValidity({ ...input, timing: { kind: 'installed', issuedAt: now } });
  }).not.toThrow();
  expect(() => {
    inspectValidity({ ...input, timing: { kind: 'signing', startedAt: now } });
  }).toThrow('validity');
});

test('installed certificates still reject expired, future and oversized validity periods', () => {
  const now = Date.now();
  const timing = { kind: 'installed', issuedAt: now } satisfies Parameters<
    typeof inspectValidity
  >[0]['timing'];
  for (const period of [
    { after: now - 3_600_000, before: now - 1 },
    { after: now + 1, before: now + 300_000 },
    { after: now - 7_200_000, before: now + 3_600_000 },
  ])
    expect(() => {
      inspectValidity({ ...period, maximum: 3_600_000, timing });
    }).toThrow('validity');
});
