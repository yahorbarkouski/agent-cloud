CREATE TABLE "allocation_images" (
	"allocation_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"build_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_images_operation_id_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
ALTER TABLE "image_builds" ADD COLUMN "run_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "image_builds" ADD COLUMN "access_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "allocation_images" ADD CONSTRAINT "allocation_images_build_id_image_publications_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."image_publications"("build_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_images" ADD CONSTRAINT "allocation_images_account_id_allocation_id_allocations_account_id_id_fk" FOREIGN KEY ("account_id","allocation_id") REFERENCES "public"."allocations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_images" ADD CONSTRAINT "allocation_images_account_id_operation_id_operations_account_id_id_fk" FOREIGN KEY ("account_id","operation_id") REFERENCES "public"."operations"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Pins have no manually mutable release flag. Durable create confirmation or fully
-- retired allocation ownership determines when a snapshot is no longer needed.
CREATE FUNCTION image_snapshot_in_use(requested_build_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM allocation_images p JOIN allocations a ON a.id=p.allocation_id AND a.account_id=p.account_id
    WHERE p.build_id=requested_build_id AND NOT (
      EXISTS(SELECT 1 FROM provider_attempts e WHERE e.operation_id=p.operation_id AND e.account_id=p.account_id
        AND e.command->>'kind'='create_guest' AND e.command->'bootstrap'->>'allocationId'=p.allocation_id
        AND e.resolution->>'kind'='confirmed' AND e.resolution->'observation'->>'kind'='server'
        AND e.resolution->'observation'->'server'->'labels'->>'allocation_id'=p.allocation_id
        AND e.resolution->'observation'->'server'->'labels'->>'operation_id'=p.operation_id)
      OR (a.retired_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM provider_attempts e WHERE e.operation_id=p.operation_id AND e.resolution->>'kind'='pending')
        AND NOT EXISTS(SELECT 1 FROM provider_resources r WHERE r.allocation_id=p.allocation_id AND r.absent_at IS NULL))
    )
  );
$$;
--> statement-breakpoint
CREATE FUNCTION guard_allocation_image() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE build image_builds; publication image_publications; allocation allocations; operation operations;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Allocation image identity is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO build FROM image_builds WHERE id=NEW.build_id FOR UPDATE;
  SELECT * INTO publication FROM image_publications WHERE build_id=NEW.build_id;
  SELECT * INTO allocation FROM allocations WHERE id=NEW.allocation_id AND account_id=NEW.account_id;
  SELECT * INTO operation FROM operations WHERE id=NEW.operation_id AND account_id=NEW.account_id;
  IF build.state->>'kind' IS DISTINCT FROM 'retained' OR publication.release IS NULL
    OR NEW.snapshot_id IS DISTINCT FROM publication.release->'payload'->'snapshot'->>'id'
    OR allocation.provider IS DISTINCT FROM 'hetzner' OR allocation.retired_at IS NOT NULL
    OR operation.kind IS DISTINCT FROM 'machine.create' OR operation.progress->>'kind' IS DISTINCT FROM 'queued'
    OR operation.machine_id IS DISTINCT FROM allocation.machine_id
    OR publication.release->'payload'->'manifest'->>'architecture' IS DISTINCT FROM allocation.offer->>'architecture'
    OR (publication.release->'payload'->'snapshot'->>'diskGb')::numeric > (allocation.offer->>'diskGb')::numeric
    OR (publication.release->'payload'->>'retainUntil')::timestamptz <= operation.created_at + interval '30 minutes'
    OR EXISTS(SELECT 1 FROM provider_attempts WHERE operation_id=NEW.operation_id)
    OR EXISTS(SELECT 1 FROM guest_bootstraps WHERE allocation_id=NEW.allocation_id) THEN
    RAISE EXCEPTION 'Allocation image must pin a compatible retained release before boot work starts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER allocation_image_guard BEFORE INSERT OR UPDATE OR DELETE ON allocation_images
FOR EACH ROW EXECUTE FUNCTION guard_allocation_image();
--> statement-breakpoint
CREATE FUNCTION guard_pinned_guest_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pin allocation_images; build image_builds;
BEGIN
  SELECT * INTO pin FROM allocation_images WHERE operation_id=NEW.operation_id;
  IF NOT FOUND OR NEW.command->>'kind' NOT IN ('create','create_guest','create_primary_ip') THEN RETURN NEW; END IF;
  SELECT * INTO build FROM image_builds WHERE id=pin.build_id FOR UPDATE;
  IF build.state->>'kind'<>'retained' OR (build.admission->'retention'->>'deleteAfter')::timestamptz <= clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM operations o JOIN allocations a ON a.id=pin.allocation_id AND a.account_id=pin.account_id
      WHERE o.id=pin.operation_id AND o.progress->>'kind' NOT IN ('succeeded','failed') AND a.retired_at IS NULL
      AND o.created_at + interval '30 minutes' > clock_timestamp())
    OR NEW.command->>'kind'='create'
    OR EXISTS(SELECT 1 FROM provider_attempts WHERE operation_id=NEW.operation_id AND command->>'kind'=NEW.command->>'kind') THEN
    RAISE EXCEPTION 'Pinned guest creation requires an active release and one initial effect' USING ERRCODE='23514';
  END IF;
  IF NEW.command->>'kind'='create_guest' AND NEW.command->'bootstrap'->>'allocationId' IS DISTINCT FROM pin.allocation_id THEN
    RAISE EXCEPTION 'Guest effect must use its pinned allocation bootstrap' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pinned_guest_effect_guard BEFORE INSERT ON provider_attempts
