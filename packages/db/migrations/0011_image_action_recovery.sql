-- Missing action records may require another exact-ID stop/delete. Keep the accepted
-- receipt immutable; the controller first observes the owned target and action absence.
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
    NEW.command->>'kind' NOT IN ('delete','power_off') OR OLD.outcome->>'kind' NOT IN ('prepared','unknown','accepted') OR
    NOT EXISTS(SELECT 1 FROM image_build_effects replacement WHERE replacement.id=NEW.resolution->>'byEffectId'
      AND replacement.build_id=NEW.build_id AND replacement.id<>NEW.id AND replacement.command=NEW.command
      AND replacement.outcome->>'kind'='prepared' AND replacement.resolution->>'kind'='pending')) THEN
    RAISE EXCEPTION 'Only uncertain exact-ID effects may delegate to a prepared identical retry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

