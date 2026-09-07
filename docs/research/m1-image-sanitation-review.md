# M1 image sanitation review

Reviewer model: `gpt-5.6-sol`. I reviewed the final uncommitted sanitation implementation, installer, enrollment boundary, image and guest smokes, architecture, verification JSON, context, progress, and all eight `M1-sanitation` decision rows. I did not operate a VM or rebuild shared artifacts. No transcript directory was supplied.

## Assessment

I found no remaining correctness or security blocker within the documented exclusive fresh-builder scope.

Preparation never starts Docker. It inventories containers, images, volumes, build cache, custom networks, and swarm state whenever the daemon is active. A stopped daemon refuses the initial transition; an inactive daemon is accepted only for a durable `preparing` retry. If Docker restarted during recovery, its inventory is checked again before deletion. Arbitrary concurrent root mutation remains outside the stated contract.

The durable state machine is coherent. `builder` requires the original machine ID; every later preparation phase accepts only that ID or `uninitialized`. A rebooted or cloned `preparing` record with a fresh ID refuses before cleanup. Sanitized enrollment requires the matching manifest and a fresh machine ID before key generation. Record consumption follows durable allocation metadata and keys, and missing-record replay requires that allocation. The installed wrapper serializes the real sanitation and enrollment entry points.

The installer establishes destructive scope before apt: directory type, symlink status, owner and write permissions are checked; `/home` is limited to the expected builder home; and pre-existing managed accounts and homes refuse. Its UUID pattern matches the tested Zod 4.5.4 acceptance set. The caller UUID binds the outside ownership record, installed record, sanitation receipt, stopped source, and clone validation.

Log cleanup switches journald through an ephemeral `/run` drop-in to volatile storage, stops loaded rsyslog, clears `/var/log`, and requires it to remain empty before publishing `sanitized`. The postreceipt logger and journal sync check covers the common recreation path. The `/run` override disappears on clone boot, restoring normal logging.

## Final local evidence

Full check and formatting session 42939 passed 121 tests across 18 files, typecheck, lint, and format. Native enrollment session 9311 passed guest lost-response/replay with Smallstep and native OpenSSH/TLS; provider observations remained simulated.

Fresh uninterrupted smoke session 73319 exercised the final source and passed:

- installer refusal before apt for state/home symlinks, a non-directory state path, and wrong home owner;
- raw-builder enrollment refusal before allocation keys, plus allocation, volume, custom-network, unexpected-home, and state-symlink preservation;
- a stopped restart-policy container that did not execute during refusal, with manual restart as a positive control;
- a real interruption after durable `preparing` and machine-ID reset, with access preserved, newly added volume refusal after Docker restart, and successful inactive retry;
- sanitized replay, volatile logging, changed-machine rejection, two full clone enrollments, restricted SSH, runtime failure/recovery, reboot, and bootstrap cleanup.

The exact public results are recorded in `docs/research/m1-image-sanitation-verification.json` for image `dev-73aed28a0aa7`, manifest digest `d0bf1a02b1751a9ed8b49be47f2c9cbd0683248141d137b8b55bca0055e76f33`. The two clones have different allocation IDs, 32-hex machine IDs, SSH public-key SHA-256 values, and TLS SPKI SHA-256 values. Each token scan covered 125 regular files, respectively 592,717 and 591,111 bytes, with zero matches. After exit, local VM inventory was empty and the builder, guest, and refusal ownership records were absent. The run created no cloud resources.

Session 52823 is correctly excluded from positive evidence. An operator `orb run` used for diagnosis started its deliberately stopped source, so the child refused and no positive clone was created. The builder and unused intent were removed. `AGENTS.md` now forbids VM diagnostics while a smoke is active; 73319 ran uninterrupted.

## Trail audit and limits

The eight sanitation rows preserve the actual sequence. Rows 60–62 retain the first implementation and incomplete diagnostic history; row 63 records the earlier 16252 two-clone proof; rows 64–65 record the later installer/log/retry work and its systemd start-limit fixture failure; row 66 records the operator-invalidated 52823 run; row 67 points to the final verification artifact and accurately summarizes 73319. The references, rationales, failures, cleanup claims, and evidence boundaries agree with the code and supplied results.

`docs/CONTEXT.md`, `docs/PROGRESS.md`, and the architecture's local-verification section now record 73319 as complete, retain the earlier invalidated runs, and point to the exact verification artifact. Their status and limitations agree with the decision trail.

OrbStack starts each clone before the NoCloud allocation seed is staged, then restarts it for enrollment. This proves clone identity separation and real cloud-init/systemd enrollment after staging, but not allocation metadata on initial power-on. Local evidence does not establish Hetzner snapshot consistency, snapshot publication/reconciliation, retention, pricing, full input provenance, certificate renewal, provider cleanup, or production worker activation. These remain explicit M1 gates.
