import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  accessSessionIdSchema,
  accountIdSchema,
  allocationIdSchema,
  grantIdSchema,
  machineIdSchema,
  projectIdSchema,
} from './ids.js';
import { guestImageSchema } from './guest.js';
import { idempotencyKeySchema } from './lifecycle.js';

export const customerPublicKeySchema = z
  .string()
  .regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/)
  .refine((value) => {
    const encoded = value.slice('ssh-ed25519 '.length);
    const wire = Buffer.from(encoded, 'base64');
    return (
      wire.length === 51 &&
      wire.toString('base64') === encoded &&
      wire.readUInt32BE(0) === 11 &&
      wire.subarray(4, 15).equals(Buffer.from('ssh-ed25519')) &&
      wire.readUInt32BE(15) === 32
    );
  }, 'Expected a canonical Ed25519 public key without options or a comment.');

export const accessTicketHashSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export const accessSessionRequestSchema = z.strictObject({
  publicKey: customerPublicKeySchema,
  ticketHash: accessTicketHashSchema,
});
export type AccessSessionRequest = z.infer<typeof accessSessionRequestSchema>;

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const gatewayOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    const match = /^(wss?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::([1-9][0-9]{0,4}))?$/.exec(value);
    if (!match || match[0] !== value) return false;
    const [, protocol, host, port] = match;
    if (!host || (port && Number(port) > 65535)) return false;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (protocol === 'ws' && !loopback) return false;
    if (host.startsWith('[')) return z.ipv6().safeParse(host.slice(1, -1)).success;
    if (/^[0-9.]+$/.test(host)) return z.ipv4().safeParse(host).success;
    return host.length <= 253 && host.split('.').every((label) => dnsLabel.test(label));
  }, 'Expected a WSS origin or loopback WS origin with an explicit valid host and no path or credentials.');

export const accessGatewaySchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .refine((value) => value.trim() === value),
  origin: gatewayOriginSchema,
  egressCidrs: z
    .array(z.union([z.cidrv4(), z.cidrv6()]))
    .min(1)
    .max(16)
    .refine((values) => new Set(values).size === values.length, 'Duplicate gateway sources.')
    .refine((values) => values.every((value) => !value.endsWith('/0')), 'Public SSH is disabled.'),
});

const accessHostCaSchema = z.union([
  customerPublicKeySchema,
  z
    .string()
    .regex(/^ecdsa-sha2-nistp256 [A-Za-z0-9+/]{139}=$/)
    .refine((value) => {
      const encoded = value.slice('ecdsa-sha2-nistp256 '.length);
      const wire = Buffer.from(encoded, 'base64');
      const header = Buffer.from(
        '0000001365636473612d736861322d6e69737470323536000000086e697374703235360000004104',
        'hex',
      );
      return (
        wire.length === 104 &&
        wire.toString('base64') === encoded &&
        wire.subarray(0, header.length).equals(header)
      );
    }, 'Expected a canonical P-256 SSH CA public key.'),
]);
export type AccessGateway = z.infer<typeof accessGatewaySchema>;

export const accessIdentityPinSchema = z.strictObject({
  provider: z.enum(['hetzner', 'simulated']),
  serverId: z.string().min(1).max(128),
  primaryIpId: z.string().min(1).max(128),
  hostAlias: z
    .string()
    .regex(
      /^alloc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.guest\.agent-cloud\.internal$/,
    ),
  sshHostCa: accessHostCaSchema,
  guestHostPublicKey: customerPublicKeySchema,
  imageManifestDigest: guestImageSchema.shape.manifestDigest,
});
export const ownedSshTargetSchema = accessIdentityPinSchema.extend({
  address: z.union([z.ipv4(), z.ipv6()]),
  port: z.literal(22),
});
export type OwnedSshTarget = z.infer<typeof ownedSshTargetSchema>;

export const accessUnavailableReasonSchema = z.enum([
  'signing_unknown',
  'signing_failed',
  'provider_rejected',
  'authorization_changed',
  'target_changed',
  'deadline_exceeded',
]);
export const accessIssuanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('attempted'), attemptedAt: z.iso.datetime() }),
  z.strictObject({
    kind: z.literal('issued'),
    certificate: z.string().min(1).max(16384),
    issuedAt: z.iso.datetime(),
    ticketDeadline: z.iso.datetime(),
    certificateExpiresAt: z.iso.datetime(),
    target: ownedSshTargetSchema,
  }),
  z.strictObject({ kind: z.literal('unavailable'), reason: accessUnavailableReasonSchema }),
]);
export type AccessIssuance = z.infer<typeof accessIssuanceSchema>;

export const accessCloseReasonSchema = z.enum([
  'client_closed',
  'target_closed',
  'authorization_changed',
  'target_changed',
  'expired',
  'gateway_unavailable',
  'transport_failed',
  'limit_exceeded',
]);
export type AccessCloseReason = z.infer<typeof accessCloseReasonSchema>;
const unclaimedSchema = z.strictObject({ kind: z.literal('unclaimed') });
const claimedSchema = z.strictObject({
  kind: z.literal('claimed'),
  gatewayInstanceId: z.uuidv4().toLowerCase(),
  connectionId: z.uuidv4().toLowerCase(),
  claimedAt: z.iso.datetime(),
});
export const accessConnectionSchema = z.discriminatedUnion('kind', [
  unclaimedSchema,
  claimedSchema,
  z.strictObject({
    kind: z.literal('closed'),
    closedAt: z.iso.datetime(),
    reason: accessCloseReasonSchema,
    previous: z.discriminatedUnion('kind', [unclaimedSchema, claimedSchema]),
  }),
]);
export type AccessConnection = z.infer<typeof accessConnectionSchema>;

