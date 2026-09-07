import type { Command } from 'commander';
import type { CloudClient } from '@agent-cloud/sdk';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  CloudError,
  hostingCommandIdSchema,
  hostnameSchema,
  machineIdSchema,
  routeNameSchema,
} from '@agent-cloud/contracts';

export function registerHosting(input: {
  program: Command;
  client: () => Promise<CloudClient>;
  output: (value: unknown) => void;
}) {
  const route = input.program
    .command('route')
    .description('Publish versioned HTTPS routes through the cloud gateway.');
  route.command('list').action(async () => {
    input.output(await (await input.client()).routes());
  });
  route.command('inspect <hostname>').action(async (hostname: string) => {
    input.output(await (await input.client()).route(hostnameSchema.parse(hostname)));
  });
  route
    .command('publish <machine>')
    .requiredOption('--port <number>', 'Loopback application port')
    .requiredOption('--key <uuid>', 'Stable command ID; reuse after an uncertain response')
    .option('--name <name>', 'Generated application hostname name')
    .option('--hostname <hostname>', 'Verified custom hostname')
    .option('--challenge <uuid>', 'Fresh verified challenge for the custom hostname')
    .option('--expected-version <number>', 'Current route version; omit only for first publication')
    .action(async (machine: string, raw: unknown) => {
      const options = z
        .object({
          port: z.coerce.number().int(),
          key: hostingCommandIdSchema,
          name: routeNameSchema.optional(),
          hostname: hostnameSchema.optional(),
          challenge: z.uuidv4().optional(),
          expectedVersion: z.coerce.number().int().positive().optional(),
        })
        .parse(raw);
      if (
        (options.name && (options.hostname || options.challenge)) ||
        (!options.name && (!options.hostname || !options.challenge))
      )
        throw new CloudError(
          'invalid_input',
          'Use either --name or both --hostname and --challenge.',
        );
      const destination = options.name
        ? ({ kind: 'generated', name: options.name } satisfies Parameters<
            CloudClient['publishRoute']
          >[0]['destination'])
        : ({
            kind: 'custom',
            hostname: hostnameSchema.parse(options.hostname),
            challengeId: z.uuidv4().parse(options.challenge),
          } satisfies Parameters<CloudClient['publishRoute']>[0]['destination']);
      input.output(
        await (
          await input.client()
        ).publishRoute({
          commandId: options.key,
          machineId: machineIdSchema.parse(machine),
          destination,
          port: options.port,
          expectedVersion: options.expectedVersion ?? null,
        }),
      );
    });
  route
    .command('remove <hostname>')
    .requiredOption('--expected-version <number>')
    .requiredOption('--key <uuid>')
    .action(async (hostname: string, raw: unknown) => {
      const options = z
        .object({
          key: hostingCommandIdSchema,
          expectedVersion: z.coerce.number().int().positive(),
        })
        .parse(raw);
      input.output(
        await (
          await input.client()
        ).removeRoute(hostnameSchema.parse(hostname), {
          commandId: options.key,
          expectedVersion: options.expectedVersion,
        }),
      );
    });
  route
    .command('wait <hostname>')
    .option(
      '--timeout <seconds>',
      'Maximum local wait; admitted work continues after disconnect',
      '120',
    )
    .action(async (hostname: string, raw: unknown) => {
      const options = z.object({ timeout: z.coerce.number().int().min(1).max(600) }).parse(raw);
      const client = await input.client();
      const deadline = performance.now() + options.timeout * 1000;
      for (;;) {
        const result = await client.route(hostnameSchema.parse(hostname));
        if (
          result.route.gatewayAppliedVersion === result.route.version &&
          result.route.state !== 'pending'
        ) {
          input.output(result);
          return;
        }
        if (result.route.application.kind === 'blocked')
          throw new CloudError(
            'guest_unreachable',
            'Route could not be applied after five attempts. Inspect the machine and submit a new command with the current expected version.',
          );
        if (performance.now() >= deadline)
          throw new CloudError(
            'provider_unavailable',
            'Route wait timed out. Inspect the same hostname before retrying a change.',
            true,
          );
        await setTimeout(1000);
      }
    });
  const domain = input.program
    .command('domain')
    .description('Prove custom hostname ownership with DNS.');
  domain.command('add <hostname>').action(async (hostname: string) => {
    input.output(await (await input.client()).createDomain(hostnameSchema.parse(hostname)));
  });
  domain.command('verify <challenge>').action(async (challenge: string) => {
    input.output(await (await input.client()).verifyDomain(z.uuidv4().parse(challenge)));
  });
}
