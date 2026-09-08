import { z } from 'zod';
import { allocationIdSchema, machineIdSchema, projectIdSchema } from './ids.js';
import { currencySchema, microsSchema } from './money.js';

const reservationLimitSchema = z.object({
  maxMachines: z.int().nonnegative(),
  maxHourlyMicros: microsSchema,
});
export const usageResponseSchema = z.object({
  usage: z.object({
    scope: z.literal('account'),
    activeReservations: z.int().nonnegative(),
    hourlyMicros: microsSchema,
    currency: currencySchema,
    pricing: z.literal('reservation'),
    poweredOffMachinesRemainBillable: z.literal(true),
    limits: z.object({
      account: reservationLimitSchema,
      grant: reservationLimitSchema,
      effective: reservationLimitSchema,
      remainingMachines: z.int().nonnegative(),
      remainingHourlyMicros: microsSchema,
      deploymentCapacityAlsoApplies: z.literal(true),
    }),
    backups: z.object({
      reservedBytes: z.int().nonnegative(),
      retainedCount: z.int().nonnegative(),
      unresolvedCount: z.int().nonnegative(),
      purgePendingCount: z.int().nonnegative(),
      limits: z
        .object({
          maxAccountBytes: z.int().positive(),
          maxCaptureBytes: z.int().positive(),
          remainingBytes: z.int().nonnegative(),
        })
        .nullable(),
      machineDestructionReleasesBackups: z.literal(false),
    }),
  }),
});

export const reservationCursorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
export const reservationHistoryResponseSchema = z.object({
  history: z
    .array(
      z.object({
        id: reservationCursorSchema,
        projectId: projectIdSchema,
        machineId: machineIdSchema,
        allocationId: allocationIdSchema,
        kind: z.enum(['admitted', 'changed', 'released', 'baseline']),
        hourlyMicros: microsSchema,
        currency: currencySchema,
        occurredAt: z.iso.datetime(),
      }),
    )
    .max(100),
  nextCursor: reservationCursorSchema.nullable(),
  pricing: z.literal('reservation'),
});
