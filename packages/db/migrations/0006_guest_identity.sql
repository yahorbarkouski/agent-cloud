CREATE TABLE "guest_bootstraps" (
	"account_id" text NOT NULL,
	"allocation_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"sealed_token" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_bootstraps_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "bootstrap_account_identity" UNIQUE("account_id","allocation_id")
);
--> statement-breakpoint
CREATE TABLE "guest_identities" (
	"account_id" text NOT NULL,
	"allocation_id" text PRIMARY KEY NOT NULL,
	"identity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest_bootstraps" ADD CONSTRAINT "guest_bootstraps_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_bootstraps" ADD CONSTRAINT "guest_bootstraps_account_id_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_identities" ADD CONSTRAINT "guest_identities_account_id_allocation_id_guest_bootstraps_account_id_allocation_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."guest_bootstraps"("account_id","allocation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION guard_guest_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Guest bootstrap history is retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.sealed_token IS NULL OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Bootstrap begins sealed and unconsumed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'sealed_token' - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'sealed_token' - 'consumed_at') THEN
    RAISE EXCEPTION 'Bootstrap identity, expiry and token hash are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND (
    OLD.consumed_at IS NOT NULL OR OLD.sealed_token IS NULL OR
    NEW.consumed_at IS NULL OR NEW.sealed_token IS NOT NULL OR
    NOT EXISTS (SELECT 1 FROM guest_identities g WHERE g.allocation_id=NEW.allocation_id AND g.account_id=NEW.account_id AND g.identity->>'kind'='issued')
  ) THEN
    RAISE EXCEPTION 'Bootstrap can only be consumed after identity issuance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_bootstrap_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_bootstraps
FOR EACH ROW EXECUTE FUNCTION guard_guest_bootstrap();
--> statement-breakpoint
CREATE FUNCTION guard_guest_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Guest identity history is retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.identity->>'kind','') <> 'claimed' THEN
      RAISE EXCEPTION 'Guest identity must claim its keys before issuance' USING ERRCODE = '23514';
    END IF;
    FOREACH field IN ARRAY ARRAY['sshHostPublicKey', 'tlsCsr', 'imageVersion'] LOOP
      IF jsonb_typeof(NEW.identity->field) IS DISTINCT FROM 'string' OR COALESCE(NEW.identity->>field, '') !~ '\S' THEN
        RAISE EXCEPTION 'Guest identity requires nonempty string keys and image' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF NEW.identity - ARRAY['kind', 'sshHostPublicKey', 'tlsCsr', 'imageVersion'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Guest claim contains unsupported fields' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - 'identity') IS DISTINCT FROM (to_jsonb(OLD) - 'identity') OR
    COALESCE(OLD.identity->>'kind','') <> 'claimed' OR COALESCE(NEW.identity->>'kind','') <> 'issued' OR
    (NEW.identity - 'kind' - 'sshHostCertificate' - 'tlsCertificate' - 'issuedAt') IS DISTINCT FROM (OLD.identity - 'kind') THEN
    RAISE EXCEPTION 'Guest keys are immutable and certificates are issued once' USING ERRCODE = '23514';
  END IF;
  FOREACH field IN ARRAY ARRAY['sshHostCertificate', 'tlsCertificate', 'issuedAt'] LOOP
    IF jsonb_typeof(NEW.identity->field) IS DISTINCT FROM 'string' OR COALESCE(NEW.identity->>field, '') !~ '\S' THEN
      RAISE EXCEPTION 'Issued identity requires nonempty certificate and timestamp strings' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.identity->>'issuedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' OR NOT isfinite((NEW.identity->>'issuedAt')::timestamptz) THEN
    RAISE EXCEPTION 'Issued identity requires a finite UTC timestamp' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_identities
FOR EACH ROW EXECUTE FUNCTION guard_guest_identity();
