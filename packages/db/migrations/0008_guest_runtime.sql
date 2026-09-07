CREATE TABLE "runtime_signing_attempts" (
	"account_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_signing_attempts_operation_id_sequence_pk" PRIMARY KEY("operation_id","sequence"),
	CONSTRAINT "runtime_signing_attempt_budget" CHECK ("runtime_signing_attempts"."sequence" BETWEEN 1 AND 12)
);
--> statement-breakpoint
ALTER TABLE "runtime_signing_attempts" ADD CONSTRAINT "runtime_signing_attempts_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_signing_attempts" ADD CONSTRAINT "runtime_signing_attempts_account_id_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION guard_runtime_signing_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_sequence integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Runtime signing attempts are retained and immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM operations o
    JOIN allocations a ON a.account_id=o.account_id AND a.machine_id=o.machine_id
    JOIN guest_identities i ON i.account_id=a.account_id AND i.allocation_id=a.id
    WHERE o.id=NEW.operation_id AND o.account_id=NEW.account_id AND a.id=NEW.allocation_id
      AND a.retired_at IS NULL AND i.identity->>'kind'='issued'
      AND o.kind IN ('machine.create','machine.reboot','machine.power_on')
      AND o.progress->>'kind'='waiting_guest' AND o.progress->>'stage'='runtime'
      AND o.progress->>'serverId'=a.server_id AND o.created_at + interval '30 minutes' > now()
    FOR UPDATE OF o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime signing needs a live enrolled allocation and active boot operation' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(MAX(sequence),0)+1 INTO next_sequence FROM runtime_signing_attempts WHERE operation_id=NEW.operation_id;
  IF NEW.sequence <> next_sequence OR NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'Runtime signing needs the next sequence and current timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_signing_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON runtime_signing_attempts
FOR EACH ROW EXECUTE FUNCTION guard_runtime_signing_attempt();
