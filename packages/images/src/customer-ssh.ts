export const customerSshSudoers =
  'Defaults:agent-customer env_reset, !setenv, secure_path="/usr/local/bin:/usr/bin:/bin"\n' +
  'agent-customer ALL=(ALL:ALL) NOPASSWD: ALL\n';
