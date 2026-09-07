/** `ssh-keyscan -c` prints certificates without the known-hosts hostname column. */
export function assertScannedHostCertificate(input: { output: string; expected: string }): void {
  const lines = input.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const actual = lines[0]?.split(/\s+/).slice(0, 2).join(' ');
  const expected = input.expected.trim().split(/\s+/).slice(0, 2).join(' ');
  if (
    lines.length !== 1 ||
    !expected.startsWith('ssh-ed25519-cert-v01@openssh.com ') ||
    actual !== expected
  )
    throw new Error('SSH scan does not match the issued host certificate.');
}
