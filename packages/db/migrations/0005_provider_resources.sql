CREATE TABLE "provider_resources" (
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"labels" jsonb NOT NULL,
	"absent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_resources_provider_kind_provider_id_pk" PRIMARY KEY("provider","kind","provider_id"),
	CONSTRAINT "provider_resource_kind" CHECK ("provider_resources"."kind" IN ('server', 'primary_ip'))
);
--> statement-breakpoint
CREATE TABLE "simulated_primary_ips" (
	"id" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"visible_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "network_profile" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "allocations" ALTER COLUMN "network_profile" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "provider_attempts" ADD COLUMN "resolution" jsonb DEFAULT '{"kind":"pending"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "intent" jsonb DEFAULT '{"kind":"run"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocation_account_identity" UNIQUE("account_id","id");--> statement-breakpoint
ALTER TABLE "provider_resources" ADD CONSTRAINT "provider_resources_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
-- This migration changes receipt format, not the observed provider outcome.
-- The existing trigger is disabled only inside the migrator's transaction.
ALTER TABLE provider_attempts DISABLE TRIGGER provider_attempt_guard;
--> statement-breakpoint
UPDATE provider_attempts SET outcome = (outcome - 'serverId') || jsonb_build_object(
  'resource', jsonb_build_object('kind', 'server', 'id', outcome->>'serverId')
) WHERE outcome->>'kind' IN ('accepted', 'completed') AND outcome ? 'serverId';
--> statement-breakpoint
UPDATE provider_attempts SET command = command || '{"network":{"kind":"legacy"}}'::jsonb
WHERE command->>'kind' = 'create' AND NOT (command ? 'network');
--> statement-breakpoint
ALTER TABLE provider_attempts ENABLE TRIGGER provider_attempt_guard;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_provider_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider attempts are retained for reconciliation and audit' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome IS DISTINCT FROM '{"kind":"prepared"}'::jsonb
       OR NEW.resolution IS DISTINCT FROM '{"kind":"pending"}'::jsonb THEN
      RAISE EXCEPTION 'Provider attempts must begin prepared and unresolved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'outcome' - 'resolution') IS DISTINCT FROM (to_jsonb(OLD) - 'outcome' - 'resolution') THEN
    RAISE EXCEPTION 'Provider attempt identity and command are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND
    (OLD.outcome IS DISTINCT FROM '{"kind":"prepared"}'::jsonb OR
     COALESCE(NEW.outcome->>'kind', '') NOT IN ('accepted', 'completed', 'rejected', 'unknown')) THEN
    RAISE EXCEPTION 'Provider attempt outcome can be recorded only once' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution IS DISTINCT FROM OLD.resolution AND
    (OLD.resolution IS DISTINCT FROM '{"kind":"pending"}'::jsonb OR
     COALESCE(NEW.resolution->>'kind', '') NOT IN ('confirmed', 'failed')) THEN
    RAISE EXCEPTION 'Provider attempt resolution can be recorded only once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
UPDATE operations SET progress = (progress - 'serverId') || jsonb_build_object(
  'resource', jsonb_build_object('kind', 'server', 'id', progress->>'serverId')
) WHERE progress->>'kind' IN ('waiting_provider', 'verifying') AND progress ? 'serverId';
--> statement-breakpoint
UPDATE simulated_servers SET value = value || '{"primaryIpId":null}'::jsonb WHERE NOT (value ? 'primaryIpId');
--> statement-breakpoint
UPDATE simulated_actions SET command = command || '{"network":{"kind":"legacy"}}'::jsonb
WHERE command->>'kind' = 'create' AND NOT (command ? 'network');
--> statement-breakpoint
INSERT INTO provider_resources (provider,kind,provider_id,account_id,allocation_id,labels,absent_at)
SELECT a.provider, 'server', a.server_id, a.account_id, a.id,
  jsonb_build_object('managed_by','agent-cloud','account_id',a.account_id,'machine_id',a.machine_id), a.retired_at
FROM allocations a WHERE a.server_id IS NOT NULL;
