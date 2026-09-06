ALTER TABLE "accounts" RENAME COLUMN "max_hourly_micro_eur" TO "max_hourly_micros";--> statement-breakpoint
ALTER TABLE "allocations" RENAME COLUMN "hourly_micro_eur" TO "hourly_micros";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "account_limits";--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "allocation_price";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "currency" text DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "currency" text DEFAULT 'EUR' NOT NULL;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "offer" jsonb;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "offer" jsonb;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "account_limits" CHECK ("accounts"."max_machines" >= 0 AND "accounts"."max_hourly_micros" >= 0);--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocation_price" CHECK ("allocations"."hourly_micros" >= 0);--> statement-breakpoint
-- M0 had only simulated EUR estimates. Preserve their denomination and exact values.
UPDATE grants SET policy = (policy - 'maxHourlyMicroEur') || jsonb_build_object(
  'currency', 'EUR', 'maxHourlyMicros', policy->'maxHourlyMicroEur'
) WHERE policy ? 'maxHourlyMicroEur';
--> statement-breakpoint
WITH legacy(size, server_type, vcpus, memory_gb, disk_gb, hourly) AS (
  VALUES ('small', 'cx23', 2, 4, 40, 9600), ('medium', 'cx33', 4, 8, 80, 14400),
         ('large', 'cx43', 8, 16, 160, 26400)
)
UPDATE allocations a SET offer = jsonb_build_object(
  'size', l.size, 'serverType', l.server_type, 'region', m.spec->>'region',
  'architecture', 'x86', 'vcpus', l.vcpus, 'memoryGb', l.memory_gb, 'diskGb', l.disk_gb,
  'available', true, 'currency', 'EUR', 'serverHourlyMicros', l.hourly - 1200,
  'ipv4HourlyMicros', 1200, 'hourlyMicros', l.hourly
) FROM machines m, legacy l WHERE a.machine_id = m.id AND m.spec->>'size' = l.size;
--> statement-breakpoint
WITH legacy(size, server_type, vcpus, memory_gb, disk_gb, hourly) AS (
  VALUES ('small', 'cx23', 2, 4, 40, 9600), ('medium', 'cx33', 4, 8, 80, 14400),
         ('large', 'cx43', 8, 16, 160, 26400)
)
UPDATE operations o SET offer = jsonb_build_object(
  'size', l.size, 'serverType', l.server_type, 'region', m.spec->>'region',
  'architecture', 'x86', 'vcpus', l.vcpus, 'memoryGb', l.memory_gb, 'diskGb', l.disk_gb,
  'available', true, 'currency', 'EUR', 'serverHourlyMicros', l.hourly - 1200,
  'ipv4HourlyMicros', 1200, 'hourlyMicros', l.hourly
) FROM machines m, legacy l WHERE o.machine_id = m.id AND
  ((o.kind = 'machine.create' AND o.command->'spec'->>'size' = l.size) OR
   (o.kind = 'machine.resize' AND o.command->>'size' = l.size));
