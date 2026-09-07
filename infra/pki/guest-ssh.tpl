{{- if and (eq .Type "user") (hasPrefix "customer:" .KeyID) -}}
{{- $access := .Token.user.agentCloudAccess -}}
{{- if not (kindIs "map" $access) -}}{{ fail "Customer signing requires signed access claims" }}{{- end -}}
{{- if or (ne (len $access) 7) (ne $access.kind "customer_ssh_v1") -}}{{ fail "Invalid customer signing claims" }}{{- end -}}
{{- if or (ne $access.keyId .KeyID) (ne (len .Principals) 1) -}}{{ fail "Customer identity differs from its token" }}{{- end -}}
{{- if ne $access.principal (index .Principals 0) -}}{{ fail "Customer principal differs from its token" }}{{- end -}}
{{- $uuid := "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" -}}
{{- if not (regexMatch (printf "^customer:access_%s:grant_%s:vm_%s$" $uuid $uuid $uuid) $access.keyId) -}}{{ fail "Invalid customer key identity" }}{{- end -}}
{{- if not (regexMatch (printf "^customer-alloc_%s$" $uuid) $access.principal) -}}{{ fail "Invalid customer allocation principal" }}{{- end -}}
{{- if or (ne .Insecure.CR.Key.Type "ssh-ed25519") (ne (toJson .Insecure.CR.Key.Marshal) (toJson $access.publicKeyWire)) -}}{{ fail "Customer key differs from its signed claim" }}{{- end -}}
{{- if not (kindIs "slice" $access.sourceAddresses) -}}{{ fail "Customer sources must be an array" }}{{- end -}}
{{- if or (lt (len $access.sourceAddresses) 1) (gt (len $access.sourceAddresses) 16) -}}{{ fail "Customer sources exceed their bounds" }}{{- end -}}
{{- if ne (len (uniq $access.sourceAddresses)) (len $access.sourceAddresses) -}}{{ fail "Customer sources must be unique" }}{{- end -}}
{{- range $source := $access.sourceAddresses -}}
{{- if not (regexMatch "^[0-9a-fA-F:.]+/[1-9][0-9]{0,2}$" $source) -}}{{ fail "Customer sources require explicit restricted CIDRs" }}{{- end -}}
{{- end -}}
{
  "type": "user",
  "keyId": {{ toJson $access.keyId }},
  "principals": [{{ toJson $access.principal }}],
  "validAfter": {{ toJson $access.validAfter }},
  "validBefore": {{ toJson $access.validBefore }},
  "extensions": {"permit-pty": ""},
  "criticalOptions": {"source-address": {{ toJson (join "," $access.sourceAddresses) }}}
}
{{- else -}}
{
  "type": {{ toJson .Type }},
  "keyId": {{ toJson .KeyID }},
  "principals": {{ toJson .Principals }},
  "extensions": {},
  "criticalOptions": {{ if eq .Type "user" }}{"force-command": {{ if hasPrefix "deployment-alloc_" .KeyID }}"/usr/bin/sudo -n -- /usr/local/bin/guestctl reference --json"{{ else if or (hasPrefix "runtime-alloc_" .KeyID) (hasPrefix "runtime-verify_" .KeyID) }}"/usr/bin/sudo -n -- /usr/local/bin/guestctl inspect --json"{{ else }}"/usr/local/bin/guestctl identity --json"{{ end }}}{{ else }}{}{{ end }}
}
{{- end -}}
