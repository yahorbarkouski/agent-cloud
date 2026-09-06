{
  "type": {{ toJson .Type }},
  "keyId": {{ toJson .KeyID }},
  "principals": {{ toJson .Principals }},
  "extensions": {},
  "criticalOptions": {{ if eq .Type "user" }}{"force-command": "/usr/local/bin/guestctl identity --json"}{{ else }}{}{{ end }}
}