export const accessSessionRecordSchema = z
  .strictObject({
    id: accessSessionIdSchema,
    accountId: accountIdSchema,
    projectId: projectIdSchema,
    grantId: grantIdSchema,
    machineId: machineIdSchema,
    allocationId: allocationIdSchema,
    machineVersion: z.int().positive(),
    requestKey: idempotencyKeySchema.refine((value) => value.trim() === value),
    fingerprint: accessTicketHashSchema,
    publicKey: customerPublicKeySchema,
    ticketHash: accessTicketHashSchema,
    identityPin: accessIdentityPinSchema,
    gateway: accessGatewaySchema,
    admittedAt: z.iso.datetime(),
    issueDeadline: z.iso.datetime(),
    hardDeadline: z.iso.datetime(),
    issuance: accessIssuanceSchema,
    connection: accessConnectionSchema,
  })
  .superRefine((session, context) => {
    const admitted = Date.parse(session.admittedAt);
    const issueDeadline = Date.parse(session.issueDeadline);
    const hardDeadline = Date.parse(session.hardDeadline);
    const reject = (message: string) => {
      context.addIssue({ code: 'custom', message });
    };
    if (
      issueDeadline <= admitted ||
      issueDeadline > admitted + 90_000 ||
      hardDeadline <= admitted ||
      hardDeadline > admitted + 3_600_000
    ) {
      reject('Session deadlines exceed their admission limits.');
    }
    const expectedAlias = `${session.allocationId.replace('alloc_', 'alloc-')}.guest.agent-cloud.internal`;
    if (session.identityPin.hostAlias !== expectedAlias)
      reject('Host identity belongs to another allocation.');
    const issuance = session.issuance;
    if (issuance.kind === 'attempted') {
      const at = Date.parse(issuance.attemptedAt);
      if (at < admitted || at >= Math.min(issueDeadline, hardDeadline))
        reject('Signing attempt is outside its authority.');
    }
    if (issuance.kind === 'issued') {
      const issuedAt = Date.parse(issuance.issuedAt);
      const ticketDeadline = Date.parse(issuance.ticketDeadline);
      const certificateExpiresAt = Date.parse(issuance.certificateExpiresAt);
      if (
        issuedAt < admitted ||
        issuedAt >= Math.min(issueDeadline, hardDeadline) ||
        ticketDeadline <= issuedAt ||
        ticketDeadline > Math.min(issuedAt + 60_000, issueDeadline, hardDeadline) ||
        certificateExpiresAt <= issuedAt ||
        certificateExpiresAt > Math.min(issuedAt + 300_000, hardDeadline)
      ) {
        reject('Issued credentials exceed their original authority.');
      }
      const target = issuance.target;
      const pin = session.identityPin;
      if (
        target.provider !== pin.provider ||
        target.serverId !== pin.serverId ||
        target.primaryIpId !== pin.primaryIpId ||
        target.hostAlias !== pin.hostAlias ||
        target.sshHostCa !== pin.sshHostCa ||
        target.guestHostPublicKey !== pin.guestHostPublicKey ||
        target.imageManifestDigest !== pin.imageManifestDigest
      )
        reject('Issued target differs from the admission pin.');
    }
    const connection = session.connection;
    const claim = connection.kind === 'closed' ? connection.previous : connection;
    if (claim.kind === 'claimed') {
      if (issuance.kind !== 'issued') reject('Only issued credentials can be claimed.');
      else if (
        Date.parse(claim.claimedAt) < Date.parse(issuance.issuedAt) ||
        Date.parse(claim.claimedAt) >= Math.min(Date.parse(issuance.ticketDeadline), hardDeadline)
      ) {
        reject('Ticket claim is outside its original authority.');
      }
    }
    if (
      connection.kind === 'closed' &&
      Date.parse(connection.closedAt) <
        (claim.kind === 'claimed' ? Date.parse(claim.claimedAt) : admitted)
    ) {
      reject('Connection closure cannot precede admission or claim.');
    }
  });
export type AccessSessionRecord = z.infer<typeof accessSessionRecordSchema>;

export const accessSessionResponseSchema = z.object({
  // Stored records are fully validated before projection; public replies omit private lookup hashes.
  session: z.object(accessSessionRecordSchema.shape).omit({ fingerprint: true, ticketHash: true }),
});
export const accessTicketSchema = z.string().regex(/^aclt_[A-Za-z0-9_-]{43}$/);
export const gatewayClaimSchema = z.strictObject({
  ticket: accessTicketSchema,
  gatewayInstanceId: z.uuidv4(),
  connectionId: z.uuidv4(),
});
export const gatewayConnectionSchema = gatewayClaimSchema.omit({ ticket: true }).extend({
  sessionId: accessSessionIdSchema,
});
export const gatewayCheckSchema = z.strictObject({
  connections: z.array(gatewayConnectionSchema).min(1).max(100),
});
export const gatewayCloseSchema = gatewayConnectionSchema.extend({
  reason: accessCloseReasonSchema,
});
export const gatewayLeaseSchema = z.strictObject({
  sessionId: accessSessionIdSchema,
  connectionId: z.uuidv4(),
  remainingMs: z.number().positive().max(3_600_000),
  target: ownedSshTargetSchema,
});
export const gatewayCheckResponseSchema = z.strictObject({
  leases: z.array(gatewayLeaseSchema).max(100),
});
export const accessServiceConfigSchema = z.strictObject({
  gateway: accessGatewaySchema,
  tokenHash: accessTicketHashSchema,
});
export type AccessServiceConfig = z.infer<typeof accessServiceConfigSchema>;
