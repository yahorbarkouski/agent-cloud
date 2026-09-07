{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.gateway\\.agent-cloud\\.internal$" .Token.sub) -}}
{{ fail "gateway provisioner requires an exact gateway identity" }}
{{- end -}}
{
  "subject": { "commonName": {{ toJson .Token.sub }} },
  "sans": [{ "type": "dns", "value": {{ toJson .Token.sub }} }],
  "keyUsage": ["digitalSignature"],
  "extKeyUsage": ["clientAuth"],
  "basicConstraints": { "isCA": false }
}
