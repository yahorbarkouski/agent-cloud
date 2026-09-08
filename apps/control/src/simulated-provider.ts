import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import {
  providerActionSchema,
  simulatedCatalog,
  providerCommandSchema,
  isServerCreateCommand,
  providerServerSchema,
  providerPrimaryIpSchema,
  type CatalogSource,
  type MachineProvider,
  type ProviderServer,
  type ProviderPrimaryIp,
  type Submission,
  type ProviderAction,
  type ProviderCommand,
} from '@agent-cloud/contracts';
import {
  simulatedServers,
  simulatedActions,
  simulatedPrimaryIps,
  type Database,
} from '@agent-cloud/db';

export type SimulationFault =
  | { kind: 'none' }
  | { kind: 'lose_response'; visibilityDelayMs: number }
  | { kind: 'timeout_before_submit' }
  | { kind: 'duplicate_create' }
  | { kind: 'reject' }
  | { kind: 'action_failure' };
const rejection = {
  kind: 'rejected',
  error: {
    code: 'provider_rejected',
    message: 'Simulated provider rejected the effect.',
    retryable: false,
  },
} satisfies Submission;
const uncertain = { kind: 'unknown', reason: 'Simulated response was lost.' } satisfies Submission;

export class SimulatedProvider implements MachineProvider {
  readonly kind = 'simulated';
  readonly db: Database;
  readonly catalog: CatalogSource;
  readonly fault: SimulationFault;
  readonly primaryIpFault: SimulationFault;
  readonly actionDelayMs: number;
  readonly retainPrimaryIps: boolean;
  constructor(input: {
    db: Database;
    fault?: SimulationFault;
    primaryIpFault?: SimulationFault;
    actionDelayMs?: number;
    catalog?: CatalogSource;
    retainPrimaryIps?: boolean;
  }) {
    this.db = input.db;
    this.catalog = input.catalog ?? simulatedCatalog;
    this.fault = input.fault ?? { kind: 'none' };
    this.primaryIpFault = input.primaryIpFault ?? { kind: 'none' };
    this.actionDelayMs = input.actionDelayMs ?? 0;
    this.retainPrimaryIps = input.retainPrimaryIps ?? false;
  }
  getCatalog() {
    return Promise.resolve(this.catalog());
  }

  private async submitIp(
    command: Extract<ProviderCommand, { kind: 'create_primary_ip' | 'delete_primary_ip' }>,
  ): Promise<Submission> {
    const fault = this.primaryIpFault;
    if (fault.kind === 'timeout_before_submit') return uncertain;
    if (fault.kind === 'reject' || fault.kind === 'action_failure') return rejection;
    let id: string;
    if (command.kind === 'create_primary_ip') {
      id = randomUUID();
      const primaryIp: ProviderPrimaryIp = {
        id,
        name: command.name,
        region: command.region,
        labels: command.labels,
        autoDelete: true,
        ipv4: '192.0.2.10',
        assignment: { kind: 'unassigned' },
      };
      const visibleAt = new Date(
        Date.now() + (fault.kind === 'lose_response' ? fault.visibilityDelayMs : 0),
      );
      await this.db.transaction(async (tx) => {
        await tx.insert(simulatedPrimaryIps).values({ id, value: primaryIp, visibleAt });
        if (fault.kind === 'duplicate_create') {
          const duplicate = randomUUID();
          await tx
            .insert(simulatedPrimaryIps)
            .values({ id: duplicate, value: { ...primaryIp, id: duplicate }, visibleAt });
        }
      });
    } else {
      id = command.primaryIpId;
      const removed = await this.db.transaction(async (tx) => {
        const [stored] = await tx
          .select()
          .from(simulatedPrimaryIps)
          .where(eq(simulatedPrimaryIps.id, id))
          .for('update');
        if (stored && providerPrimaryIpSchema.parse(stored.value).assignment.kind !== 'unassigned')
          return false;
        await tx.delete(simulatedPrimaryIps).where(eq(simulatedPrimaryIps.id, id));
        return true;
      });
      if (!removed) return rejection;
    }
    if (fault.kind === 'lose_response' || fault.kind === 'duplicate_create') return uncertain;
    return { kind: 'completed', resource: { kind: 'primary_ip', id } };
  }

