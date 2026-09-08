import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const address = z.string().refine((value) => isIP(value) !== 0, 'An IP address is required.');
const file = z.string().refine(isAbsolute, 'An absolute path is required.');
const port = z.int().min(1).max(65535);
export const publicRouteSnapshotSchema = z.strictObject({
  revision: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  routes: z
    .array(z.strictObject({ hostname, address, serverName: hostname, version: z.int().positive() }))
    .max(1000)
    .refine(
      (routes) => new Set(routes.map((route) => route.hostname)).size === routes.length,
      'A hostname must have exactly one owned guest.',
    ),
});
export type PublicRouteSnapshot = z.infer<typeof publicRouteSnapshotSchema>;
export const publicGatewayConfigurationSchema = z
  .strictObject({
    caddy: file,
    stateDirectory: file,
    guestCaFile: file,
    clientCertificateFile: file,
    clientKeyFile: file,
    // Optional control HTTPS on this same gateway. The API shares its network namespace.
    control: z.strictObject({ hostname, port, accessPort: port.optional() }).optional(),
    publicTls: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('acme'), email: z.email() }),
      z.strictObject({ kind: z.literal('internal') }),
    ]),
    listenAddress: address.default('0.0.0.0'),
    httpPort: port.default(80),
    httpsPort: port.default(443),
  })
  .refine((value) => value.httpPort !== value.httpsPort, 'HTTP and HTTPS need different ports.')
  .refine(
    (value) => !value.control || ![value.httpPort, value.httpsPort].includes(value.control.port),
    'The loopback API port must differ from public listener ports.',
  )
  .refine(
    (value) =>
      !value.control?.accessPort ||
      ![value.httpPort, value.httpsPort, value.control.port].includes(value.control.accessPort),
    'The loopback access port must differ from API and public listener ports.',
  )
  .refine(
    (value) =>
      Buffer.byteLength(join(value.stateDirectory, 'admin.sock')) <
      (process.platform === 'darwin' ? 104 : 108),
    'Gateway state directory is too long for its private Unix admin socket.',
  );
export type PublicGatewayConfiguration = z.input<typeof publicGatewayConfigurationSchema>;

export function gatewayAdminSocket(configuration: PublicGatewayConfiguration) {
  return join(configuration.stateDirectory, 'admin.sock');
}

export function normalizePublicSnapshot(snapshot: PublicRouteSnapshot) {
  const parsed = publicRouteSnapshotSchema.parse(snapshot);
  parsed.routes.sort((left, right) =>
    left.hostname < right.hostname ? -1 : left.hostname > right.hostname ? 1 : 0,
  );
  return parsed;
}

/** The caller authorizes route ownership; this boundary accepts only literal names and IPs. */
export function renderCaddyConfig(
  configuration: PublicGatewayConfiguration,
  snapshot: PublicRouteSnapshot,
) {
  const config = publicGatewayConfigurationSchema.parse(configuration);
  const routes = normalizePublicSnapshot(snapshot).routes;
  const control = config.control;
  if (control && routes.some((route) => route.hostname === control.hostname))
    throw new Error('Application routes cannot replace the control hostname.');
  const names = [...(control ? [control.hostname] : []), ...routes.map((route) => route.hostname)];
  const socket = (host: string, port: number) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const reject = { handle: [{ handler: 'static_response', status_code: 404 }], terminal: true };
  return {
    admin: {
      listen: `unix/${gatewayAdminSocket(config)}`,
      config: { persist: false },
    },
    storage: { module: 'file_system', root: join(config.stateDirectory, 'certificates') },
    logging: {
      logs: {
        default: {
          level: 'ERROR',
          writer: { output: 'file', filename: join(config.stateDirectory, 'caddy.log') },
        },
      },
    },
    apps: {
      ...(config.publicTls.kind === 'internal'
        ? { pki: { certificate_authorities: { local: { install_trust: false } } } }
        : {}),
      tls: {
        certificates: { automate: names },
        automation: {
          policies:
            names.length === 0
              ? []
              : [
                  {
                    subjects: names,
                    on_demand: false,
                    issuers: [
                      config.publicTls.kind === 'internal'
                        ? { module: 'internal' }
                        : {
                            module: 'acme',
                            email: config.publicTls.email,
                            ca: 'https://acme-v02.api.letsencrypt.org/directory',
                          },
                    ],
                  },
                ],
        },
      },
      http: {
        http_port: config.httpPort,
        https_port: config.httpsPort,
        servers: {
          redirect: {
            listen: [socket(config.listenAddress, config.httpPort)],
            automatic_https: { disable: true },
            routes: [
              ...names.map((hostname) => ({
                match: [{ host: [hostname] }],
                handle: [
                  {
                    handler: 'static_response',
                    status_code: 308,
                    headers: {
                      Location: [
                        `https://${hostname}${config.httpsPort === 443 ? '' : `:${config.httpsPort}`}{http.request.uri}`,
                      ],
                    },
                  },
                ],
                terminal: true,
              })),
              reject,
            ],
          },
          ...(names.length === 0
            ? {}
            : {
                gateway: {
                  listen: [socket(config.listenAddress, config.httpsPort)],
                  automatic_https: { disable: true },
                  strict_sni_host: true,
                  tls_connection_policies: [{ match: { sni: names }, protocol_min: 'tls1.2' }],
                  routes: [
                    ...(control?.accessPort
                      ? [
                          {
                            match: [{ host: [control.hostname], path: ['/v1/ssh'] }],
                            handle: [
                              {
                                handler: 'reverse_proxy',
                                upstreams: [{ dial: `127.0.0.1:${control.accessPort}` }],
                                transport: {
                                  protocol: 'http',
                                  dial_timeout: '5s',
                                  response_header_timeout: '10s',
                                },
                              },
                            ],
                            terminal: true,
                          },
                        ]
                      : []),
                    ...(control
                      ? [
                          {
                            match: [{ host: [control.hostname] }],
                            handle: [
                              {
                                handler: 'reverse_proxy',
                                upstreams: [{ dial: `127.0.0.1:${control.port}` }],
                                transport: {
                                  protocol: 'http',
                                  dial_timeout: '5s',
                                  response_header_timeout: '30s',
                                },
                              },
                            ],
                            terminal: true,
                          },
                        ]
                      : []),
                    ...routes.map((route) => ({
                      match: [{ host: [route.hostname] }],
                      handle: [
                        {
                          handler: 'reverse_proxy',
                          upstreams: [{ dial: socket(route.address, 8443) }],
                          headers: {
                            request: {
                              set: {
                                Host: [route.hostname],
                                'X-Agent-Cloud-Route-Version': [String(route.version)],
                              },
                            },
                          },
                          transport: {
                            protocol: 'http',
                            dial_timeout: '5s',
                            response_header_timeout: '30s',
                            tls: {
                              ca: { provider: 'file', pem_files: [config.guestCaFile] },
                              server_name: route.serverName,
                              client_certificate_file: config.clientCertificateFile,
                              client_certificate_key_file: config.clientKeyFile,
                              handshake_timeout: '10s',
                            },
                          },
                        },
                      ],
                      terminal: true,
                    })),
                    reject,
                  ],
                },
              }),
        },
      },
    },
  };
}
