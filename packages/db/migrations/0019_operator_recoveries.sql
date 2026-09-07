CREATE TABLE "operator_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_recoveries_attempt_id_unique" UNIQUE("attempt_id")
);
--> statement-breakpoint
ALTER TABLE "operator_recoveries" ADD CONSTRAINT "operator_recoveries_operation_id_operation_cleanups_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operation_cleanups"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_recoveries" ADD CONSTRAINT "operator_recoveries_attempt_id_provider_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."provider_attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION cleanup_delete_limit(cleanup_id text, delete_command jsonb) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT 3 + count(*)::integer FROM operator_recoveries r JOIN provider_attempts e ON e.id=r.attempt_id
  WHERE r.operation_id=cleanup_id AND r.request->>'kind'='retry_delete' AND e.command=delete_command
$$;
--> statement-breakpoint
CREATE FUNCTION guard_operator_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cleanup operation_cleanups; executor operations; source provider_attempts; allocation allocations;
  target_kind text; target_id text; submitted integer; latest_id text; known_ids jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Operator recovery records are immutable and retained' USING ERRCODE='23514';
  END IF;
  SELECT * INTO cleanup FROM operation_cleanups WHERE operation_id=NEW.operation_id;
  SELECT * INTO executor FROM operations WHERE id=NEW.operation_id;
  SELECT * INTO source FROM provider_attempts WHERE id=NEW.attempt_id;
  SELECT * INTO allocation FROM allocations WHERE id=cleanup.allocation_id;
  IF cleanup.operation_id IS NULL OR source.id IS NULL OR allocation.retired_at IS NOT NULL
    OR executor.progress->>'kind' IN ('succeeded','failed','cancelled')
    OR source.account_id IS DISTINCT FROM cleanup.account_id
    OR source.operation_id NOT IN (cleanup.operation_id,cleanup.source_operation_id)
    OR NEW.request->>'id' IS DISTINCT FROM NEW.id
    OR NEW.request->>'operationId' IS DISTINCT FROM cleanup.operation_id
    OR NEW.request->>'allocationId' IS DISTINCT FROM cleanup.allocation_id
    OR NEW.request->>'accountId' IS DISTINCT FROM cleanup.account_id
    OR NEW.request->>'attemptId' IS DISTINCT FROM source.id
    OR COALESCE(NEW.request->>'expectedState','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(NEW.request->>'operator','') !~ '^[a-zA-Z0-9@._+-]{1,100}$'
    OR COALESCE(NEW.request->'evidence'->>'sha256','') !~ '^[0-9a-f]{64}$'
    OR length(COALESCE(NEW.request->'evidence'->>'reference','')) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Recovery must bind a live admitted cleanup and its retained attempt' USING ERRCODE='23514';
  END IF;
  IF NEW.request->>'kind'='close_create' THEN
    target_kind := CASE source.command->>'kind' WHEN 'create' THEN 'server' WHEN 'create_guest' THEN 'server' WHEN 'create_primary_ip' THEN 'primary_ip' END;
    IF target_kind IS NULL OR source.operation_id<>cleanup.source_operation_id
      OR source.resolution IS DISTINCT FROM '{"kind":"pending"}'::jsonb
      OR source.outcome->>'kind' NOT IN ('prepared','unknown')
      OR NEW.request->'providerRequestFinished' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(NEW.request->'resourceIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Only an uncertain source create can receive explicit provider closure' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(jsonb_agg(provider_id ORDER BY provider_id),'[]'::jsonb) INTO known_ids
      FROM provider_resources WHERE allocation_id=cleanup.allocation_id AND kind=target_kind
      AND labels->>'operation_id'=source.operation_id;
    IF known_ids IS DISTINCT FROM (SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements_text(NEW.request->'resourceIds')) THEN
      RAISE EXCEPTION 'Provider closure must acknowledge every retained source resource' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.request->>'kind'='retry_delete' THEN
    target_kind := CASE source.command->>'kind' WHEN 'destroy' THEN 'server' WHEN 'delete_primary_ip' THEN 'primary_ip' END;
    target_id := CASE target_kind WHEN 'server' THEN source.command->>'serverId' WHEN 'primary_ip' THEN source.command->>'primaryIpId' END;
    IF target_kind IS NULL OR NOT EXISTS(SELECT 1 FROM provider_resources WHERE allocation_id=cleanup.allocation_id
      AND kind=target_kind AND provider_id=target_id AND absent_at IS NULL) THEN
      RAISE EXCEPTION 'Retry authority permits only a retained live deletion target' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO submitted FROM provider_attempts WHERE operation_id IN (cleanup.operation_id,cleanup.source_operation_id) AND command=source.command;
    SELECT id INTO latest_id FROM provider_attempts WHERE operation_id IN (cleanup.operation_id,cleanup.source_operation_id) AND command=source.command ORDER BY created_at DESC, sequence DESC LIMIT 1;
    IF source.id IS DISTINCT FROM latest_id OR submitted<>cleanup_delete_limit(cleanup.operation_id,source.command) THEN
      RAISE EXCEPTION 'Retry authority requires the latest exhausted deletion attempt' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown operator recovery kind' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operator_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON operator_recoveries
FOR EACH ROW EXECUTE FUNCTION guard_operator_recovery();
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
     COALESCE(NEW.resolution->>'kind', '') NOT IN ('confirmed', 'failed', 'operator_closed')) THEN
    RAISE EXCEPTION 'Provider attempt resolution can be recorded only once' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution->>'kind'='operator_closed' AND (
    NEW.outcome IS DISTINCT FROM OLD.outcome OR NOT EXISTS(
      SELECT 1 FROM operator_recoveries r JOIN operation_cleanups c ON c.operation_id=r.operation_id
      WHERE r.id=NEW.resolution->>'recoveryId' AND r.attempt_id=NEW.id AND r.request->>'kind'='close_create'
      AND c.source_operation_id=NEW.operation_id AND c.account_id=NEW.account_id)) THEN
    RAISE EXCEPTION 'Operator closure requires its exact retained recovery record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_cleanup_effect() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF submitted>=cleanup_delete_limit(cleanup.operation_id,NEW.command) OR (submitted>0 AND clock_timestamp()<latest + CASE WHEN submitted=1 THEN interval '5 seconds' ELSE interval '30 seconds' END) THEN
      RAISE EXCEPTION 'Cleanup delete retries exceed their durable count or backoff' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
