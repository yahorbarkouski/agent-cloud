CREATE TABLE "control_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "control_state_singleton" CHECK ("control_state"."id" = 1)
);

--> statement-breakpoint
CREATE FUNCTION preserve_control_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Control recovery receipts are immutable and retained';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preserve_control_recovery BEFORE UPDATE OR DELETE ON control_recoveries
FOR EACH ROW EXECUTE FUNCTION preserve_control_recovery();
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
     COALESCE(NEW.resolution->>'kind', '') NOT IN ('confirmed', 'failed', 'operator_closed', 'control_closed')) THEN
    RAISE EXCEPTION 'Provider attempt resolution can be recorded only once' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution->>'kind'='operator_closed' AND (
    NEW.outcome IS DISTINCT FROM OLD.outcome OR NOT EXISTS(
      SELECT 1 FROM operator_recoveries r JOIN operation_cleanups c ON c.operation_id=r.operation_id
      WHERE r.id=NEW.resolution->>'recoveryId' AND r.attempt_id=NEW.id AND r.request->>'kind'='close_create'
      AND c.source_operation_id=NEW.operation_id AND c.account_id=NEW.account_id)) THEN
    RAISE EXCEPTION 'Operator closure requires its exact retained recovery record' USING ERRCODE='23514';
  END IF;
  IF NEW.resolution->>'kind'='control_closed' AND NOT EXISTS(
    SELECT 1 FROM control_recoveries r JOIN control_state c ON c.id=1
    WHERE r.id=NEW.resolution->>'recoveryId' AND r.request->>'kind'='close_operation'
      AND r.request->>'operationId'=NEW.operation_id
      AND r.request->>'recoveryId'=c.state->>'recoveryId' AND c.state->>'kind'='recovering'
      AND r.request->'providerRequestFinished'='true'::jsonb
  ) THEN
    RAISE EXCEPTION 'Control closure requires an exact retained fenced recovery record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
