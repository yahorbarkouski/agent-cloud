{
  "subject": { "commonName": {{ toJson .Token.sub }} },
  "sans": [{ "type": "dns", "value": {{ toJson .Token.sub }} }],
  "keyUsage": ["digitalSignature"],
  "extKeyUsage": ["serverAuth"],
  "basicConstraints": { "isCA": false }
}
