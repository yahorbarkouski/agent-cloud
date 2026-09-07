CREATE TABLE "image_builder_work" (
	"build_id" text PRIMARY KEY NOT NULL,
	"effect_id" text NOT NULL,
	"server_id" text NOT NULL,
	"progress" jsonb DEFAULT '{"kind":"installing"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_builder_work" ADD CONSTRAINT "image_builder_work_build_id_effect_id_image_build_effects_build_id_id_fk" FOREIGN KEY ("build_id","effect_id") REFERENCES "public"."image_build_effects"("build_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION guard_image_builder_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE build image_builds; effect image_build_effects; phase text; installation jsonb; expected jsonb;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Builder execution evidence is retained' USING ERRCODE='23514';
  END IF;
  SELECT * INTO build FROM image_builds WHERE id=NEW.build_id FOR UPDATE;
  IF NOT FOUND OR build.state->>'kind'='cleaned' THEN
    RAISE EXCEPTION 'Builder execution requires an open build' USING ERRCODE='23514';
  END IF;
  phase := NEW.progress->>'kind';
  IF TG_OP='INSERT' THEN
    SELECT * INTO effect FROM image_build_effects WHERE build_id=NEW.build_id AND id=NEW.effect_id;
    IF NOT FOUND OR effect.command->>'kind' IS DISTINCT FROM 'create_server'
      OR effect.command->'labels'->>'role' IS DISTINCT FROM 'builder'
      OR effect.resolution->>'kind' IS DISTINCT FROM 'confirmed'
      OR NEW.progress IS DISTINCT FROM '{"kind":"installing"}'::jsonb
      OR NOT EXISTS(SELECT 1 FROM image_build_resources WHERE build_id=NEW.build_id
        AND effect_id=NEW.effect_id AND kind='server' AND role='builder'
        AND provider_id=NEW.server_id AND state->>'kind'='observed') THEN
      RAISE EXCEPTION 'Builder execution needs its confirmed owned server' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-'progress') IS DISTINCT FROM (to_jsonb(OLD)-'progress') THEN
      RAISE EXCEPTION 'Builder execution identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.progress = OLD.progress THEN RETURN NEW; END IF;
    IF NOT COALESCE((OLD.progress->>'kind'='installing' AND phase='installed')
      OR (OLD.progress->>'kind'='installed' AND phase='sanitizing')
      OR (OLD.progress->>'kind'='sanitizing' AND phase='sanitized'), false) THEN
      RAISE EXCEPTION 'Builder execution only moves forward' USING ERRCODE='23514';
    END IF;
    IF OLD.progress ? 'installation' AND NEW.progress->'installation' IS DISTINCT FROM OLD.progress->'installation' THEN
      RAISE EXCEPTION 'Builder installation evidence is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF phase IN ('installing','sanitizing') AND (build.state->>'kind'<>'running'
    OR (build.admission->>'deadlineAt')::timestamptz <= clock_timestamp()
    OR EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.build_id AND resolution->>'kind'='pending')) THEN
    RAISE EXCEPTION 'Fresh builder execution needs active admission and resolved effects' USING ERRCODE='23514';
  END IF;
  IF phase IN ('installed','sanitizing','sanitized') THEN
    installation := NEW.progress->'installation';
    IF jsonb_typeof(installation->'machineId') IS DISTINCT FROM 'string'
      OR NOT COALESCE(installation->>'machineId' ~ '^[0-9a-f]{32}$', false)
      OR installation IS DISTINCT FROM jsonb_build_object('kind','builder','builderId',NEW.build_id,
        'manifestDigest',build.admission->'source'->'manifestDigest','machineId',installation->'machineId') THEN
      RAISE EXCEPTION 'Builder installation evidence has unexpected fields, types or admission' USING ERRCODE='23514';
    END IF;
    expected := jsonb_build_object('kind',phase,'installation',installation);
    IF phase='sanitized' THEN
      expected := expected || jsonb_build_object('sanitation',jsonb_build_object('kind','sanitized',
        'builderId',NEW.build_id,'manifestDigest',build.admission->'source'->'manifestDigest'));
    END IF;
    IF NEW.progress IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Builder execution evidence has unexpected fields or types' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_builder_work_guard BEFORE INSERT OR UPDATE OR DELETE ON image_builder_work
FOR EACH ROW EXECUTE FUNCTION guard_image_builder_work();
--> statement-breakpoint
CREATE FUNCTION guard_image_snapshot_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE work image_builder_work;
BEGIN
  IF NEW.command->>'kind' NOT IN ('power_off','create_snapshot') THEN RETURN NEW; END IF;
  SELECT * INTO work FROM image_builder_work WHERE build_id=NEW.build_id;
  IF NOT FOUND OR work.progress->>'kind' IS DISTINCT FROM 'sanitized'
    OR work.server_id IS DISTINCT FROM NEW.command->>'serverId'
    OR (NEW.command->>'kind'='power_off' AND NEW.command->'sanitation' IS DISTINCT FROM work.progress->'sanitation')
    OR (NEW.command->>'kind'='create_snapshot' AND NOT EXISTS(SELECT 1 FROM image_build_effects
      WHERE build_id=NEW.build_id AND command->>'kind'='power_off'
      AND command->>'serverId'=work.server_id AND command->'sanitation'=work.progress->'sanitation'
      AND resolution->>'kind'='confirmed')) THEN
    RAISE EXCEPTION 'Image stop and snapshot require persisted sanitation evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_snapshot_evidence_guard BEFORE INSERT ON image_build_effects
FOR EACH ROW EXECUTE FUNCTION guard_image_snapshot_evidence();