FOR EACH ROW EXECUTE FUNCTION guard_pinned_guest_effect();
--> statement-breakpoint
CREATE FUNCTION guard_pinned_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pin allocation_images; publication image_publications; expected jsonb; operation operations;
BEGIN
  SELECT * INTO pin FROM allocation_images WHERE allocation_id=NEW.allocation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO publication FROM image_publications WHERE build_id=pin.build_id;
  SELECT * INTO operation FROM operations WHERE id=pin.operation_id;
  expected := publication.release->'payload'->'manifest'->'trust' || jsonb_build_object(
    'providerImage',pin.snapshot_id,'architecture',publication.release->'payload'->'manifest'->'architecture',
    'version',publication.release->'payload'->'manifest'->'version',
    'manifestDigest',publication.release->'payload'->'sanitation'->'manifestDigest');
  IF NEW.account_id IS DISTINCT FROM pin.account_id OR NEW.operation_id IS DISTINCT FROM pin.operation_id
    OR NEW.spec->'image' IS DISTINCT FROM expected OR NEW.expires_at > operation.created_at + interval '30 minutes' THEN
    RAISE EXCEPTION 'Bootstrap must preserve the admitted image and boot deadline' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pinned_bootstrap_guard BEFORE INSERT ON guest_bootstraps
FOR EACH ROW EXECUTE FUNCTION guard_pinned_bootstrap();
--> statement-breakpoint
CREATE FUNCTION guard_snapshot_pins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command->>'kind'='delete' AND NEW.command->'resource'->>'kind'='snapshot' THEN
    PERFORM 1 FROM image_builds WHERE id=NEW.build_id FOR UPDATE;
    IF image_snapshot_in_use(NEW.build_id) THEN
      RAISE EXCEPTION 'Snapshot is pinned by an unsettled customer create' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER snapshot_pin_guard BEFORE INSERT ON image_build_effects
FOR EACH ROW EXECUTE FUNCTION guard_snapshot_pins();
--> statement-breakpoint
CREATE FUNCTION guard_image_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.run_requested_at IS NOT NULL OR NEW.access_removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Image scheduling and access cleanup follow admission' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.run_requested_at IS DISTINCT FROM OLD.run_requested_at AND (
    OLD.run_requested_at IS NOT NULL OR NEW.run_requested_at IS NULL OR NEW.state->>'kind'<>'running'
    OR NOT isfinite(NEW.run_requested_at) OR NEW.run_requested_at > clock_timestamp()
    OR (NEW.admission->>'deadlineAt')::timestamptz <= clock_timestamp()) THEN
    RAISE EXCEPTION 'Image run request is immutable and requires an active admission' USING ERRCODE='23514';
  END IF;
  IF NEW.access_removed_at IS DISTINCT FROM OLD.access_removed_at AND (
    OLD.access_removed_at IS NOT NULL OR NEW.access_removed_at IS NULL
    OR NOT isfinite(NEW.access_removed_at) OR NEW.access_removed_at > clock_timestamp()
    OR NEW.state->>'kind' NOT IN ('releasing','retained','cleaning','cleaned')
    OR EXISTS(SELECT 1 FROM image_build_resources WHERE build_id=NEW.id AND role<>'snapshot' AND state->>'kind'<>'absent')
    OR EXISTS(SELECT 1 FROM image_build_effects WHERE build_id=NEW.id AND resolution->>'kind'='pending')) THEN
    RAISE EXCEPTION 'Image access cleanup requires resolved temporary resource absence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER image_workflow_guard BEFORE INSERT OR UPDATE ON image_builds
FOR EACH ROW EXECUTE FUNCTION guard_image_workflow();
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
  IF (to_jsonb(NEW)-'state'-'run_requested_at'-'access_removed_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'run_requested_at'-'access_removed_at') THEN
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
CREATE FUNCTION guard_pinned_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM allocation_images WHERE allocation_id=OLD.id) AND (
    ROW(NEW.id,NEW.account_id,NEW.machine_id,NEW.provider) IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.machine_id,OLD.provider)
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)) THEN
    RAISE EXCEPTION 'Pinned allocation identity and retirement are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pinned_allocation_guard BEFORE UPDATE ON allocations
FOR EACH ROW EXECUTE FUNCTION guard_pinned_allocation();
--> statement-breakpoint
CREATE FUNCTION guard_release_access_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.release IS DISTINCT FROM OLD.release AND NOT EXISTS(
    SELECT 1 FROM image_builds WHERE id=NEW.build_id AND access_removed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Publication requires recorded local access removal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER release_access_cleanup_guard BEFORE UPDATE ON image_publications
FOR EACH ROW EXECUTE FUNCTION guard_release_access_cleanup();
