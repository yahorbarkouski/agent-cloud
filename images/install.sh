#!/bin/sh
set -eu
[ "$(id -u)" = 0 ]
[ "$#" = 3 ]
builder_id=$2
manifest_digest=$3
[ "${#manifest_digest}" = 64 ]
case "$manifest_digest" in *[!0-9a-f]*) exit 1 ;; esac
case "$builder_id" in
  00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|????????-????-[1-8]???-[89ab]???-????????????) ;;
  *) exit 1 ;;
esac
case "$builder_id" in *[!0-9a-f-]*) exit 1 ;; esac
[ "$(dpkg --print-architecture)" = amd64 ]
. /etc/os-release
[ "$ID" = ubuntu ]
[ "$VERSION_ID" = 24.04 ]
image_directory() {
  [ ! -L "$1" ]
  [ -d "$1" ]
  [ "$(stat -c %u "$1")" = "$2" ]
  image_mode=$(stat -c %a "$1")
  [ "$((0$image_mode & 0022))" = 0 ]
}
image_directory /root 0
image_directory /home 0
[ -z "$(find /home -mindepth 1 -maxdepth 1 ! -name agent-cloud-build -print -quit)" ]
if [ -e /home/agent-cloud-build ] || [ -L /home/agent-cloud-build ]; then
  image_directory /home/agent-cloud-build "$(id -u agent-cloud-build)"
fi
for image_state in /var/lib/agent-cloud /usr/lib/agent-cloud; do
  if [ -e "$image_state" ] || [ -L "$image_state" ]; then
    image_directory "$image_state" 0
    [ -z "$(ls -A "$image_state")" ]
  fi
done
for image_account in agent-probe agent-proxy agent-customer; do
  if getent passwd "$image_account" >/dev/null; then exit 1; fi
  [ ! -e "/var/lib/$image_account" ]
  [ ! -L "/var/lib/$image_account" ]
