# Protected backups and isolated restore

The implemented path captures one supported Compose application with PostgreSQL 17 and explicitly declared regular files. The control worker encrypts it outside the guest and stores one exact, retained S3 object version. Restore provisions a new machine through the existing budget and ownership checks. It never overwrites the source machine or changes a route.

The manual capture/isolated-restore path is native verified. The customer CLI/API/worker scenario in `.local/backup-native-5.log` restored count `1` and identical declared-file contents on a second Ubuntu VM after wrapping-key rotation. It verified quarantine, idempotent admission, unchanged source, zero reservations after destruction and backup availability after source destruction. Both exact-owned VMs were removed. API/worker recovery checks and real local MinIO protection checks also pass. Hetzner Object Storage has not been verified or provisioned. Network promotion and existing-hostname movement passed the combined native scenario in `.local/restore-cutover-native-4.log`: source writes fenced, count `1` restored, the same public HTTPS hostname moved, count `2` written/read, route removed, both allocations destroyed with zero reservations, and both exact-owned physical VMs deleted. This is local MinIO/native VM proof, not Hetzner provider proof. Daily capture is implemented through the existing worker. Its real cron/native scenario passed `.local/backup-schedules-native-1.log`: the CLI exited, the minute cron admitted capture, the encrypted backup restored on a separate VM, public HTTPS cutover preserved and accepted data, and both VMs were removed. The 24-hour admission policy and outage/revocation/quota cases are database-time integration checks; this proof did not wait a real day. Automatic retention pruning, provider automated backups and a customer purge command remain pending.

## Customer commands

Authenticate normally and select a credential with `backup:create`/`backup:read` for the source project. Obtain the exact successful release from `acld compose inspect <machine> <app>`.

```sh
acld backup capture vm_... sample --id <capture-uuid> --release <release-uuid> \
  --service database --database reference --user reference --files uploads/receipt.txt
acld backup wait <capture-uuid>
acld backup list vm_...
acld backup inspect <capture-uuid>

acld backup restore <capture-uuid> recovered --id <restore-uuid> \
  --name recovered-app --size small --region nbg1
acld backup restore-wait <restore-uuid>
acld backup restore-inspect <restore-uuid>
```

Generate and retain each UUID before submission. A disconnected CLI does not stop worker execution. Inspect or wait with that UUID after a lost response; replaying the identical admission returns the same record. Different input with the same UUID conflicts. Restore also requires `backup:restore` and `machine:create` within the original project's size, region and spending policy. Its result includes the new machine and provisioning operation IDs, including when recovery fails and cleanup is still necessary.

The API exposes `POST/GET /v1/machines/:machineId/backups`, `GET /v1/backups/:id`, and `POST/GET /v1/restores[/:id]`. Mutation bodies use `backupCaptureRequestSchema` and `restoreRequestSchema`. No object-store credentials, wrapping keys, ciphertext paths or private encryption envelopes appear in these responses.

## Daily capture

Configure daily capture using the same explicit recipe flags as a manual capture:

```sh
acld backup schedule <machine> sample --id <schedule-uuid> --release <release-uuid> \
  --service database --database reference --user reference --files uploads/receipt.txt
acld backup schedule-inspect <schedule-uuid>
acld backup schedule-list <machine>
acld backup schedule-disable <schedule-uuid>
```

The CLI can exit after configuration. The worker's minute reconciliation admits the first capture when next available, then one capture every 24 hours. After an outage it admits one current capture; it does not replay missed daily jobs. The API returns the last attempt, its live backup state, the latest successful backup and the next due time. Inspect the backup's actual timestamp and retention deadline. A failed capture or storage refusal leaves prior recovery points intact; no pruning is currently automatic.

A schedule pins both the original VM allocation and the exact recipe release. After deploying a new release, disable the old schedule and create a new schedule UUID with the successful release ID. Reusing an existing schedule UUID with different inputs conflicts. A disabled schedule stays disabled on replay. Source replacement never silently transfers a schedule. Only one enabled schedule per machine/app is permitted, with ten active schedules and thirty new schedule admissions per account per hour.

The admitting grant must remain valid with `backup:create` for the source project. Use an explicitly authorized grant whose expiry covers the intended protection period. Expiry/revocation disables the schedule on its next attempted admission. The worker rechecks current ancestry and quotas under the existing account/capacity locks. Disabling prevents future admissions; a capture already admitted remains a separate durable operation, and its effect checks still honor revocation. No guest receives an automation token or storage credentials.

