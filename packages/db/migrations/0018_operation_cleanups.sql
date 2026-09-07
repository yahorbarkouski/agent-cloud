CREATE TABLE "operation_cleanups" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"source_operation_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"expected_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cleanup_version" CHECK ("operation_cleanups"."expected_version" > 0)
);
--> statement-breakpoint
DROP INDEX "one_active_operation";--> statement-breakpoint
ALTER TABLE "operation_cleanups" ADD CONSTRAINT "operation_cleanups_account_id_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_cleanups" ADD CONSTRAINT "operation_cleanups_account_id_source_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","source_operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_cleanups" ADD CONSTRAINT "operation_cleanups_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_cleanups" ADD CONSTRAINT "operation_cleanups_account_id_grant_id_grants_account_id_id_fk" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_operation" ON "operations" USING btree ("machine_id") WHERE "operations"."progress"->>'kind' NOT IN ('succeeded', 'failed', 'cancelled');
--> statement-breakpoint
CREATE FUNCTION guard_operation_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source operations; executor operations; allocation allocations; machine machines;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Cleanup authority is immutable and retained' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM operations WHERE id=NEW.source_operation_id AND account_id=NEW.account_id;
  SELECT * INTO executor FROM operations WHERE id=NEW.operation_id AND account_id=NEW.account_id;
  SELECT * INTO allocation FROM allocations WHERE id=NEW.allocation_id AND account_id=NEW.account_id;
  SELECT * INTO machine FROM machines WHERE id=allocation.machine_id AND account_id=NEW.account_id;
  IF source.kind IS DISTINCT FROM 'machine.create' OR source.machine_id IS DISTINCT FROM allocation.machine_id
    OR executor.machine_id IS DISTINCT FROM allocation.machine_id OR allocation.retired_at IS NOT NULL
    OR machine.version IS DISTINCT FROM NEW.expected_version
    OR executor.intent IS DISTINCT FROM jsonb_build_object('kind','cleanup','sourceOperationId',source.id)
    OR executor.progress->>'kind' IS DISTINCT FROM 'cleaning_up'
    OR NOT ((executor.id=source.id AND executor.kind='machine.create') OR
      (executor.id<>source.id AND executor.kind='machine.destroy' AND source.progress->>'kind' IN ('succeeded','failed')
       AND executor.command->>'kind'='destroy' AND executor.command->'allowDataLoss'='true'::jsonb)) THEN
    RAISE EXCEPTION 'Cleanup must bind the admitted live allocation and original create' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operation_cleanup_guard BEFORE INSERT OR UPDATE OR DELETE ON operation_cleanups
FOR EACH ROW EXECUTE FUNCTION guard_operation_cleanup();
--> statement-breakpoint
CREATE FUNCTION cleanup_settled(cleanup operation_cleanups) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM provider_attempts e WHERE e.operation_id IN (cleanup.operation_id,cleanup.source_operation_id) AND e.resolution->>'kind'='pending')
    AND NOT EXISTS(SELECT 1 FROM provider_resources r WHERE r.allocation_id=cleanup.allocation_id AND r.absent_at IS NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION guard_cleanup_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleanup operation_cleanups;
BEGIN
  SELECT * INTO cleanup FROM operation_cleanups WHERE operation_id=OLD.id;
  IF FOUND THEN
    IF (to_jsonb(NEW)-'progress') IS DISTINCT FROM (to_jsonb(OLD)-'progress')
      OR (OLD.progress->>'kind' IN ('succeeded','failed','cancelled') AND NEW.progress IS DISTINCT FROM OLD.progress)
      OR (NEW.progress->>'kind' IN ('succeeded','failed','cancelled') AND (
        NEW.progress->>'kind' IS DISTINCT FROM CASE WHEN NEW.kind='machine.create' THEN 'cancelled' ELSE 'succeeded' END
        OR NOT cleanup_settled(cleanup)
        OR NOT EXISTS(SELECT 1 FROM allocations a WHERE a.id=cleanup.allocation_id AND a.retired_at IS NOT NULL)
      )) THEN
      RAISE EXCEPTION 'Cleanup identity is immutable and terminality requires complete absence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cleanup_operation_guard BEFORE UPDATE ON operations
FOR EACH ROW EXECUTE FUNCTION guard_cleanup_operation();
--> statement-breakpoint
CREATE FUNCTION guard_cleanup_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleanup operation_cleanups;
BEGIN
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    FOR cleanup IN SELECT * FROM operation_cleanups WHERE allocation_id=OLD.id LOOP
      IF NOT cleanup_settled(cleanup) THEN
        RAISE EXCEPTION 'Cleanup retains its reservation until all effects and resources settle' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cleanup_retirement_guard BEFORE UPDATE ON allocations
FOR EACH ROW EXECUTE FUNCTION guard_cleanup_retirement();
--> statement-breakpoint
CREATE FUNCTION guard_cleanup_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleanup operation_cleanups; executor operations; target_kind text; target_id text; submitted integer; latest timestamptz;
BEGIN
  IF EXISTS(SELECT 1 FROM operation_cleanups WHERE source_operation_id=NEW.operation_id OR operation_id=NEW.operation_id) THEN
    SELECT * INTO cleanup FROM operation_cleanups WHERE operation_id=NEW.operation_id AND account_id=NEW.account_id;
    SELECT * INTO executor FROM operations WHERE id=NEW.operation_id;
    target_kind := CASE NEW.command->>'kind' WHEN 'destroy' THEN 'server' WHEN 'delete_primary_ip' THEN 'primary_ip' END;
    target_id := CASE target_kind WHEN 'server' THEN NEW.command->>'serverId' WHEN 'primary_ip' THEN NEW.command->>'primaryIpId' END;
    IF cleanup.operation_id IS NULL OR target_kind IS NULL OR executor.progress->>'kind' IN ('succeeded','failed','cancelled')
      OR NOT EXISTS(SELECT 1 FROM provider_resources r WHERE r.allocation_id=cleanup.allocation_id AND r.account_id=NEW.account_id
        AND r.kind=target_kind AND r.provider_id=target_id AND r.absent_at IS NULL) THEN
      RAISE EXCEPTION 'Admitted cleanup permits only exact owned deletion effects' USING ERRCODE='23514';
    END IF;
    IF target_kind='primary_ip' AND (
      EXISTS(SELECT 1 FROM provider_attempts e WHERE e.operation_id=cleanup.source_operation_id
        AND e.command->>'kind' IN ('create','create_guest') AND e.resolution->>'kind'='pending')
      OR EXISTS(SELECT 1 FROM provider_resources r WHERE r.allocation_id=cleanup.allocation_id AND r.kind='server' AND r.absent_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'Unsettled server ownership prevents IP deletion' USING ERRCODE='23514';
    END IF;
    SELECT count(*), max(created_at) INTO submitted, latest FROM provider_attempts e
      WHERE e.operation_id IN (cleanup.operation_id,cleanup.source_operation_id)
      AND e.command=NEW.command;
    IF submitted>=3 OR (submitted>0 AND clock_timestamp()<latest + CASE WHEN submitted=1 THEN interval '5 seconds' ELSE interval '30 seconds' END) THEN
      RAISE EXCEPTION 'Cleanup delete retries exceed their durable count or backoff' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cleanup_effect_guard BEFORE INSERT ON provider_attempts
FOR EACH ROW EXECUTE FUNCTION guard_cleanup_effect();
