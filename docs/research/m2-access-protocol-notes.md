# Customer SSH protocol notes

Checked primary documentation on 2026-09-07. These are design constraints, not implementation proof.

OpenSSH user certificates can restrict the accepted client source to CIDR ranges with the `source-address` critical option. Certificate validity is checked when presented. The platform must separately close established gateway connections after revocation; certificate expiry alone does not establish that behavior. The latter is our access design requirement. [OpenSSH ssh-keygen manual](https://man.openbsd.org/ssh-keygen#CERTIFICATES).

Smallstep SSH templates expose signed token data, principals, critical options and extensions. Request-supplied template data is explicitly marked insecure. Customer access policy should therefore use controller-authorized signed fields and validate the returned certificate; it must not copy arbitrary requested principals or extensions. Pinned local CA verification is still required. [Smallstep templates](https://smallstep.com/docs/step-ca/templates/#ssh-templates).

The `ws` server supports an HTTP upgrade owner and explicit message limits. Its documented default payload limit is100MiB, too large for a bounded SSH transport. `createWebSocketStream` supplies a Node Duplex interface, but queue bounds, authorization, timeouts, connection disposal and revocation still need application behavior and tests. [ws API documentation](https://github.com/websockets/ws/blob/master/doc/ws.md#class-websocketserver), [stream adapter](https://github.com/websockets/ws/blob/master/doc/ws.md#createwebsocketstreamwebsocket-options).