Storage reservations and capture limits are identical to manual capture. An exhausted allowance refuses the new daily admission and reports it without deleting a previous backup. The service does not promise continuous protection when authority, storage or the pinned source recipe is unavailable. Check `lastAttempt` and `lastSuccessfulBackup`; their timestamps expose degraded protection.

The API provides `POST/GET /v1/machines/:machineId/backup-schedules` and `GET/DELETE /v1/backup-schedules/:id`. Schedule creation and first capture are separate admissions. The schedule, each run's backup ID and next due time survive worker restarts in PostgreSQL.

## Capture and recovery guarantees

- Capture requires the exact current successful Compose release. PostgreSQL tools and server must be version 17. The guest collects a custom-format database dump, cluster roles/globals, the source bundle, normalized Compose configuration and declared files. The database dump is consistent; files are best effort and are not transactionally coordinated with the database. Other databases, undeclared files and other named volumes are excluded.
- The dedicated `agent-backup` SSH user accepts a fixed forced dispatcher, without a shell or forwarding. Five minute certificates bind it to the exact allocation. Separate account/machine checks, provider observations and SSH host CA verification precede each connection. Command duration is bounded independently of the handshake certificate's expiry. Probe credentials remain restricted to identity/inspection.
- The guest serializes capture/restore with Compose admission and work. Durable guest intent prevents replay after an interrupted command. Removed capture staging leaves a tombstone, so an old capture UUID cannot silently capture different bytes.
- One database advisory lock serializes backup/restore scratch across worker processes. Capture size is capped at 1 GiB, with a configurable lower limit, and command time at 900 seconds. Admission reserves the maximum capture size against account and global storage allowances. The default account ceiling is 20 GiB; the operator must explicitly configure the global ceiling. Captures are limited to ten admissions per account per hour. Stored captures reserve their actual ciphertext size; unresolved uploads keep their full reservation.
- Encryption uses a random AES-256-GCM data key per backup and a separate versioned AES-256-GCM wrapping key. Both authenticate the account, backup UUID and manifest hash. The object store receives only ciphertext. Rotating the current wrapping key retains older keys for existing backups. Keep an offline copy of the keyring and protected control database; losing either can make otherwise intact objects unrecoverable.
- The worker records the exact upload intent before its single PUT. An ambiguous response is resolved through version listing and exact-version metadata, retention and byte verification. An absent object or a delete marker never authorizes repeating an uncertain PUT. Automatic recovery is bounded; blocked records retain their object intent and reservation for operator recovery.
- `captured` means encrypted bytes were read back and verified with their retained object version. `restore_verified` means an isolated guest imported the database and reported healthy services. Application-specific correctness still needs an application check. These states make no PITR or zero-data-loss claim.

## Restore isolation

Restore admission and ordinary VM admission share one transaction, so a retry cannot reserve a second target. Customer SSH and route publication remain disabled for the target until successful restore verification. Failed and unresolved targets remain owned and billable until explicitly destroyed.

The worker downloads the exact object version, verifies its bytes and retention record, then authenticates the entire encrypted archive into a private scratch file before sending any plaintext to the target. Untrusted archives and SQL are never unpacked or executed on the control host. Capture and restore callbacks persist submission immediately before bytes can enter SSH; known failures preparing credentials or local transport files remain retryable. After possible submission, only the guest's durable result is inspected; SQL is never blindly rerun.

The target accepts a bounded archive of fixed regular-file entries, rejecting links, duplicate entries and path traversal. Its Compose configuration uses a new project namespace and new local volumes. External volumes/networks, privileged services, devices, sockets and host namespace sharing are rejected. Published ports are confined to loopback. Declared files live under `/var/lib/agent-customer/restores/<restore-uuid>/`, and captured customer bind mounts are rebased there. PostgreSQL starts alone, imports roles and data, then the full application starts and its service health is checked. Source files, source volumes and public routes are unchanged.

