/** OrbStack reports lxc; exercise the real VM seed unit rather than its container skip. */
export async function prepareVmSeedFixture(vm: (args: string[]) => Promise<string>) {
  await vm([
    '/bin/sh',
    '-ec',
    `install -d -m 0755 /etc/systemd/system/systemd-random-seed.service.d
printf '%s\\n' '[Unit]' 'ConditionVirtualization=' > /etc/systemd/system/systemd-random-seed.service.d/10-agent-cloud-smoke.conf
systemctl daemon-reload
systemctl start systemd-random-seed.service
systemctl is-active --quiet systemd-random-seed.service
test -s /var/lib/systemd/random-seed`,
  ]);
}
