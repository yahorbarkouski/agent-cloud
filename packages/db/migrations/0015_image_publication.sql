CREATE TABLE "image_publications" (
	"build_id" text PRIMARY KEY NOT NULL,
	"evidence" jsonb NOT NULL,
	"release" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_publications" ADD CONSTRAINT "image_publications_build_id_image_verifier_results_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_verifier_results"("build_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Save provenance while source/verifier observations still exist. SQL does not verify
-- Ed25519 signatures; the control-plane signer and every consumer do that independently.
CREATE FUNCTION guard_image_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE build image_builds; work image_builder_work; verified image_verifier_results;
  snapshot image_build_resources; stopped image_build_effects; expected jsonb; payload jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Image publication evidence is retained' USING ERRCODE='23514'; END IF;
  SELECT * INTO build FROM image_builds WHERE id=NEW.build_id FOR UPDATE;
  IF NOT FOUND OR build.admission->'retention'->>'kind' IS DISTINCT FROM 'retain'
    OR (build.admission->>'deadlineAt')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'Image publication requires an active retained admission' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF build.state->>'kind'<>'running' OR NEW.release IS NOT NULL THEN
      RAISE EXCEPTION 'Image publication starts unsigned from a running build' USING ERRCODE='23514';
    END IF;
    SELECT * INTO work FROM image_builder_work WHERE build_id=NEW.build_id;
    SELECT * INTO verified FROM image_verifier_results WHERE build_id=NEW.build_id;
    SELECT * INTO snapshot FROM image_build_resources WHERE build_id=NEW.build_id AND role='snapshot';
    SELECT * INTO stopped FROM image_build_effects WHERE build_id=NEW.build_id AND command->>'kind'='power_off'
      AND command->>'serverId'=work.server_id AND resolution->>'kind'='confirmed';
    IF work.progress->>'kind' IS DISTINCT FROM 'sanitized' OR verified.build_id IS NULL OR stopped.id IS NULL
      OR (SELECT count(*) FROM image_build_resources WHERE build_id=NEW.build_id AND role='snapshot')<>1
      OR snapshot.state->>'kind' IS DISTINCT FROM 'observed'
      OR snapshot.state->'resource'->>'status' IS DISTINCT FROM 'available'
      OR snapshot.state->'resource'->>'sourceServerId' IS DISTINCT FROM work.server_id
      OR snapshot.state->'resource'->'diskGb' IS DISTINCT FROM build.admission->'offer'->'diskGb'
      OR snapshot.state->'resource'->'architecture' IS DISTINCT FROM build.admission->'offer'->'architecture'
      OR snapshot.state->'resource'->'deleteProtected' IS DISTINCT FROM 'false'::jsonb
      OR verified.result->>'snapshotId' IS DISTINCT FROM snapshot.provider_id
      OR NOT EXISTS(SELECT 1 FROM image_build_effects WHERE id=snapshot.effect_id AND resolution->>'kind'='confirmed')
      OR EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.build_id AND resolution->>'kind'='pending') THEN
      RAISE EXCEPTION 'Publication requires the exact confirmed sanitized snapshot and verifier evidence' USING ERRCODE='23514';
    END IF;
    expected := jsonb_build_object('format',1,'buildId',NEW.build_id,
      'retainUntil',build.admission->'retention'->'deleteAfter',
      'manifest',build.admission->'source'->'manifest','inputs',build.admission->'source'->'inputs',
      'artifacts',build.admission->'source'->'artifacts',
      'sanitation',work.progress->'sanitation' || jsonb_build_object('serverId',work.server_id),
      'snapshot',jsonb_build_object('provider','hetzner','id',snapshot.provider_id,'sourceServerId',work.server_id,
        'diskGb',snapshot.state->'resource'->'diskGb','sourceStoppedAt',stopped.resolution->'at',
        'createdAt',snapshot.state->'resource'->'createdAt'),
      'verifiedBoot',jsonb_build_object('serverId',verified.result->'serverId','bootId',verified.result->'runtime'->'bootId',
        'manifestDigest',verified.result->'runtime'->'proof'->'manifestDigest','checkedAt',verified.result->'verifiedAt'));
    IF NEW.evidence IS DISTINCT FROM expected
      OR (NEW.evidence->'snapshot'->>'sourceStoppedAt')::timestamptz > (NEW.evidence->'snapshot'->>'createdAt')::timestamptz
      OR (NEW.evidence->'snapshot'->>'createdAt')::timestamptz > (NEW.evidence->'verifiedBoot'->>'checkedAt')::timestamptz THEN
      RAISE EXCEPTION 'Image release evidence differs from persisted build history' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'release') IS DISTINCT FROM (to_jsonb(OLD)-'release') OR OLD.release IS NOT NULL
    OR NEW.release IS NULL OR build.state->>'kind'<>'releasing' THEN
    RAISE EXCEPTION 'Image release evidence and signed publication are immutable' USING ERRCODE='23514';
  END IF;
  payload := NEW.release->'payload';
  IF payload-'issuedAt' IS DISTINCT FROM NEW.evidence
    OR NEW.release IS DISTINCT FROM jsonb_build_object('payload',payload,'signature',NEW.release->'signature')
    OR NEW.release->'signature' IS DISTINCT FROM jsonb_build_object('algorithm','Ed25519',
      'keyId',NEW.release->'signature'->'keyId','value',NEW.release->'signature'->'value')
    OR NOT COALESCE(NEW.release->'signature'->>'keyId' ~ '^[0-9a-f]{64}$'
      AND NEW.release->'signature'->>'value' ~ '^[A-Za-z0-9_-]{86}$'
      AND payload->>'issuedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$',false)
    OR (payload->>'issuedAt')::timestamptz < (payload->'verifiedBoot'->>'checkedAt')::timestamptz
    OR (payload->>'issuedAt')::timestamptz > clock_timestamp()
    OR (payload->>'retainUntil')::timestamptz <= clock_timestamp()
    OR EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.build_id AND resolution->>'kind'='pending')
    OR EXISTS(SELECT 1 FROM image_build_resources WHERE build_id=NEW.build_id AND role<>'snapshot' AND state->>'kind'<>'absent')
    OR NOT EXISTS(SELECT 1 FROM image_build_resources WHERE build_id=NEW.build_id AND role='snapshot'
      AND provider_id=payload->'snapshot'->>'id' AND state->>'kind'='observed'
      AND state->'resource'->>'status'='available') THEN
    RAISE EXCEPTION 'Signed publication requires matching evidence and complete temporary cleanup' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON image_publications
