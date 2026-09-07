CREATE TABLE "image_build_effects" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"effect_key" text NOT NULL,
	"command" jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{"kind":"prepared"}'::jsonb NOT NULL,
	"resolution" jsonb DEFAULT '{"kind":"pending"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_build_effects_build_id_effect_key_unique" UNIQUE("build_id","effect_key"),
	CONSTRAINT "image_build_effects_build_id_id_unique" UNIQUE("build_id","id")
);
--> statement-breakpoint
CREATE TABLE "image_build_resources" (
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"build_id" text NOT NULL,
	"effect_id" text NOT NULL,
	"role" text NOT NULL,
	"state" jsonb DEFAULT '{"kind":"unverified"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_build_resources_provider_kind_provider_id_pk" PRIMARY KEY("provider","kind","provider_id")
);
--> statement-breakpoint
CREATE TABLE "image_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"admission" jsonb NOT NULL,
	"state" jsonb DEFAULT '{"kind":"running"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_build_effects" ADD CONSTRAINT "image_build_effects_build_id_image_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_builds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_build_resources" ADD CONSTRAINT "image_build_resources_build_id_effect_id_image_build_effects_build_id_id_fk" FOREIGN KEY ("build_id","effect_id") REFERENCES "public"."image_build_effects"("build_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION guard_image_build() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NOT COALESCE((OLD.state->>'kind' = 'running' AND NEW.state->>'kind' = 'cleaning'
      AND NEW.state->>'reason' IN ('requested','expired','failed'))
    OR (OLD.state->>'kind' = 'cleaning' AND NEW.state->>'kind' = 'cleaned'
      AND NEW.state->>'at' IS NOT NULL), false) THEN
    RAISE EXCEPTION 'Image build cleanup only moves forward' USING ERRCODE = '23514';
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
CREATE TRIGGER image_build_guard BEFORE INSERT OR UPDATE OR DELETE ON image_builds
FOR EACH ROW EXECUTE FUNCTION guard_image_build();
--> statement-breakpoint
CREATE FUNCTION guard_image_build_effect() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF command_kind = 'delete' AND build.state->>'kind'<>'cleaning' THEN
      RAISE EXCEPTION 'Image deletion requires a cleanup request' USING ERRCODE = '23514';
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
    NEW.command->>'kind' NOT IN ('delete','power_off') OR OLD.outcome->>'kind' NOT IN ('prepared','unknown') OR
    NOT EXISTS(SELECT 1 FROM image_build_effects replacement WHERE replacement.id=NEW.resolution->>'byEffectId'
      AND replacement.build_id=NEW.build_id AND replacement.id<>NEW.id AND replacement.command=NEW.command
      AND replacement.outcome->>'kind'='prepared' AND replacement.resolution->>'kind'='pending')) THEN
    RAISE EXCEPTION 'Only uncertain exact-ID effects may delegate to a prepared identical retry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_build_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON image_build_effects
FOR EACH ROW EXECUTE FUNCTION guard_image_build_effect();
--> statement-breakpoint
CREATE FUNCTION guard_image_build_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE effect image_build_effects; observed jsonb; expected_kind text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Image resource identities are retained' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM image_builds WHERE id=NEW.build_id AND state->>'kind'<>'cleaned' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resource observations require an open build' USING ERRCODE = '23514'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO effect FROM image_build_effects WHERE id=NEW.effect_id AND build_id=NEW.build_id;
    expected_kind := CASE NEW.role WHEN 'builder' THEN 'server' WHEN 'verifier' THEN 'server'
      WHEN 'builder_ip' THEN 'primary_ip' WHEN 'verifier_ip' THEN 'primary_ip'
      WHEN 'access_key' THEN 'ssh_key' WHEN 'access_firewall' THEN 'firewall' WHEN 'snapshot' THEN 'snapshot' END;
    IF NOT FOUND OR NEW.provider IS DISTINCT FROM 'hetzner' OR expected_kind IS DISTINCT FROM NEW.kind
      OR effect.command->'labels'->>'role' IS DISTINCT FROM NEW.role
      OR NEW.provider_id !~ '^[1-9][0-9]{0,19}$' OR NEW.state IS DISTINCT FROM '{"kind":"unverified"}'::jsonb THEN
      RAISE EXCEPTION 'Image resource must belong to its recorded create intent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
    RAISE EXCEPTION 'Image resource ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF OLD.state->>'kind'='absent' OR NOT COALESCE(NEW.state->>'kind' IN ('observed','absent'),false) OR NEW.state->>'at' IS NULL THEN
    RAISE EXCEPTION 'Absent image resources cannot reappear' USING ERRCODE = '23514';
  END IF;
  IF NEW.state->>'kind'='observed' THEN
    observed := NEW.state->'resource';
    IF observed->>'id' IS DISTINCT FROM NEW.provider_id OR observed->>'kind' IS DISTINCT FROM NEW.kind
      OR observed->'labels'->>'build_id' IS DISTINCT FROM NEW.build_id
      OR observed->'labels'->>'role' IS DISTINCT FROM NEW.role
      OR observed->'labels'->>'scope' IS DISTINCT FROM 'image-build'
      OR observed->'labels'->>'managed_by' IS DISTINCT FROM 'agent-cloud' THEN
      RAISE EXCEPTION 'Image observations must match recorded ownership' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_build_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON image_build_resources
FOR EACH ROW EXECUTE FUNCTION guard_image_build_resource();
--> statement-breakpoint
CREATE FUNCTION guard_provider_resource_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Both journals take the same identity lock before checking the other scope.
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-resource:' || NEW.provider || ':' || NEW.kind || ':' || NEW.provider_id, 0));
  IF TG_TABLE_NAME='image_build_resources' THEN
    IF EXISTS(SELECT 1 FROM provider_resources WHERE provider=NEW.provider AND kind=NEW.kind AND provider_id=NEW.provider_id) THEN
      RAISE EXCEPTION 'Customer provider resources cannot belong to image builds' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM image_build_resources WHERE provider=NEW.provider AND kind=NEW.kind AND provider_id=NEW.provider_id) THEN
    RAISE EXCEPTION 'Image build resources cannot belong to customer allocations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_provider_resource_scope_guard BEFORE INSERT ON image_build_resources
FOR EACH ROW EXECUTE FUNCTION guard_provider_resource_scope();
--> statement-breakpoint
CREATE TRIGGER customer_provider_resource_scope_guard BEFORE INSERT ON provider_resources
FOR EACH ROW EXECUTE FUNCTION guard_provider_resource_scope();
