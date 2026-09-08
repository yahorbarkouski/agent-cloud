#!/bin/bash
set -euo pipefail
umask 077
config=/run/agent-cloud-wal/pgbackrest.conf
if [[ ! -f "$config" || -L "$config" ]] \
  || [[ "$(stat -c %a "$config")" != 600 ]] \
  || [[ "$(stat -c %u "$config")" != 1000 ]] \
  || (( $(stat -c %s "$config") > 16384 )); then
  echo 'A private control WAL configuration is required.' >&2
  exit 1
fi
install -o postgres -g postgres -m 0600 "$config" /etc/pgbackrest/pgbackrest.conf
# Compare a private copy with the same template used by the TypeScript initializer.
# The secret stays in file/pipe memory, never a shell argument or diagnostic.
if ! awk '
  FILENAME == ARGV[1] {
    if ($0 ~ /^repo1-cipher-pass=/) { secret=$0; sub(/^repo1-cipher-pass=/, "", secret); count++ }
    next
  }
  { if (count != 1 || length(secret) != 64 || secret !~ /^[a-f0-9]+$/) exit 1
    gsub(/@CIPHER_PASS@/, secret); print }
' /etc/pgbackrest/pgbackrest.conf /usr/local/share/control-pgbackrest.template \
  | cmp --silent - /etc/pgbackrest/pgbackrest.conf; then
  echo 'Control WAL configuration is invalid; recover its matching private copy.' >&2
  exit 1
fi
if [[ "${1:-}" == restore ]]; then
  if [[ $# != 3 || ! "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$ || ! "$3" =~ ^[0-9]{8}-[0-9]{6}F$ ]]; then
    echo 'Restore requires a UTC target and an explicit full-backup label.' >&2
    exit 1
  fi
  # PostgreSQL's recovery_target_time GUC rejects ISO T/Z notation even though SQL
  # timestamps accept it. Validate the date and preserve microseconds in UTC.
  target=$(date --utc --date="$2" '+%Y-%m-%d %H:%M:%S.%6N+00')
  # Directory flock is shared even by distinct containers mounting the same target.
  # It creates no file inside PGDATA. Keep this parent alive to hold it until the child exits.
  exec {restore_lock}</var/lib/postgresql/data
  if ! flock --exclusive --nonblock "$restore_lock"; then
    echo 'Another restore owns this PostgreSQL data directory.' >&2
    exit 1
  fi
  # No delta restore or automatic cleanup: the target must be a fresh owned volume.
  if [[ -L /var/lib/postgresql/data ]] || [[ -n "$(find /var/lib/postgresql/data -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo 'Restore requires an empty PostgreSQL data directory.' >&2
    exit 1
  fi
  chown postgres:postgres /var/lib/postgresql/data
  chmod 0700 /var/lib/postgresql/data
  gosu postgres pgbackrest --stanza=agentcloud --type=time --target="$target" --set="$3" --target-action=promote restore &
  restore_pid=$!
  cancel_restore() {
    trap '' TERM INT
    kill -TERM "$restore_pid" 2>/dev/null || true
    wait "$restore_pid" || true
    exit 130
  }
  trap cancel_restore TERM INT
  wait "$restore_pid"
  exit 0
fi
exec docker-entrypoint.sh "$@"