FOR EACH ROW EXECUTE FUNCTION guard_image_publication();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_image_build() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Image build ownership is retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.admission->>'id' IS DISTINCT FROM NEW.id OR NEW.admission->>'provider' IS DISTINCT FROM 'hetzner'
      OR NEW.state IS DISTINCT FROM '{"kind":"running"}'::jsonb THEN
      RAISE EXCEPTION 'Image build admission identity is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
    RAISE EXCEPTION 'Image build admission is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF NOT COALESCE(
    (OLD.state->>'kind' IN ('running','releasing','retained') AND NEW.state=jsonb_build_object('kind','cleaning','reason',NEW.state->>'reason')
      AND NEW.state->>'reason' IN ('requested','expired','failed'))
    OR (OLD.state->>'kind'='running' AND NEW.state='{"kind":"releasing"}'::jsonb
      AND (NEW.admission->>'deadlineAt')::timestamptz > clock_timestamp()
      AND EXISTS(SELECT 1 FROM image_publications WHERE build_id=NEW.id AND release IS NULL))
    OR (OLD.state->>'kind'='releasing' AND NEW.state=jsonb_build_object('kind','retained','at',NEW.state->>'at')
      AND NEW.state->>'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
      AND EXISTS(SELECT 1 FROM image_publications WHERE build_id=NEW.id AND release IS NOT NULL
        AND release->'payload'->>'issuedAt'=NEW.state->>'at'))
    OR (OLD.state->>'kind'='cleaning' AND NEW.state=jsonb_build_object('kind','cleaned','at',NEW.state->>'at')
      AND NEW.state->>'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'),false) THEN
    RAISE EXCEPTION 'Image build publication and cleanup only move forward' USING ERRCODE='23514';
  END IF;
  IF NEW.state->>'kind'='retained' AND (
    EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.id AND resolution->>'kind'='pending') OR
    EXISTS(SELECT 1 FROM image_build_resources WHERE build_id=NEW.id AND role<>'snapshot' AND state->>'kind'<>'absent')) THEN
    RAISE EXCEPTION 'Image retention requires complete temporary cleanup' USING ERRCODE='23514';
  END IF;
  IF NEW.state->>'kind' = 'cleaned' AND (
    EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.id AND resolution->>'kind'='pending') OR
    EXISTS(SELECT 1 FROM image_build_resources WHERE build_id=NEW.id AND state->>'kind'<>'absent')) THEN
    RAISE EXCEPTION 'Image cleanup requires resolved effects and absent resources' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_image_build_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE build image_builds; command_kind text; role text; expected_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Image effects are retained' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO build FROM image_builds WHERE id=NEW.build_id FOR UPDATE;
  IF NOT FOUND OR build.state->>'kind'='cleaned' THEN
    RAISE EXCEPTION 'Image effects require an open build' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome IS DISTINCT FROM '{"kind":"prepared"}'::jsonb OR NEW.resolution IS DISTINCT FROM '{"kind":"pending"}'::jsonb THEN
      RAISE EXCEPTION 'Image effects start prepared and unresolved' USING ERRCODE = '23514';
    END IF;
    command_kind := NEW.command->>'kind';
    IF NOT COALESCE(command_kind IN ('create_ssh_key','create_firewall','create_primary_ip','create_server','create_snapshot','power_off','delete'),false) THEN
      RAISE EXCEPTION 'Invalid image command' USING ERRCODE = '23514';
    END IF;
    IF command_kind <> 'delete' AND (build.state->>'kind'<>'running' OR (build.admission->>'deadlineAt')::timestamptz <= clock_timestamp()) THEN
      RAISE EXCEPTION 'Expired or cleaning image builds cannot start new work' USING ERRCODE = '23514';
    END IF;
    IF command_kind LIKE 'create_%' THEN
      role := NEW.command->'labels'->>'role';
      expected_kind := CASE role WHEN 'builder' THEN 'create_server' WHEN 'verifier' THEN 'create_server'
        WHEN 'builder_ip' THEN 'create_primary_ip' WHEN 'verifier_ip' THEN 'create_primary_ip'
        WHEN 'access_key' THEN 'create_ssh_key' WHEN 'access_firewall' THEN 'create_firewall' WHEN 'snapshot' THEN 'create_snapshot' END;
      IF expected_kind IS DISTINCT FROM command_kind OR NEW.effect_key IS DISTINCT FROM 'create:' || role
        OR NEW.command->'labels'->>'build_id' IS DISTINCT FROM NEW.build_id
        OR NEW.command->'labels'->>'scope' IS DISTINCT FROM 'image-build'
        OR NEW.command->'labels'->>'managed_by' IS DISTINCT FROM 'agent-cloud' THEN
        RAISE EXCEPTION 'Image create labels and role must match the build' USING ERRCODE = '23514';
      END IF;
      IF EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.build_id AND resolution->>'kind'='pending') THEN
        RAISE EXCEPTION 'Reconcile image effects before another create' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF command_kind = 'delete' AND build.state->>'kind' NOT IN ('cleaning','releasing') THEN
      RAISE EXCEPTION 'Image deletion requires a cleanup request' USING ERRCODE = '23514';
    END IF;
    IF command_kind='delete' AND build.state->>'kind'='releasing' AND NEW.command->'resource'->>'kind'='snapshot' THEN
      RAISE EXCEPTION 'Retained cleanup cannot delete its snapshot' USING ERRCODE='23514';
    END IF;
    IF command_kind = 'delete' AND NOT EXISTS (
      SELECT 1 FROM image_build_resources WHERE build_id=NEW.build_id
      AND kind=NEW.command->'resource'->>'kind' AND provider_id=NEW.command->'resource'->>'id'
      AND state->>'kind'<>'absent') THEN
      RAISE EXCEPTION 'Image deletion needs a recorded owned resource' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'outcome'-'resolution') IS DISTINCT FROM (to_jsonb(OLD)-'outcome'-'resolution') THEN
    RAISE EXCEPTION 'Image effect identity and command are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND NOT COALESCE(OLD.outcome->>'kind'='prepared'
    AND NEW.outcome->>'kind' IN ('accepted','completed','rejected','unknown'),false) THEN
    RAISE EXCEPTION 'Image provider receipts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution IS DISTINCT FROM OLD.resolution AND NOT COALESCE(OLD.resolution->>'kind'='pending'
    AND NEW.resolution->>'kind' IN ('confirmed','failed','superseded'),false) THEN
    RAISE EXCEPTION 'Image resolutions are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.resolution IS DISTINCT FROM OLD.resolution AND NEW.resolution->>'kind'='superseded' AND (
    NEW.command->>'kind' NOT IN ('delete','power_off') OR OLD.outcome->>'kind' NOT IN ('prepared','unknown','accepted') OR
    NOT EXISTS(SELECT 1 FROM image_build_effects replacement WHERE replacement.id=NEW.resolution->>'byEffectId'
      AND replacement.build_id=NEW.build_id AND replacement.id<>NEW.id AND replacement.command=NEW.command
      AND replacement.outcome->>'kind'='prepared' AND replacement.resolution->>'kind'='pending')) THEN
    RAISE EXCEPTION 'Only uncertain exact-ID effects may delegate to a prepared identical retry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