The internal restore network has no active host-port mappings. Inspect a restored service's private container address through authenticated SSH and check the application from that VM. Docker permits host access to containers on ordinary internal bridge networks. See [Docker's network modes](https://docs.docker.com/engine/network/port-publishing/).

Within the customer's cutover authorization, fence source writes and close its old application/database connections before activating the replacement. Stopping the source Compose application is sufficient for the reference app. Then promote the verified target and move the retained hostname:

```sh
acld compose promote <new-machine> recovered --release <promotion-uuid> \
  --expected-release <restore-uuid>
acld compose wait <new-machine> recovered
acld route move <existing-hostname> <new-machine> --port 30080 \
  --expected-version <current-route-version> --key <move-uuid>
acld route wait <existing-hostname>
```

Promotion creates a new durable Compose release, verifies the current isolated release and its pinned images, and recreates containers on a distinct ordinary bridge network. It preserves volumes, captured file binds, image IDs and loopback-only published ports. It enables egress; a published application port must already exist in the captured configuration. It does not create a public route. An uncertain promotion is inspected/recovered through ordinary Compose release commands, without minting a replacement ID blindly.

Route movement requires current authority for both the old and target projects, an existing account-owned hostname and its current version. Generated hostnames survive replacement machines. New or foreign names cannot be claimed through movement. Inspect the application over its public HTTPS hostname after cutover, including an application-specific write/read check. A route acknowledgement alone does not prove application health.

Writes after the selected backup are absent from the restored copy unless separately transferred. Once the replacement accepts writes, switching back can lose those new writes. Destroying either VM remains a separate data-loss-authorized operation; protected off-machine backup records remain accessible after source destruction.

## Operator configuration

Set `ACLD_BACKUP_CONFIG` to an owner-only JSON file on customer API/worker hosts:

```json
{
  "version": 1,
  "directory": "/var/lib/agent-cloud/backups",
  "store": {
    "endpoint": "https://fsn1.your-objectstorage.com",
    "region": "fsn1",
    "bucket": "your-protected-backups",
    "keyPrefix": "protected",
    "maxBytes": 1073741824,
    "requestTimeoutMs": 120000
  },
  "writerCredentialsFile": "/run/secrets/backup-writer.json",
  "readerCredentialsFile": "/run/secrets/backup-reader.json",
  "keyringFile": "/run/secrets/backup-keyring.json",
  "retentionDays": 7,
  "retentionMode": "COMPLIANCE",
  "limits": { "maxBytes": 1073741824, "timeoutSeconds": 900 },
  "maxAccountBytes": 21474836480,
  "maxGlobalBytes": 42949672960
}
```

Each credential file contains `{ "accessKeyId": "...", "secretAccessKey": "..." }` and must use a different storage identity. The keyring shape is `{ "current": "v1", "keys": { "v1": "<base64-encoded random 32-byte key>" } }`. Provision and preserve keys independently from the bucket. Runtime reads secrets lazily so a missing storage credential does not disable ordinary machine cleanup.

The bucket must have versioning and Object Lock enabled. On Hetzner, Object Lock must be selected when creating the bucket. Use a separate storage project/credentials and preferably another EU location. Ordinary writer access needs `PutObject`, `PutObjectRetention`, `GetObjectVersion`, `GetObjectRetention`, `ListBucketVersions`, `GetBucketVersioning` and `GetBucketObjectLockConfiguration` within the configured bucket/prefix. The reader needs the read subset, without listing, writing, deleting or bypass permissions. Neither runtime API implements deletion or retention bypass. Verify actual provider enforcement before claiming protection; local MinIO evidence is insufficient for that claim.

Hetzner keys have broad access to buckets in their own project by default. Put runtime writer/reader keys in a different project from the protected bucket and its administrator key. Grant each exact runtime principal only its required actions through the bucket policy. Hetzner identifies a key as `arn:aws:iam:::user/p<credential-project-id>:<access-key>`. Keep the bucket administrator key out of the API and worker. Separate key files alone do not restrict provider permissions. See [Hetzner's per-key access policy](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/#how-do-i-restrict-access-per-key).

An existing exact version remains readable after its promised retention ends. This does not claim continuing deletion protection. Seven days of retention is a configured protection interval, not evidence that daily backups are already scheduled.

## Verification and failure lessons

`pnpm smoke:backup-store` uses a pinned, network-isolated local MinIO fixture to verify exact-version reads, both retention modes, denied protected deletion and separate writer/reader permissions. It creates no provider bucket. `pnpm smoke:backups` exercises customer CLI/API/worker, source Compose/PostgreSQL, encrypted local S3 storage, wrapping-key rotation and a second native Ubuntu guest. These VM fixtures run sequentially with other VM smokes and retain exact ownership records after a failure.

The first native run exposed an image sanitation allowlist that omitted `/var/lib/agent-backup`, although the installer recorded that new service home. Sanitation must cover every newly installed service home before image publication; the source schema was corrected and a new immutable guest bundle built. No guest or published bundle is patched in place to bypass this check.

Primary implementation: contracts in `packages/contracts/src/backups.ts`; durable admission in `apps/control/src/backups.ts`; phases/encryption/runtime beside it; protected S3 transport in `packages/backup-store`; capture/archive/restore helpers in `packages/guestctl`; purpose-specific SSH transport in `packages/remote/src/backups.ts`; migration `0023_protected_backups.sql`.
