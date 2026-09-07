-- Newly observed resources must prove the original create effect as well as the build.
-- Historical observations stay immutable; the controller rechecks live labels before reuse.
CREATE OR REPLACE FUNCTION guard_image_build_resource() RETURNS trigger LANGUAGE plpgsql AS $$
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
      OR observed->'labels'->>'effect_id' IS DISTINCT FROM NEW.effect_id
      OR observed->'labels'->>'scope' IS DISTINCT FROM 'image-build'
      OR observed->'labels'->>'managed_by' IS DISTINCT FROM 'agent-cloud' THEN
      RAISE EXCEPTION 'Image observations must match recorded ownership' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

