/** Sent over the authenticated management connection, never loaded from the uploaded tree. */
export const imageTransferCheck = `set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$#" = 2 ]
[ ! -L "$1" ]
cd "$1"
[ "$(printf %s "$2" | wc -c)" -eq 64 ]
case "$2" in *[!0-9a-f]*) exit 1 ;; esac
printf '%s  SHA256SUMS\\n' "$2" | sha256sum -c - >/dev/null
[ -z "$(find . ! -type f ! -type d -print -quit)" ]
[ "$(find . -type d | wc -l)" -eq 3 ]
[ "$(find . -type f | wc -l)" -eq "$(( $(wc -l < SHA256SUMS) + 1 ))" ]
sha256sum -c SHA256SUMS >/dev/null
`;

export function imageInstallCommand(input: {
  directory: string;
  builderId: string;
  manifestDigest: string;
  checksumDigest: string;
}) {
  // A subshell keeps the verification script's two positional arguments isolated.
  const script = `set -eu
(set -- "$1" "$4"; ${imageTransferCheck})
umask 077
exec /bin/sh "$1/install.sh" "$1" "$2" "$3" > /tmp/agent-cloud-install.log 2>&1
`;
  return [
    '/bin/sh',
    '-c',
    script,
    'image-install',
    input.directory,
    input.builderId,
    input.manifestDigest,
    input.checksumDigest,
  ];
}
