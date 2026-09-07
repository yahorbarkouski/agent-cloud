{
  "type": {{ toJson .Type }},
  "keyId": {{ toJson .KeyID }},
  "principals": {{ toJson .Principals }},
  "extensions": {},
  "criticalOptions": {{ if eq .Type "user" }}{"force-command": {{ if or (hasPrefix "runtime-alloc_" .KeyID) (hasPrefix "runtime-verify_" .KeyID) }}"/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json"{{ else }}"/usr/local/bin/guestctl identity --json"{{ end }}}{{ else }}{}{{ end }}
}
