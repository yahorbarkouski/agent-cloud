-- Bind the customer SSH capability to the admitted manifest without relaxing image equality.
CREATE OR REPLACE FUNCTION guard_image_verifier_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
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
    'version',manifest->'version','manifestDigest',build.admission->'source'->'manifestDigest') || (manifest->'trust')
    || CASE WHEN manifest->'customerSsh' = '1'::jsonb THEN jsonb_build_object('customerSsh',1) ELSE '{}'::jsonb END;
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
CREATE OR REPLACE FUNCTION guard_pinned_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pin allocation_images; publication image_publications; expected jsonb; operation operations;
BEGIN
  SELECT * INTO pin FROM allocation_images WHERE allocation_id=NEW.allocation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO publication FROM image_publications WHERE build_id=pin.build_id;
  SELECT * INTO operation FROM operations WHERE id=pin.operation_id;
  expected := publication.release->'payload'->'manifest'->'trust' || jsonb_build_object(
    'providerImage',pin.snapshot_id,'architecture',publication.release->'payload'->'manifest'->'architecture',
    'version',publication.release->'payload'->'manifest'->'version',
    'manifestDigest',publication.release->'payload'->'sanitation'->'manifestDigest')
    || CASE WHEN publication.release->'payload'->'manifest'->'customerSsh' = '1'::jsonb
      THEN jsonb_build_object('customerSsh',1) ELSE '{}'::jsonb END;
  IF NEW.account_id IS DISTINCT FROM pin.account_id OR NEW.operation_id IS DISTINCT FROM pin.operation_id
    OR NEW.spec->'image' IS DISTINCT FROM expected OR NEW.expires_at > operation.created_at + interval '30 minutes' THEN
    RAISE EXCEPTION 'Bootstrap must preserve the admitted image and boot deadline' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_image_verifier_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR checks - ARRAY['node','docker','compose','caddy','step','disk','proxy'] IS DISTINCT FROM
      (CASE WHEN manifest->'customerSsh' = '1'::jsonb
        THEN '{"customerSsh":{"kind":"ok"}}'::jsonb ELSE '{}'::jsonb END)
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
