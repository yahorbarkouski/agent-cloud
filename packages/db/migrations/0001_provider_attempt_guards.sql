CREATE FUNCTION guard_provider_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider attempts are retained for reconciliation and audit' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome IS DISTINCT FROM '{"kind":"prepared"}'::jsonb THEN
      RAISE EXCEPTION 'Provider attempts must begin prepared' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'outcome') IS DISTINCT FROM (to_jsonb(OLD) - 'outcome') THEN
    RAISE EXCEPTION 'Provider attempt identity and command are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome IS DISTINCT FROM '{"kind":"prepared"}'::jsonb
     OR COALESCE(NEW.outcome->>'kind', '') NOT IN ('accepted', 'completed', 'rejected', 'unknown') THEN
    RAISE EXCEPTION 'Provider attempt outcome can be recorded only once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_attempt_guard BEFORE INSERT OR UPDATE OR DELETE
ON provider_attempts FOR EACH ROW EXECUTE FUNCTION guard_provider_attempt();
