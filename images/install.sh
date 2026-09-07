#!/bin/sh
set -eu
[ "$(id -u)" = 0 ]
[ "$#" = 1 ]
[ "$(dpkg --print-architecture)" = amd64 ]
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ]
image_input=$(realpath "$1")
[ -f "$image_input/image.json" ]
(cd "$image_input" && sha256sum --check SHA256SUMS)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openssh-server cloud-init sudo ca-certificates curl git jq xz-utils iptables
apt-get install -y -qq "$image_input"/artifacts/*.deb
tar -xJf "$image_input/artifacts/node.tar.xz" -C /usr/local --strip-components=1
image_unpack=$(mktemp -d)
trap 'rm -rf "$image_unpack"' EXIT
tar -xzf "$image_input/artifacts/step.tar.gz" -C "$image_unpack" step_0.30.6/bin/step
install -m 0755 "$image_unpack/step_0.30.6/bin/step" /usr/local/bin/step
tar -xzf "$image_input/artifacts/caddy.tar.gz" -C "$image_unpack" caddy
install -m 0755 "$image_unpack/caddy" /usr/local/bin/caddy
install -d -m 0755 /usr/lib/agent-cloud /var/lib/agent-cloud
install -m 0755 "$image_input/guestctl.mjs" /usr/lib/agent-cloud/guestctl.mjs
install -m 0644 "$image_input/image.json" /usr/lib/agent-cloud/image.json
install -m 0644 "$image_input/sshd_config" /usr/lib/agent-cloud/sshd_config
jq -r .trust.sshUserCa "$image_input/image.json" > /usr/lib/agent-cloud/ssh_user_ca.pub
jq -r .trust.tlsRoot "$image_input/image.json" > /usr/lib/agent-cloud/root_ca.crt
chmod 0644 /usr/lib/agent-cloud/ssh_user_ca.pub /usr/lib/agent-cloud/root_ca.crt
cat > /usr/local/bin/guestctl <<'COMMAND'
#!/bin/sh
exec /usr/local/bin/node /usr/lib/agent-cloud/guestctl.mjs "$@"
COMMAND
chmod 0755 /usr/local/bin/guestctl
if ! id agent-probe >/dev/null 2>&1; then useradd --system --create-home --home-dir /var/lib/agent-probe --shell /bin/sh agent-probe; fi
if ! id agent-proxy >/dev/null 2>&1; then useradd --system --no-create-home --home-dir /var/lib/agent-cloud-proxy --shell /usr/sbin/nologin agent-proxy; fi
install -m 0440 "$image_input/guest-inspect.sudoers" /etc/sudoers.d/agent-cloud-inspect
visudo -cf /etc/sudoers.d/agent-cloud-inspect
install -m 0644 "$image_input"/systemd/*.service /etc/systemd/system/
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json <<'DOCKER'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true,"userland-proxy":false}
DOCKER
systemctl daemon-reload
systemctl enable docker.service agent-cloud-enroll.service agent-cloud-proxy.service
systemctl restart docker.service
[ "$(node --version)" = "v$(jq -r .components.node "$image_input/image.json")" ]
[ "$(docker version --format '{{.Server.Version}}')" = "$(jq -r .components.docker "$image_input/image.json")" ]
[ "$(docker compose version --short)" = "$(jq -r .components.compose "$image_input/image.json")" ]
caddy version
step version
dpkg-query --show > /usr/lib/agent-cloud/os-packages.txt
printf 'Guest image tools installed; builder SSH remains available until sanitation.\n'
