CREATE TABLE "guest_certificate_renewals" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"identity" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest_certificate_renewals" ADD CONSTRAINT "guest_certificate_renewals_account_id_allocation_id_guest_bootstraps_account_id_allocation_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."guest_bootstraps"("account_id","allocation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX guest_renewal_allocation_time ON guest_certificate_renewals (allocation_id, created_at DESC);
--> statement-breakpoint
CREATE FUNCTION guard_guest_certificate_renewal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original jsonb; recent integer; last_at timestamptz; field text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Guest renewal history is retained' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM allocations WHERE id=NEW.allocation_id AND account_id=NEW.account_id AND retired_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Guest renewal requires active allocation ownership' USING ERRCODE = '23514';
  END IF;
  SELECT g.identity INTO original FROM guest_identities g JOIN guest_bootstraps b USING(allocation_id,account_id)
    WHERE g.allocation_id=NEW.allocation_id AND g.account_id=NEW.account_id AND b.consumed_at IS NOT NULL AND g.identity->>'kind'='issued';
  IF original IS NULL THEN
    RAISE EXCEPTION 'Guest renewal requires completed enrollment' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.identity IS NOT NULL OR NEW.created_at <> now() THEN
      RAISE EXCEPTION 'Guest renewal starts with an unissued current attempt' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), max(created_at) INTO recent,last_at FROM guest_certificate_renewals
      WHERE allocation_id=NEW.allocation_id AND created_at > now()-interval '1 hour';
    IF recent >= 4 OR last_at > now()-interval '30 seconds' THEN
      RAISE EXCEPTION 'Guest renewal signing budget exceeded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'identity') IS DISTINCT FROM (to_jsonb(OLD)-'identity') OR OLD.identity IS NOT NULL OR NEW.identity IS NULL THEN
    RAISE EXCEPTION 'Guest renewal attempts are immutable after issuance' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at < now()-interval '5 minutes' OR
    NEW.identity - ARRAY['sshHostCertificate','tlsCertificate','issuedAt'] IS DISTINCT FROM original - ARRAY['sshHostCertificate','tlsCertificate','issuedAt'] THEN
    RAISE EXCEPTION 'Guest renewal cannot change identity or complete a stale signing attempt' USING ERRCODE = '23514';
  END IF;
  FOREACH field IN ARRAY ARRAY['sshHostCertificate','tlsCertificate','issuedAt'] LOOP
    IF jsonb_typeof(NEW.identity->field) IS DISTINCT FROM 'string' OR COALESCE(NEW.identity->>field,'') !~ '\S' THEN
      RAISE EXCEPTION 'Guest renewal requires certificate and timestamp strings' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.identity->>'issuedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' OR
    NOT isfinite((NEW.identity->>'issuedAt')::timestamptz) OR
    (NEW.identity->>'issuedAt')::timestamptz < NEW.created_at OR
    (NEW.identity->>'issuedAt')::timestamptz > clock_timestamp() OR
    (NEW.identity->>'issuedAt')::timestamptz <= (original->>'issuedAt')::timestamptz OR
    EXISTS(SELECT 1 FROM guest_certificate_renewals r WHERE r.allocation_id=NEW.allocation_id AND r.identity IS NOT NULL AND
      (r.identity->>'issuedAt')::timestamptz >= (NEW.identity->>'issuedAt')::timestamptz) THEN
    RAISE EXCEPTION 'Guest renewal issuance must advance with database time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_certificate_renewal_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_certificate_renewals
FOR EACH ROW EXECUTE FUNCTION guard_guest_certificate_renewal();
