CREATE TABLE "image_verifier_bootstraps" (
	"build_id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"sealed_token" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_verifier_identities" (
	"build_id" text PRIMARY KEY NOT NULL,
	"effect_id" text NOT NULL,
	"server_id" text NOT NULL,
	"identity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_verifier_results" (
	"build_id" text PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_verifier_signing_attempts" (
	"build_id" text NOT NULL,
	"purpose" text NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_verifier_signing_attempts_build_id_purpose_sequence_pk" PRIMARY KEY("build_id","purpose","sequence")
);
--> statement-breakpoint
ALTER TABLE "image_verifier_bootstraps" ADD CONSTRAINT "image_verifier_bootstraps_build_id_image_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_verifier_identities" ADD CONSTRAINT "image_verifier_identities_build_id_image_verifier_bootstraps_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_verifier_bootstraps"("build_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_verifier_identities" ADD CONSTRAINT "image_verifier_identities_build_id_effect_id_image_build_effects_build_id_id_fk" FOREIGN KEY ("build_id","effect_id") REFERENCES "public"."image_build_effects"("build_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_verifier_results" ADD CONSTRAINT "image_verifier_results_build_id_image_verifier_identities_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_verifier_identities"("build_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_verifier_signing_attempts" ADD CONSTRAINT "image_verifier_signing_attempts_build_id_image_verifier_bootstraps_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_verifier_bootstraps"("build_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION require_active_image_verifier(build_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE build image_builds;
BEGIN
  SELECT * INTO build FROM image_builds WHERE id=build_id FOR UPDATE;
  IF NOT FOUND OR build.state->>'kind' IS DISTINCT FROM 'running'
    OR (build.admission->>'deadlineAt')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'Image verifier requires active admission' USING ERRCODE='23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_image_verifier_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE build image_builds; manifest jsonb; expected_image jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Verifier bootstrap history is retained' USING ERRCODE='23514'; END IF;
  PERFORM require_active_image_verifier(NEW.build_id);
  IF TG_OP='UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF (to_jsonb(NEW)-'sealed_token'-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'sealed_token'-'consumed_at')
      OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.sealed_token IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM image_verifier_identities WHERE build_id=NEW.build_id AND identity->>'kind'='issued') THEN
      RAISE EXCEPTION 'Verifier bootstrap is immutable and consumed only with issued identity' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO build FROM image_builds WHERE id=NEW.build_id;
  manifest := build.admission->'source'->'manifest';
  expected_image := jsonb_build_object('providerImage',NEW.snapshot_id,'architecture',manifest->'architecture',
    'version',manifest->'version','manifestDigest',build.admission->'source'->'manifestDigest') || (manifest->'trust');
  IF NEW.snapshot_id !~ '^[1-9][0-9]*$' OR NEW.token_hash !~ '^[0-9a-f]{64}$'
    OR NEW.consumed_at IS NOT NULL OR NEW.sealed_token IS NULL
    OR NEW.sealed_token->>'version' IS DISTINCT FROM '1'
    OR NOT COALESCE(NEW.sealed_token->>'nonce' ~ '^[A-Za-z0-9+/]{16}$',false)
    OR NOT COALESCE(NEW.sealed_token->>'ciphertext' ~ '^[A-Za-z0-9+/]{58}==$' ,false)
    OR NOT COALESCE(NEW.sealed_token->>'tag' ~ '^[A-Za-z0-9+/]{22}==$' ,false)
    OR NEW.sealed_token IS DISTINCT FROM jsonb_build_object('version',1,'nonce',NEW.sealed_token->>'nonce','ciphertext',NEW.sealed_token->>'ciphertext','tag',NEW.sealed_token->>'tag')
    OR NEW.expires_at <= clock_timestamp() OR NEW.expires_at > clock_timestamp()+interval '30 minutes'
    OR NEW.expires_at > (build.admission->>'deadlineAt')::timestamptz
    OR jsonb_typeof(NEW.spec->'expiresAt') IS DISTINCT FROM 'string'
    OR NOT COALESCE(NEW.spec->>'expiresAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$',false)
    OR (NEW.spec->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
    OR NOT COALESCE(NEW.spec->>'enrollmentUrl' ~ '^https://[^/?#@]+/[^?#]*$',false)
    OR NEW.spec IS DISTINCT FROM jsonb_build_object('version',2,'subject',jsonb_build_object('kind','image_verifier','id',NEW.build_id),
      'image',expected_image,'expiresAt',NEW.spec->>'expiresAt','enrollmentUrl',NEW.spec->>'enrollmentUrl')
    OR NOT EXISTS(SELECT 1 FROM image_build_resources r JOIN image_build_effects e ON e.id=r.effect_id AND e.build_id=r.build_id
      JOIN image_builder_work w ON w.build_id=r.build_id WHERE r.build_id=NEW.build_id AND r.kind='snapshot'
      AND r.role='snapshot' AND r.provider_id=NEW.snapshot_id AND r.state->>'kind'='observed'
      AND e.resolution->>'kind'='confirmed' AND w.progress->>'kind'='sanitized'
      AND r.state->'resource'->>'sourceServerId'=w.server_id AND r.state->'resource'->>'status'='available') THEN
    RAISE EXCEPTION 'Verifier bootstrap requires exact owned snapshot and bounded encrypted intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_verifier_bootstrap_guard BEFORE INSERT OR UPDATE OR DELETE ON image_verifier_bootstraps
FOR EACH ROW EXECUTE FUNCTION guard_image_verifier_bootstrap();
--> statement-breakpoint
CREATE FUNCTION guard_image_verifier_identity_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bootstrap image_verifier_bootstraps;
BEGIN
  PERFORM require_active_image_verifier(NEW.build_id);
  SELECT * INTO bootstrap FROM image_verifier_bootstraps WHERE build_id=NEW.build_id;
  IF NOT FOUND OR bootstrap.consumed_at IS NOT NULL OR bootstrap.expires_at <= clock_timestamp()
    OR NEW.identity->>'imageVersion' IS DISTINCT FROM bootstrap.spec->'image'->>'version'
    OR NOT COALESCE(NEW.identity->>'sshHostPublicKey' ~ '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$',false)
    OR length(NEW.identity->>'sshHostPublicKey')>512 OR length(NEW.identity->>'tlsCsr')>8192
    OR length(NEW.identity->>'imageVersion')>64 OR length(NEW.identity->>'sshHostCertificate')>16384
    OR length(NEW.identity->>'tlsCertificate')>16384
    OR NOT EXISTS(SELECT 1 FROM image_build_effects e JOIN image_build_resources r ON r.build_id=e.build_id AND r.effect_id=e.id
      WHERE e.build_id=NEW.build_id AND e.id=NEW.effect_id AND e.command->>'kind'='create_server'
      AND e.command->'labels'->>'role'='verifier' AND e.command->>'imageId'=bootstrap.snapshot_id
      AND e.command->'bootData'=jsonb_build_object('kind','image_verifier_secret','id',NEW.build_id,'digest',bootstrap.spec->'image'->'manifestDigest')
      AND e.resolution->>'kind'='confirmed' AND r.kind='server' AND r.role='verifier' AND r.provider_id=NEW.server_id AND r.state->>'kind'='observed') THEN
    RAISE EXCEPTION 'Verifier identity requires its confirmed owned boot and active bootstrap' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_verifier_identity_owner_guard BEFORE INSERT OR UPDATE ON image_verifier_identities
FOR EACH ROW EXECUTE FUNCTION guard_image_verifier_identity_owner();
--> statement-breakpoint
CREATE TRIGGER image_verifier_identity_shape_guard BEFORE INSERT OR UPDATE OR DELETE ON image_verifier_identities
FOR EACH ROW EXECUTE FUNCTION guard_guest_identity();
--> statement-breakpoint
CREATE FUNCTION guard_image_verifier_signing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous image_verifier_signing_attempts; bootstrap image_verifier_bootstraps; issued boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Verifier signing history is immutable' USING ERRCODE='23514'; END IF;
  PERFORM require_active_image_verifier(NEW.build_id);
  SELECT * INTO bootstrap FROM image_verifier_bootstraps WHERE build_id=NEW.build_id;
  SELECT EXISTS(SELECT 1 FROM image_verifier_identities WHERE build_id=NEW.build_id AND identity->>'kind'='issued') INTO issued;
  IF bootstrap.build_id IS NULL OR NOT COALESCE(NEW.purpose IN ('probe','identity','runtime'),false)
    OR (NEW.purpose='runtime' AND NOT issued)
    OR (NEW.purpose<>'runtime' AND (issued OR bootstrap.consumed_at IS NOT NULL OR bootstrap.expires_at <= clock_timestamp()))
    OR (NEW.purpose='identity' AND NOT EXISTS(SELECT 1 FROM image_verifier_identities WHERE build_id=NEW.build_id AND identity->>'kind'='claimed')) THEN
    RAISE EXCEPTION 'Verifier signing purpose requires its current enrollment phase' USING ERRCODE='23514';
  END IF;
  SELECT * INTO previous FROM image_verifier_signing_attempts WHERE build_id=NEW.build_id AND purpose=NEW.purpose ORDER BY sequence DESC LIMIT 1;
  IF NEW.sequence<>COALESCE(previous.sequence,0)+1 OR NEW.sequence > (CASE WHEN NEW.purpose='identity' THEN 4 ELSE 12 END)
    OR previous.created_at+interval '30 seconds' > clock_timestamp()
    OR abs(extract(epoch from NEW.created_at-clock_timestamp())) > 5 THEN
    RAISE EXCEPTION 'Verifier signing has durable limits and cooldown' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_verifier_signing_guard BEFORE INSERT OR UPDATE OR DELETE ON image_verifier_signing_attempts
FOR EACH ROW EXECUTE FUNCTION guard_image_verifier_signing();
--> statement-breakpoint
CREATE FUNCTION guard_image_verifier_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE build image_builds; bootstrap image_verifier_bootstraps; identity image_verifier_identities; work image_builder_work;
  runtime jsonb; checks jsonb; manifest jsonb; component text; expected_proof jsonb; expected_proxy jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Verifier completion evidence is immutable' USING ERRCODE='23514'; END IF;
  PERFORM require_active_image_verifier(NEW.build_id);
  SELECT * INTO build FROM image_builds WHERE id=NEW.build_id;
  SELECT * INTO bootstrap FROM image_verifier_bootstraps WHERE build_id=NEW.build_id;
  SELECT * INTO identity FROM image_verifier_identities WHERE build_id=NEW.build_id;
  SELECT * INTO work FROM image_builder_work WHERE build_id=NEW.build_id;
  manifest := build.admission->'source'->'manifest';
  runtime := NEW.result->'runtime'; checks := runtime->'checks';
  expected_proof := jsonb_build_object('version',2,'subject',bootstrap.spec->'subject',
    'sshHostPublicKey',identity.identity->'sshHostPublicKey','tlsCsr',identity.identity->'tlsCsr',
    'imageVersion',manifest->'version','manifestDigest',build.admission->'source'->'manifestDigest');
  expected_proxy := jsonb_build_object('kind','ok','subject',bootstrap.spec->'subject','imageVersion',manifest->'version');
  IF identity.identity->>'kind' IS DISTINCT FROM 'issued' OR bootstrap.consumed_at IS NULL
    OR work.progress->>'kind' IS DISTINCT FROM 'sanitized' OR identity.server_id=work.server_id
    OR runtime->'proof' IS DISTINCT FROM expected_proof OR runtime->'manifest' IS DISTINCT FROM manifest
    OR jsonb_typeof(runtime->'machineId') IS DISTINCT FROM 'string' OR NOT COALESCE(runtime->>'machineId' ~ '^[0-9a-f]{32}$',false)
    OR runtime->>'machineId'=work.progress->'installation'->>'machineId'
    OR jsonb_typeof(runtime->'bootId') IS DISTINCT FROM 'string' OR NOT COALESCE(runtime->>'bootId' ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)
    OR runtime IS DISTINCT FROM jsonb_build_object('version',2,'proof',expected_proof,'manifest',manifest,
      'architecture',manifest->'architecture','bootId',runtime->'bootId','machineId',runtime->'machineId','checks',checks)
    OR checks->'proxy' IS DISTINCT FROM expected_proxy
    OR checks - ARRAY['node','docker','compose','caddy','step','disk','proxy'] IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(checks->'disk'->'availableBytes') IS DISTINCT FROM 'number'
    OR jsonb_typeof(checks->'disk'->'totalBytes') IS DISTINCT FROM 'number'
    OR checks->'disk' IS DISTINCT FROM jsonb_build_object('kind','ok','availableBytes',checks->'disk'->'availableBytes','totalBytes',checks->'disk'->'totalBytes')
    OR (checks->'disk'->>'availableBytes')::numeric < 1073741824
    OR (checks->'disk'->>'availableBytes')::numeric > (checks->'disk'->>'totalBytes')::numeric
    OR (checks->'disk'->>'totalBytes')::numeric > 9007199254740991
    OR trunc((checks->'disk'->>'availableBytes')::numeric) <> (checks->'disk'->>'availableBytes')::numeric
    OR trunc((checks->'disk'->>'totalBytes')::numeric) <> (checks->'disk'->>'totalBytes')::numeric
    OR NEW.result IS DISTINCT FROM jsonb_build_object('serverId',identity.server_id,'effectId',identity.effect_id,
      'snapshotId',bootstrap.snapshot_id,'runtime',runtime,'verifiedAt',NEW.result->>'verifiedAt')
    OR NOT COALESCE(NEW.result->>'verifiedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$',false)
    OR abs(extract(epoch from (NEW.result->>'verifiedAt')::timestamptz-clock_timestamp())) > 30 THEN
    RAISE EXCEPTION 'Verifier result requires fresh distinct boot, pinned image and healthy runtime' USING ERRCODE='23514';
  END IF;
  FOREACH component IN ARRAY ARRAY['node','docker','compose','caddy','step'] LOOP
    IF checks->component IS DISTINCT FROM jsonb_build_object('kind','ok','version',manifest->'components'->component) THEN
      RAISE EXCEPTION 'Verifier component differs from pinned image' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_verifier_result_guard BEFORE INSERT OR UPDATE OR DELETE ON image_verifier_results
FOR EACH ROW EXECUTE FUNCTION guard_image_verifier_result();
--> statement-breakpoint
CREATE FUNCTION guard_image_verifier_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bootstrap image_verifier_bootstraps;
BEGIN
  IF NEW.command->>'kind'<>'create_server' OR NEW.command->'labels'->>'role'<>'verifier' THEN RETURN NEW; END IF;
  SELECT * INTO bootstrap FROM image_verifier_bootstraps WHERE build_id=NEW.build_id;
  IF NOT FOUND OR bootstrap.consumed_at IS NOT NULL OR bootstrap.expires_at <= clock_timestamp()
    OR NEW.command->>'imageId' IS DISTINCT FROM bootstrap.snapshot_id
    OR NEW.command->'bootData' IS DISTINCT FROM jsonb_build_object('kind','image_verifier_secret','id',NEW.build_id,'digest',bootstrap.spec->'image'->'manifestDigest') THEN
    RAISE EXCEPTION 'Verifier effect requires exact prepared bootstrap' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_verifier_effect_guard BEFORE INSERT ON image_build_effects
FOR EACH ROW EXECUTE FUNCTION guard_image_verifier_effect();