done
image_input=$(realpath "$1")
[ -f "$image_input/image.json" ]
(cd "$image_input" && sha256sum --check SHA256SUMS)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openssh-server cloud-init sudo ca-certificates curl git jq xz-utils iptables
apt-get install -y -qq "$image_input"/artifacts/*.deb
tar -xJf "$image_input/artifacts/node.tar.xz" -C /usr/local --strip-components=1
/usr/local/bin/node "$image_input/guestctl.mjs" verify-inputs "$image_input" "$manifest_digest" --json
image_unpack=$(mktemp -d)
trap 'rm -rf "$image_unpack"' EXIT
tar -xzf "$image_input/artifacts/step.tar.gz" -C "$image_unpack" step_0.30.6/bin/step
install -m 0755 "$image_unpack/step_0.30.6/bin/step" /usr/local/bin/step
tar -xzf "$image_input/artifacts/caddy.tar.gz" -C "$image_unpack" caddy
install -m 0755 "$image_unpack/caddy" /usr/local/bin/caddy
install -d -m 0755 /usr/lib/agent-cloud /var/lib/agent-cloud
install -m 0755 "$image_input/guestctl.mjs" /usr/lib/agent-cloud/guestctl.mjs
install -m 0644 "$image_input/image.json" /usr/lib/agent-cloud/image.json
install -m 0644 "$image_input/image-inputs.json" /usr/lib/agent-cloud/image-inputs.json
install -m 0644 "$image_input/sshd_config" /usr/lib/agent-cloud/sshd_config
jq -r .trust.sshUserCa "$image_input/image.json" > /usr/lib/agent-cloud/ssh_user_ca.pub
jq -r .trust.tlsRoot "$image_input/image.json" > /usr/lib/agent-cloud/root_ca.crt
chmod 0644 /usr/lib/agent-cloud/ssh_user_ca.pub /usr/lib/agent-cloud/root_ca.crt
cat > /usr/local/bin/guestctl <<'COMMAND'
#!/bin/sh
case "${1:-}" in
  compose) exec /usr/bin/flock --wait 5 /run/agent-cloud-compose-admission.lock /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
  compose-work) exec /usr/bin/flock --nonblock /run/agent-cloud-compose-work.lock /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
  run) exec /usr/bin/flock --wait 5 /run/agent-cloud-runs.lock /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
  run-work)
    [ "${#2}" -eq 36 ] || exit 1
    case "$2" in *[!a-f0-9-]*) exit 1 ;; esac
    exec /usr/bin/flock --nonblock "/run/agent-cloud-run-$2.lock" /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
  reference) exec /usr/bin/flock --wait 5 /run/agent-cloud-reference-admission.lock /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
  reference-work) exec /usr/bin/flock --nonblock /run/agent-cloud-reference-work.lock /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
  enroll|renew|prepare-image) exec /usr/bin/flock --nonblock /run/agent-cloud-guest.lock /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@" ;;
esac
exec /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@"
COMMAND
chmod 0755 /usr/local/bin/guestctl
if ! id agent-probe >/dev/null 2>&1; then useradd --system --create-home --home-dir /var/lib/agent-probe --shell /bin/sh agent-probe; fi
if ! id agent-deploy >/dev/null 2>&1; then useradd --system --create-home --home-dir /var/lib/agent-deploy --shell /bin/sh agent-deploy; fi
useradd --system --create-home --home-dir /var/lib/agent-customer --shell /bin/sh agent-customer
if ! id agent-proxy >/dev/null 2>&1; then useradd --system --no-create-home --home-dir /var/lib/agent-cloud-proxy --shell /usr/sbin/nologin agent-proxy; fi
install -m 0440 "$image_input/guest-inspect.sudoers" /etc/sudoers.d/agent-cloud-inspect
visudo -cf /etc/sudoers.d/agent-cloud-inspect
install -m 0440 "$image_input/guest-customer.sudoers" /etc/sudoers.d/agent-cloud-customer
visudo -cf /etc/sudoers.d/agent-cloud-customer
install -m 0644 "$image_input"/systemd/*.service "$image_input"/systemd/*.timer /etc/systemd/system/
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json <<'DOCKER'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true,"userland-proxy":false}
DOCKER
systemctl daemon-reload
cat > /etc/systemd/system/agent-cloud-compose.service <<'COMPOSE_SERVICE'
[Unit]
Description=Apply queued customer Compose releases
After=docker.service network-online.target
Requires=docker.service
ConditionPathExists=/var/lib/agent-cloud/compose
[Service]
Type=oneshot
ExecStart=/usr/local/bin/guestctl compose-work --json
TimeoutStartSec=1800
TimeoutStopSec=10
KillMode=control-group
UMask=0077
StandardOutput=null
StandardError=null
COMPOSE_SERVICE
cat > /etc/systemd/system/agent-cloud-compose.timer <<'COMPOSE_TIMER'
[Unit]
Description=Recover lost Compose wakeups and interrupted deployment records
[Timer]
OnBootSec=15s
OnUnitInactiveSec=15s
AccuracySec=1s
Unit=agent-cloud-compose.service
[Install]
WantedBy=timers.target
COMPOSE_TIMER
systemctl enable agent-cloud-compose.timer
cat > /etc/systemd/system/agent-cloud-run@.service <<'RUN_SERVICE'
[Unit]
Description=Durable customer command %i
After=network-online.target
[Service]
Type=exec
ExecStart=/usr/local/bin/guestctl run-work %i --json
Restart=no
KillMode=control-group
TimeoutStopSec=5
RuntimeMaxSec=3610
TasksMax=128
MemoryMax=512M
CPUQuota=100%
UMask=0077
StandardOutput=null
StandardError=null
RUN_SERVICE
cat > /etc/systemd/system/agent-cloud-reference.service <<'REFERENCE'
[Unit]
Description=Apply the internal reference application
After=docker.service network-online.target
Requires=docker.service
ConditionPathExists=/var/lib/agent-cloud/reference/state.json
[Service]
Type=oneshot
ExecStart=/usr/local/bin/guestctl reference-work --json
TimeoutStartSec=900
UMask=0077
StandardOutput=null
StandardError=journal
[Install]
WantedBy=multi-user.target
REFERENCE
cat > /etc/systemd/system/agent-cloud-reference.timer <<'REFERENCE_TIMER'
[Unit]
Description=Resume a recorded reference deployment after a lost wakeup
[Timer]
OnBootSec=15s
OnUnitInactiveSec=15s
AccuracySec=1s
Unit=agent-cloud-reference.service
[Install]
WantedBy=timers.target
REFERENCE_TIMER
systemctl daemon-reload
systemctl enable agent-cloud-reference.service agent-cloud-reference.timer
systemctl enable docker.service agent-cloud-enroll.service agent-cloud-proxy.service agent-cloud-renew.timer
systemctl restart docker.service
[ "$(/usr/local/bin/node --version)" = "v$(jq -r .components.node "$image_input/image.json")" ]
[ "$(docker version --format '{{.Server.Version}}')" = "$(jq -r .components.docker "$image_input/image.json")" ]
[ "$(docker compose version --short)" = "$(jq -r .components.compose "$image_input/image.json")" ]
/usr/local/bin/caddy version
/usr/local/bin/step version
dpkg-query --show > /usr/lib/agent-cloud/os-packages.txt
/usr/local/bin/node --input-type=module -e '
  import { readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
  import { createHash } from "node:crypto";
  const manifest = JSON.parse(readFileSync("/usr/lib/agent-cloud/image.json", "utf8"));
  const manifestDigest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const homes = ["/root", "/var/lib/agent-probe", "/var/lib/agent-customer", ...readdirSync("/home").map(name => "/home/" + name)].map(path => {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) throw new Error("Builder home is not a directory");
    return {path, uid:stat.uid};
  });
  writeFileSync("/usr/lib/agent-cloud/image-build.json", JSON.stringify({
    kind:"builder", builderId:process.argv[1],
    machineId:readFileSync("/etc/machine-id", "utf8").trim(), manifestDigest, homes,
  }) + "\n", {mode:0o600, flag:"wx"});
' "$builder_id"
printf 'Guest image tools installed; builder SSH remains available until sanitation.\n'
