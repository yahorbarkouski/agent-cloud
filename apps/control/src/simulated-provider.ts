import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import {
  providerActionSchema,
  providerCommandSchema,
  providerServerSchema,
  type MachineProvider,
  type ProviderServer,
  type Submission,
  type ProviderAction,
} from '@agent-cloud/contracts';
import { simulatedServers, simulatedActions, type Database } from '@agent-cloud/db';

export type SimulationFault =
  | { kind: 'none' }
  | { kind: 'lose_response'; visibilityDelayMs: number }
  | { kind: 'timeout_before_submit' }
  | { kind: 'duplicate_create' }
  | { kind: 'action_failure' };

export class SimulatedProvider implements MachineProvider {
  readonly kind = 'simulated';
  readonly db: Database;
  readonly fault: SimulationFault;
  readonly actionDelayMs: number;

  constructor(input: { db: Database; fault?: SimulationFault; actionDelayMs?: number }) {
    this.db = input.db;
    this.fault = input.fault ?? { kind: 'none' };
    this.actionDelayMs = input.actionDelayMs ?? 0;
  }

  async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
    if (this.fault.kind === 'timeout_before_submit') {
      return {
        kind: 'unknown',
        reason: 'Simulated timeout with no authoritative submission outcome.',
      };
    }
    const command = input.command;
    const serverId = command.kind === 'create' ? randomUUID() : command.serverId;
    const actionId = randomUUID();
    const visibleAt = new Date(
      Date.now() + (this.fault.kind === 'lose_response' ? this.fault.visibilityDelayMs : 0),
    );
    const result: ProviderAction =
      this.fault.kind === 'action_failure'
        ? {
            kind: 'failed',
            error: {
              code: 'provider_rejected',
              message: 'Simulated action failed.',
              retryable: false,
            },
          }
        : { kind: 'succeeded' };
    await this.db.transaction(async (tx) => {
      if (command.kind === 'create') {
        const server: ProviderServer = {
          id: serverId,
          name: command.name,
          serverType: command.serverType,
          region: command.region,
          labels: command.labels,
          power: 'starting',
          ipv4: null,
        };
        await tx.insert(simulatedServers).values({ id: serverId, value: server, visibleAt });
        if (this.fault.kind === 'duplicate_create') {
          const duplicateId = randomUUID();
          await tx.insert(simulatedServers).values({
            id: duplicateId,
            value: { ...server, id: duplicateId, power: 'running' },
            visibleAt,
          });
        }
      }
      await tx.insert(simulatedActions).values({
        id: actionId,
        serverId,
        command,
        result,
        readyAt: new Date(Date.now() + this.actionDelayMs),
      });
    });
    if (this.fault.kind === 'lose_response' || this.fault.kind === 'duplicate_create') {
      // The external side completes independently of whether the caller receives its ID.
      await this.getAction({ actionId });
      return { kind: 'unknown', reason: 'Simulated response was lost after provider commit.' };
    }
    return { kind: 'accepted', serverId, actionId };
  }

  async getAction(input: { actionId: string }): Promise<ProviderAction> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(simulatedActions)
        .where(eq(simulatedActions.id, input.actionId))
        .for('update');
      if (!row)
        return {
          kind: 'failed',
          error: {
            code: 'provider_rejected',
            message: 'Simulated action not found.',
            retryable: false,
          },
        };
      if (row.readyAt.getTime() > Date.now()) return { kind: 'running' };
      const result = providerActionSchema.parse(row.result);
      if (row.completedAt) return result;
      const command = providerCommandSchema.parse(row.command);
      if (result.kind === 'succeeded') {
        const [stored] = await tx
          .select()
          .from(simulatedServers)
          .where(eq(simulatedServers.id, row.serverId))
          .for('update');
        if (stored) {
          const server = providerServerSchema.parse(stored.value);
          switch (command.kind) {
            case 'destroy':
              await tx.delete(simulatedServers).where(eq(simulatedServers.id, row.serverId));
              break;
            case 'resize':
              await tx
                .update(simulatedServers)
                .set({ value: { ...server, serverType: command.serverType } })
                .where(eq(simulatedServers.id, row.serverId));
              break;
            case 'create':
            case 'reboot':
            case 'power_on':
            case 'power_off':
              await tx
                .update(simulatedServers)
                .set({
                  value: { ...server, power: command.kind === 'power_off' ? 'off' : 'running' },
                })
                .where(eq(simulatedServers.id, row.serverId));
              break;
          }
        }
      }
      await tx
        .update(simulatedActions)
        .set({ completedAt: new Date() })
        .where(eq(simulatedActions.id, row.id));
      return result;
    });
  }

  async getServer(input: { serverId: string }): Promise<ProviderServer | null> {
    const [row] = await this.db
      .select()
      .from(simulatedServers)
      .where(
        and(eq(simulatedServers.id, input.serverId), lte(simulatedServers.visibleAt, new Date())),
      );
    return row ? providerServerSchema.parse(row.value) : null;
  }

  async findServers(input: {
    labels: Readonly<Record<string, string>>;
  }): Promise<ProviderServer[]> {
    const rows = await this.db
      .select()
      .from(simulatedServers)
      .where(lte(simulatedServers.visibleAt, new Date()));
    return rows
      .map((row) => providerServerSchema.parse(row.value))
      .filter((server) =>
        Object.entries(input.labels).every(([key, value]) => server.labels[key] === value),
      );
  }
}
