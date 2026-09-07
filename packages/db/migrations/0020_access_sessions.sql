ALTER TABLE "allocations" ADD CONSTRAINT "allocation_machine_identity" UNIQUE("account_id","machine_id","id");
--> statement-breakpoint
CREATE TABLE "access_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"project_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"machine_version" integer NOT NULL,
	"request_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"public_key" text NOT NULL,
	"ticket_hash" text NOT NULL,
	"identity_pin" jsonb NOT NULL,
	"gateway" jsonb NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"issue_deadline" timestamp with time zone NOT NULL,
	"hard_deadline" timestamp with time zone NOT NULL,
	"issuance" jsonb DEFAULT '{"kind":"pending"}'::jsonb NOT NULL,
	"connection" jsonb DEFAULT '{"kind":"unclaimed"}'::jsonb NOT NULL,
	CONSTRAINT "access_sessions_ticket_hash_unique" UNIQUE("ticket_hash"),
	CONSTRAINT "access_request_identity" UNIQUE("account_id","grant_id","request_key"),
	CONSTRAINT "access_machine_version" CHECK ("access_sessions"."machine_version" > 0),
	CONSTRAINT "access_hashes" CHECK ("access_sessions"."ticket_hash" ~ '^[0-9a-f]{64}$' AND "access_sessions"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "access_deadlines" CHECK ("access_sessions"."issue_deadline" > "access_sessions"."admitted_at"
      AND "access_sessions"."issue_deadline" <= "access_sessions"."admitted_at" + interval '90 seconds'
      AND "access_sessions"."hard_deadline" > "access_sessions"."admitted_at"
      AND "access_sessions"."hard_deadline" <= "access_sessions"."admitted_at" + interval '1 hour')
);
--> statement-breakpoint
CREATE TABLE "access_signing_attempts" (
	"session_id" text PRIMARY KEY NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_machine_scope" FOREIGN KEY ("account_id","project_id","machine_id") REFERENCES "public"."machines"("account_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_allocation_scope" FOREIGN KEY ("account_id","machine_id","allocation_id") REFERENCES "public"."allocations"("account_id","machine_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_grant_scope" FOREIGN KEY ("account_id","grant_id") REFERENCES "public"."grants"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_signing_attempts" ADD CONSTRAINT "access_signing_attempts_session_id_access_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."access_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_account_window" ON "access_sessions" USING btree ("account_id","admitted_at");--> statement-breakpoint
CREATE INDEX "access_grant_window" ON "access_sessions" USING btree ("grant_id","admitted_at");--> statement-breakpoint
CREATE INDEX "access_machine_connections" ON "access_sessions" USING btree ("machine_id") WHERE "access_sessions"."connection"->>'kind' <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "access_gateway_connection" ON "access_sessions" USING btree (("gateway"->>'id'),COALESCE("connection"->>'gatewayInstanceId', "connection"->'previous'->>'gatewayInstanceId'),COALESCE("connection"->>'connectionId', "connection"->'previous'->>'connectionId'));--> statement-breakpoint

-- Wire shape only. Cryptographic validity and current trust belong to the signer.
CREATE FUNCTION valid_access_key(value text, allow_ca boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE encoded text; wire bytea;
BEGIN
  IF value ~ '^ssh-ed25519 [A-Za-z0-9+/]{68}$' THEN
    encoded := substr(value,13); wire := decode(encoded,'base64');
    RETURN octet_length(wire)=51 AND encode(wire,'base64')=encoded
      AND encode(substring(wire FROM 1 FOR 19),'hex')='0000000b7373682d6564323535313900000020';
  ELSIF allow_ca AND value ~ '^ecdsa-sha2-nistp256 [A-Za-z0-9+/]{139}=$' THEN
    encoded := substr(value,21); wire := decode(encoded,'base64');
    RETURN octet_length(wire)=104 AND replace(encode(wire,'base64'),E'\n','')=encoded
      AND encode(substring(wire FROM 1 FOR 40),'hex')='0000001365636473612d736861322d6e69737470323536000000086e697374703235360000004104';
  END IF;
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION access_string_object(value jsonb, keys text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
  RETURN value ?& keys AND value-keys='{}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(value) field WHERE jsonb_typeof(field.value)<>'string');
END;
$$;
--> statement-breakpoint
CREATE FUNCTION valid_access_address(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF position('/' IN value)>0 OR NOT pg_input_is_valid(value,'inet') THEN RETURN false; END IF;
  IF family(value::inet)=6 THEN RETURN value ~ '^[0-9a-fA-F:.]+$'; END IF;
  RETURN value ~ '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION valid_access_gateway(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE origin text; parts text[]; hostname text; item jsonb; cidr_value text; ip text; bits text;
BEGIN
  IF jsonb_typeof(value)<>'object' OR NOT value ?& ARRAY['id','origin','egressCidrs']
    OR value-ARRAY['id','origin','egressCidrs']<>'{}'::jsonb
    OR jsonb_typeof(value->'id')<>'string' OR jsonb_typeof(value->'origin')<>'string'
    OR jsonb_typeof(value->'egressCidrs')<>'array'
    OR value->>'id' !~ '^[a-z0-9][a-z0-9-]{0,62}$' OR value->>'id' ~ '[^a-z0-9-]' THEN RETURN false; END IF;
  origin := value->>'origin';
  IF length(origin)>2048 THEN RETURN false; END IF;
  parts := regexp_match(origin,'^(wss?)://([a-z0-9.-]+|\[[0-9a-f:.]+\])(:([1-9][0-9]{0,4}))?$');
  IF parts IS NULL THEN RETURN false; END IF;
  hostname := parts[2];
  IF parts[4] IS NOT NULL AND parts[4]::integer>65535 THEN RETURN false; END IF;
  IF parts[1]='ws' AND hostname NOT IN ('localhost','127.0.0.1','[::1]') THEN RETURN false; END IF;
  IF left(hostname,1)='[' THEN
    ip := substr(hostname,2,length(hostname)-2);
    IF NOT valid_access_address(ip) OR family(ip::inet)<>6 THEN RETURN false; END IF;
  ELSIF hostname ~ '^[0-9.]+$' THEN
    IF NOT valid_access_address(hostname) THEN RETURN false; END IF;
  ELSIF length(hostname)>253 OR EXISTS(SELECT 1 FROM unnest(string_to_array(hostname,'.')) label
    WHERE label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') THEN RETURN false;
  END IF;
  IF jsonb_array_length(value->'egressCidrs') NOT BETWEEN 1 AND 16
    OR (SELECT count(DISTINCT source.entry) FROM jsonb_array_elements(value->'egressCidrs') AS source(entry))<>jsonb_array_length(value->'egressCidrs') THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'egressCidrs') LOOP
    IF jsonb_typeof(item)<>'string' THEN RETURN false; END IF;
    cidr_value := item#>>'{}'; ip := split_part(cidr_value,'/',1); bits := split_part(cidr_value,'/',2);
    IF bits !~ '^[1-9][0-9]{0,2}$' OR NOT valid_access_address(ip)
      OR NOT pg_input_is_valid(cidr_value,'inet') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION access_instant(value jsonb) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string'
    OR (value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
    OR NOT pg_input_is_valid(value#>>'{}','timestamptz') THEN
    RAISE EXCEPTION 'Access event requires an ISO UTC instant' USING ERRCODE='23514';
  END IF;
  RETURN (value#>>'{}')::timestamptz;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_access_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issued_at timestamptz; ticket_deadline timestamptz; certificate_expiry timestamptz;
  event_at timestamptz; prior_claim jsonb; state_kind text; clock_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Access sessions retain consumed tickets and signing history' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.issuance IS DISTINCT FROM '{"kind":"pending"}'::jsonb
      OR NEW.connection IS DISTINCT FROM '{"kind":"unclaimed"}'::jsonb
      OR NEW.admitted_at > clock_now OR NOT isfinite(NEW.admitted_at)
      OR NOT isfinite(NEW.issue_deadline) OR NOT isfinite(NEW.hard_deadline) THEN
      RAISE EXCEPTION 'Access admission must begin pending and unclaimed at database time' USING ERRCODE='23514';
    END IF;
    IF NEW.id !~ '^access_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NEW.request_key !~ '^[A-Za-z0-9._:-]{12,128}$' OR NEW.request_key ~ '[^A-Za-z0-9._:-]'
      OR length(NEW.ticket_hash)<>64 OR length(NEW.fingerprint)<>64
      OR NOT valid_access_key(NEW.public_key)
      OR NOT access_string_object(NEW.identity_pin,ARRAY['provider','serverId','primaryIpId','hostAlias','sshHostCa','guestHostPublicKey','imageManifestDigest'])
      OR NEW.identity_pin->>'provider' NOT IN ('hetzner','simulated')
      OR length(NEW.identity_pin->>'serverId') NOT BETWEEN 1 AND 128
      OR length(NEW.identity_pin->>'primaryIpId') NOT BETWEEN 1 AND 128
      OR NEW.identity_pin->>'hostAlias' IS DISTINCT FROM replace(NEW.allocation_id,'alloc_','alloc-')||'.guest.agent-cloud.internal'
      OR NOT valid_access_key(NEW.identity_pin->>'sshHostCa',true)
      OR NOT valid_access_key(NEW.identity_pin->>'guestHostPublicKey')
      OR NEW.identity_pin->>'imageManifestDigest' !~ '^[0-9a-f]{64}$'
      OR NOT valid_access_gateway(NEW.gateway) THEN
      RAISE EXCEPTION 'Access admission requires complete valid immutable request and identity pins' USING ERRCODE='23514';
    END IF;
  ELSIF (to_jsonb(NEW)-'issuance'-'connection') IS DISTINCT FROM (to_jsonb(OLD)-'issuance'-'connection') THEN
    RAISE EXCEPTION 'Access ownership, request, identity and deadlines are immutable' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.issuance)<>'object' OR jsonb_typeof(NEW.connection)<>'object' THEN
    RAISE EXCEPTION 'Access states must be objects' USING ERRCODE='23514';
  END IF;
  state_kind := COALESCE(NEW.issuance->>'kind','');
  IF state_kind='pending' THEN
    IF NEW.issuance IS DISTINCT FROM '{"kind":"pending"}'::jsonb THEN
      RAISE EXCEPTION 'Pending issuance cannot contain credentials' USING ERRCODE='23514';
    END IF;
  ELSIF state_kind='attempted' THEN
    IF NOT access_string_object(NEW.issuance,ARRAY['kind','attemptedAt']) THEN
      RAISE EXCEPTION 'Signing requires an explicit attempt receipt' USING ERRCODE='23514';
    END IF;
    event_at := access_instant(NEW.issuance->'attemptedAt');
    IF event_at<NEW.admitted_at OR event_at>=LEAST(NEW.issue_deadline,NEW.hard_deadline) OR event_at>clock_now THEN
      RAISE EXCEPTION 'Signing attempt is outside its authority' USING ERRCODE='23514';
    END IF;
  ELSIF state_kind='issued' THEN
    IF NOT access_string_object(NEW.issuance-'target',ARRAY['kind','certificate','issuedAt','ticketDeadline','certificateExpiresAt'])
      OR length(NEW.issuance->>'certificate') NOT BETWEEN 1 AND 16384
      OR (NEW.issuance->'target')-ARRAY['address','port'] IS DISTINCT FROM NEW.identity_pin
      OR NEW.issuance->'target'->'port' IS DISTINCT FROM '22'::jsonb
      OR jsonb_typeof(NEW.issuance->'target'->'address') IS DISTINCT FROM 'string'
      OR NOT valid_access_address(NEW.issuance->'target'->>'address') THEN
      RAISE EXCEPTION 'Issued access must retain its exact target and certificate' USING ERRCODE='23514';
    END IF;
    issued_at := access_instant(NEW.issuance->'issuedAt');
    ticket_deadline := access_instant(NEW.issuance->'ticketDeadline');
    certificate_expiry := access_instant(NEW.issuance->'certificateExpiresAt');
    IF issued_at<NEW.admitted_at OR issued_at>=LEAST(NEW.issue_deadline,NEW.hard_deadline) OR issued_at>clock_now
      OR ticket_deadline<=issued_at OR ticket_deadline>LEAST(issued_at+interval '60 seconds',NEW.issue_deadline,NEW.hard_deadline)
      OR certificate_expiry<=issued_at OR certificate_expiry>LEAST(issued_at+interval '5 minutes',NEW.hard_deadline) THEN
      RAISE EXCEPTION 'Issued credentials exceed their original authority' USING ERRCODE='23514';
    END IF;
  ELSIF state_kind='unavailable' THEN
    IF NOT access_string_object(NEW.issuance,ARRAY['kind','reason'])
      OR NEW.issuance->>'reason' NOT IN ('signing_unknown','signing_failed','provider_rejected','authorization_changed','target_changed','deadline_exceeded') THEN
      RAISE EXCEPTION 'Unavailable issuance requires a bounded failure reason' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown access issuance state' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.issuance IS DISTINCT FROM OLD.issuance THEN
    IF NOT ((OLD.issuance->>'kind'='pending' AND state_kind IN ('attempted','unavailable'))
      OR (OLD.issuance->>'kind'='attempted' AND state_kind IN ('issued','unavailable'))) THEN
      RAISE EXCEPTION 'An access session permits only one signing attempt and result' USING ERRCODE='23514';
    END IF;
    IF OLD.issuance->>'kind'='pending' AND NEW.issuance->>'reason' IN ('signing_unknown','signing_failed') THEN
      RAISE EXCEPTION 'Signing outcomes require a preceding attempt' USING ERRCODE='23514';
    END IF;
    IF state_kind IN ('attempted','issued') AND (NEW.connection IS DISTINCT FROM '{"kind":"unclaimed"}'::jsonb
      OR OLD.connection IS DISTINCT FROM NEW.connection OR clock_now>=LEAST(NEW.issue_deadline,NEW.hard_deadline)) THEN
      RAISE EXCEPTION 'Closed or expired sessions cannot submit or publish credentials' USING ERRCODE='23514';
    END IF;
    IF state_kind='issued' AND (clock_now>=LEAST(ticket_deadline,certificate_expiry)
      OR issued_at<access_instant(OLD.issuance->'attemptedAt')) THEN
      RAISE EXCEPTION 'Publication requires a preceding attempt and unexpired credentials' USING ERRCODE='23514';
    END IF;
  END IF;
  state_kind := COALESCE(NEW.connection->>'kind','');
  IF state_kind='unclaimed' THEN
    IF NEW.connection IS DISTINCT FROM '{"kind":"unclaimed"}'::jsonb THEN
      RAISE EXCEPTION 'Unclaimed connection cannot contain a claim' USING ERRCODE='23514';
    END IF;
    prior_claim := NEW.connection;
  ELSIF state_kind='claimed' THEN
    prior_claim := NEW.connection;
  ELSIF state_kind='closed' THEN
    IF NOT access_string_object(NEW.connection-'previous',ARRAY['kind','closedAt','reason'])
      OR NEW.connection->>'reason' NOT IN ('client_closed','target_closed','authorization_changed','target_changed','expired','gateway_unavailable','transport_failed','limit_exceeded') THEN
      RAISE EXCEPTION 'Closed access retains its prior connection and close reason' USING ERRCODE='23514';
    END IF;
    prior_claim := NEW.connection->'previous';
    event_at := access_instant(NEW.connection->'closedAt');
    IF event_at<NEW.admitted_at OR event_at>clock_now THEN
      RAISE EXCEPTION 'Access closure requires an observed database instant' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown access connection state' USING ERRCODE='23514';
  END IF;
  IF prior_claim->>'kind'='claimed' THEN
    IF NOT access_string_object(prior_claim,ARRAY['kind','gatewayInstanceId','connectionId','claimedAt'])
      OR NEW.issuance->>'kind' IS DISTINCT FROM 'issued'
      OR prior_claim->>'gatewayInstanceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR prior_claim->>'connectionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'A ticket claim requires issued credentials and exact connection identity' USING ERRCODE='23514';
    END IF;
    event_at := access_instant(prior_claim->'claimedAt');
    IF event_at<issued_at OR event_at>=LEAST(ticket_deadline,NEW.hard_deadline) OR event_at>clock_now
      OR (state_kind='closed' AND event_at>access_instant(NEW.connection->'closedAt')) THEN
      RAISE EXCEPTION 'Claim time exceeds the issued ticket authority' USING ERRCODE='23514';
    END IF;
  ELSIF prior_claim IS DISTINCT FROM '{"kind":"unclaimed"}'::jsonb THEN
    RAISE EXCEPTION 'Invalid retained connection receipt' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.connection IS DISTINCT FROM OLD.connection THEN
    IF OLD.connection->>'kind'='unclaimed' AND state_kind='claimed' THEN
      IF OLD.issuance->>'kind' IS DISTINCT FROM 'issued' OR NEW.issuance IS DISTINCT FROM OLD.issuance
        OR clock_now>=LEAST(ticket_deadline,NEW.hard_deadline) THEN
        RAISE EXCEPTION 'Ticket must be issued and unexpired before one atomic claim' USING ERRCODE='23514';
      END IF;
    ELSIF OLD.connection->>'kind' IN ('unclaimed','claimed') AND state_kind='closed' THEN
      IF NEW.connection->'previous' IS DISTINCT FROM OLD.connection THEN
        RAISE EXCEPTION 'Closure cannot replace the original connection receipt' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Consumed or closed access cannot reopen' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER access_session_guard BEFORE INSERT OR UPDATE OR DELETE ON access_sessions
FOR EACH ROW EXECUTE FUNCTION guard_access_session();
--> statement-breakpoint
CREATE FUNCTION guard_access_signing_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Signing attempt receipts are immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM access_sessions WHERE id=NEW.session_id
    AND issuance->>'kind'='attempted' AND access_instant(issuance->'attemptedAt')=NEW.attempted_at) THEN
    RAISE EXCEPTION 'Signing receipt requires its exact session transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER access_signing_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON access_signing_attempts
FOR EACH ROW EXECUTE FUNCTION guard_access_signing_attempt();
--> statement-breakpoint
CREATE FUNCTION record_access_signing_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO access_signing_attempts(session_id,attempted_at)
  VALUES(NEW.id,access_instant(NEW.issuance->'attemptedAt'));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER access_signing_attempt_record AFTER UPDATE ON access_sessions
FOR EACH ROW WHEN (OLD.issuance->>'kind'='pending' AND NEW.issuance->>'kind'='attempted')
EXECUTE FUNCTION record_access_signing_attempt();
