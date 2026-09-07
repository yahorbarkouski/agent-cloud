# Durable commands

An invocation runs as a systemd service on its customer's VM. The CLI uses the existing authenticated SSH path to submit a structured request, then exits. Guest records retain the request digest, start receipt, result and bounded output. This capability currently uses CLI → access API/gateway → guestctl; dedicated run HTTP endpoints remain unfinished.

## Customer workflow

Create an owner-only JSON request file, for example:

```json
{
  "argv": ["/usr/local/bin/node", "./migrate.js"],
  "cwd": "/srv/example",
  "env": {},
  "stdin": "",
  "timeoutSeconds": 300,
  "maximumOutputBytes": 262144
}
```

The executable and working directory must be absolute paths. Arguments are an array and are never concatenated into a shell command. Shell interpretation requires explicitly requesting `/bin/sh` with `-c`. Environment values, stdin and output may contain secrets, so requests are owner-only on the client and root-only on the guest. They do not enter platform service logs.

```sh
acld run submit vm_... --id <stable-UUIDv4> --request ./run.json
acld run inspect vm_... <same-UUID>
acld run logs vm_... <same-UUID> --after 0
acld run cancel vm_... <same-UUID>
```

The caller needs `machine:exec` in that machine's project. Invocation IDs are lowercase UUIDv4 values. Retain one ID and the identical request through lost replies. Changed intent under an existing ID returns `idempotency_conflict`. Never allocate a replacement ID to work around an uncertain outcome.

Replies contain `run.state`. `queued` and `running` are nonterminal; `exited` includes the process exit code; `terminated` identifies cancellation, timeout, output limit, interruption or spawn failure. The CLI's successful JSON reply means the query succeeded; inspect the recorded state/code to decide whether the command succeeded. `logs` returns stdout/stderr entries and `nextCursor`. Continue with that cursor until `complete` is true. Output is UTF-8 text; use file transfer for binary artifacts.

Closing the CLI or revoking its access does not undo an admitted invocation. Cancellation is a separate explicit command. Services and Compose applications should use their own lifecycle; background child processes of a run are reaped with its systemd unit.

## Crash, cancellation and ownership

`guestctl run` takes the existing Linux `flock` around admission, inspection and cancellation. The worker holds a separate per-invocation lock throughout execution. A systemd unit has one fixed UUID instance name; request fields cannot choose another unit or a lock pathname.

Admission syncs the parent of the initial runs directory, the invocation directory entry and its request before asking systemd to start. The worker persists and syncs `started.json` before spawning the child. A repeated worker that finds that receipt never runs the command again. A lost outcome is `interrupted`, including a crash between receipt persistence and spawn. This deliberately avoids guessing whether a migration ran.

Units do not restart automatically or enable themselves at boot. Inspection compares the saved boot ID to the current guest boot and records an explicit interruption. The same invocation cannot replay after reboot. An unstarted invocation on the same boot can recover a lost systemd start response by resubmitting the same request.

Cancellation records intent before stopping the exact unit. The worker persists its outcome before exiting. If the worker disappeared, inspection derives and saves its terminal outcome only after the unit is inactive or its original boot ended. Existing final results are retained. A command that completed before cancellation remains completed.

Timeout/output-limit handling terminates the child process group, escalates after3 seconds and closes inherited output pipes so detached helpers cannot hold the worker open. Systemd's `KillMode=control-group` then reaps remaining descendants. The unit also has a3610-second outer deadline and5-second stop deadline.

Records live in `/var/lib/agent-cloud/runs/<id>` with root-only permissions. Root-equivalent customers can change their VM, including these records. They are diagnostic evidence for that customer, not authoritative billing or fleet security records. Disk loss and restoring an earlier disk image require the separate recovery workflow; these receipts do not provide cross-disk transactional execution.

## Bounds and implementation

Requests are at most256KiB. Timeout is1–3600 seconds; saved JSONL output is1KiB–1MiB, default256KiB. Replies are limited by record count and serialized bytes. A crash may leave an incomplete final log record, which inspection excludes instead of inventing data.

The default unit uses512MiB memory, one CPU worth of quota and128 tasks. Admission limits active managed runs to4 and retained invocation directories to1024, and requires256MiB free disk. These protect the normal managed command path; root access and Docker-daemon workloads are not a sandbox. Invocation receipts are not automatically pruned because deleting them would erase duplicate-execution protection. Retention policy and configurable guest limits remain follow-up work within resource management.

Contracts own request/result schemas; `packages/guestctl/src/runs.ts` owns guest execution and records; `apps/cli/src/runs.ts` owns CLI delivery. The unit and lock wrapper are signed image installation inputs. Existing images need the current guest bundle to support these commands.

`tests/guest-runs.test.ts` checks real child execution, lost start responses, duplicate suppression, uncertain starts, reboot state, cancellation, timeout, detached output holders and limits. `pnpm smoke:runs` exercises the actual CLI/API/gateway/SSH/systemd path on one owned local Ubuntu VM, including a real reboot. Current verification evidence and active fixture ownership belong in `docs/CONTEXT.md`.