  async submit(input: Parameters<MachineProvider['submit']>[0]): Promise<Submission> {
    const command = input.command;
    if (command.kind === 'create_primary_ip' || command.kind === 'delete_primary_ip')
      return this.submitIp(command);
    if (this.fault.kind === 'timeout_before_submit') return uncertain;
    if (this.fault.kind === 'reject') return rejection;
    const serverId = isServerCreateCommand(command) ? randomUUID() : command.serverId;
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
    const submitted = await this.db.transaction(async (tx) => {
      if (isServerCreateCommand(command)) {
        let primaryIp: ProviderPrimaryIp | null = null;
        if (command.network.kind === 'primary_ip') {
          const [stored] = await tx
            .select()
            .from(simulatedPrimaryIps)
            .where(eq(simulatedPrimaryIps.id, command.network.id))
            .for('update');
          if (!stored) return false;
          primaryIp = providerPrimaryIpSchema.parse(stored.value);
          if (primaryIp.assignment.kind !== 'unassigned') return false;
          await tx
            .update(simulatedPrimaryIps)
            .set({ value: { ...primaryIp, assignment: { kind: 'server', serverId } } })
            .where(eq(simulatedPrimaryIps.id, primaryIp.id));
        }
        const server: ProviderServer = {
          id: serverId,
          name: command.name,
          serverType: command.serverType,
          region: command.region,
          labels: command.labels,
          power: 'starting',
          ipv4: primaryIp?.ipv4 ?? null,
          primaryIpId: primaryIp?.id ?? null,
          backupStatus: 'disabled',
        };
        await tx.insert(simulatedServers).values({ id: serverId, value: server, visibleAt });
        if (this.fault.kind === 'duplicate_create') {
          const duplicateId = randomUUID();
          await tx.insert(simulatedServers).values({
            id: duplicateId,
            // A Primary IP cannot be assigned to both the original and the duplicate.
            value: { ...server, id: duplicateId, power: 'running', primaryIpId: null, ipv4: null },
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
      return true;
    });
    if (!submitted) return rejection;
    if (this.fault.kind === 'lose_response' || this.fault.kind === 'duplicate_create') {
      await this.getAction({ actionId });
      return uncertain;
    }
    return { kind: 'accepted', resource: { kind: 'server', id: serverId }, actionId };
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
            case 'destroy': {
              await tx.delete(simulatedServers).where(eq(simulatedServers.id, row.serverId));
              if (server.primaryIpId) {
                const [ipRow] = await tx
                  .select()
                  .from(simulatedPrimaryIps)
                  .where(eq(simulatedPrimaryIps.id, server.primaryIpId))
                  .for('update');
                if (ipRow) {
                  const ip = providerPrimaryIpSchema.parse(ipRow.value);
                  if (ip.autoDelete && !this.retainPrimaryIps)
                    await tx.delete(simulatedPrimaryIps).where(eq(simulatedPrimaryIps.id, ip.id));
                  else
                    await tx
                      .update(simulatedPrimaryIps)
                      .set({ value: { ...ip, assignment: { kind: 'unassigned' } } })
                      .where(eq(simulatedPrimaryIps.id, ip.id));
                }
              }
              break;
            }
            case 'resize':
              await tx
                .update(simulatedServers)
                .set({ value: { ...server, serverType: command.serverType } })
                .where(eq(simulatedServers.id, row.serverId));
              break;
            case 'enable_backup':
              await tx
                .update(simulatedServers)
                .set({ value: { ...server, backupStatus: 'enabled' } })
                .where(eq(simulatedServers.id, row.serverId));
              break;
            case 'create':
            case 'create_guest':
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
            case 'create_primary_ip':
            case 'delete_primary_ip':
              throw new Error('IP operations must not be stored as simulator server actions.');
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
  async getPrimaryIp(input: { primaryIpId: string }): Promise<ProviderPrimaryIp | null> {
    const [row] = await this.db
      .select()
      .from(simulatedPrimaryIps)
      .where(
        and(
          eq(simulatedPrimaryIps.id, input.primaryIpId),
          lte(simulatedPrimaryIps.visibleAt, new Date()),
        ),
      );
    return row ? providerPrimaryIpSchema.parse(row.value) : null;
  }
  async findPrimaryIps(input: {
    labels: Readonly<Record<string, string>>;
  }): Promise<ProviderPrimaryIp[]> {
    const rows = await this.db
      .select()
      .from(simulatedPrimaryIps)
      .where(lte(simulatedPrimaryIps.visibleAt, new Date()));
    return rows
      .map((row) => providerPrimaryIpSchema.parse(row.value))
      .filter((ip) =>
        Object.entries(input.labels).every(([key, value]) => ip.labels[key] === value),
      );
  }
}
