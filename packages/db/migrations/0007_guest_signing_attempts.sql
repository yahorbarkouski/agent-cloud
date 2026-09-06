CREATE TABLE "guest_signing_attempts" (
	"account_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"purpose" text NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_signing_attempts_allocation_id_purpose_sequence_pk" PRIMARY KEY("allocation_id","purpose","sequence"),
	CONSTRAINT "guest_signing_attempt_budget" CHECK (("guest_signing_attempts"."purpose" = 'probe' AND "guest_signing_attempts"."sequence" BETWEEN 1 AND 12) OR ("guest_signing_attempts"."purpose" = 'identity' AND "guest_signing_attempts"."sequence" BETWEEN 1 AND 4))
);
--> statement-breakpoint
ALTER TABLE "guest_signing_attempts" ADD CONSTRAINT "guest_signing_attempts_account_id_allocation_id_guest_bootstraps_account_id_allocation_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."guest_bootstraps"("account_id","allocation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION guard_guest_signing_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_sequence integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Guest signing attempts are retained and immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM guest_bootstraps WHERE allocation_id=NEW.allocation_id AND account_id=NEW.account_id AND expires_at > now() AND consumed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Guest signing requires an active unconsumed bootstrap' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(MAX(sequence), 0) + 1 INTO next_sequence FROM guest_signing_attempts WHERE allocation_id=NEW.allocation_id AND purpose=NEW.purpose;
  IF NEW.sequence <> next_sequence OR NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'Guest signing attempts require the next sequence and current timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_signing_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_signing_attempts
FOR EACH ROW EXECUTE FUNCTION guard_guest_signing_attempt();
