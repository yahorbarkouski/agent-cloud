import type { ReferenceRelease } from '@agent-cloud/contracts';

export const referenceImages = {
  node: 'node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf',
  postgres:
    'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
  caddy:
    'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
};

export function referenceRecipe(release: ReferenceRelease) {
  const limits = {
    restart: 'unless-stopped',
    pids_limit: 100,
    security_opt: ['no-new-privileges:true'],
    logging: { driver: 'local', options: { 'max-size': '1m', 'max-file': '2' } },
  };
  return {
    name: 'agent-cloud-reference',
    services: {
      database: {
        ...limits,
        image: referenceImages.postgres,
        mem_limit: '384m',
        cpus: 0.5,
        environment: {
          POSTGRES_USER: 'reference',
          POSTGRES_DB: 'reference',
          POSTGRES_PASSWORD_FILE: '/run/secrets/database_password',
        },
        secrets: ['database_password'],
        volumes: ['database:/var/lib/postgresql/data'],
        networks: ['private'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U reference -d reference'],
          interval: '3s',
          timeout: '3s',
          retries: 20,
        },
      },
      backend: {
        ...limits,
        build: '.',
        image: `agent-cloud-reference:${release.releaseId}`,
        user: '1000:1000',
        mem_limit: '256m',
        cpus: 0.5,
        read_only: true,
        cap_drop: ['ALL'],
        environment: { APP_REVISION: release.revision, APP_HOSTNAME: release.hostname },
        secrets: ['database_password'],
        networks: ['private'],
        depends_on: { database: { condition: 'service_healthy' } },
        healthcheck: {
          test: [
            'CMD',
            'node',
            '-e',
            "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: '3s',
          timeout: '3s',
          retries: 20,
        },
      },
      frontend: {
        ...limits,
        image: referenceImages.caddy,
        mem_limit: '128m',
        cpus: 0.25,
        ports: ['80:80', '443:443'],
        networks: ['private', 'public'],
        volumes: [
          './Caddyfile:/etc/caddy/Caddyfile:ro',
          './index.html:/srv/index.html:ro',
          'certificates:/data',
          'caddy_config:/config',
        ],
        depends_on: { backend: { condition: 'service_healthy' } },
        healthcheck: {
          test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/ready'],
          interval: '3s',
          timeout: '3s',
          retries: 20,
        },
      },
    },
    secrets: { database_password: { file: '../../database-password' } },
    volumes: { database: {}, certificates: {}, caddy_config: {} },
    networks: { private: { internal: true }, public: {} },
  };
}

export function referenceFrontend(revision: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent cloud reference</title><style>body{font:18px system-ui;max-width:44rem;margin:12vh auto;padding:1rem;color:#172521;background:#f4f7f5}button{font:inherit;padding:.6rem 1rem}output{display:block;margin:1rem 0}</style><h1>Your application is running</h1><p>Frontend, TypeScript backend and PostgreSQL on one VM. Release ${revision}.</p><output id="counter">Loading persisted count…</output><button id="visit">Record a visit</button><script>const show=async(method='GET')=>{const response=await fetch('/api/visits',{method});if(!response.ok)throw Error('Application unavailable');const value=await response.json();document.querySelector('#counter').textContent='Persisted visits: '+value.count+' · backend release '+value.revision;};document.querySelector('#visit').onclick=()=>show('POST').catch(()=>document.querySelector('#counter').textContent='Request failed');show().catch(()=>document.querySelector('#counter').textContent='Request failed');</script></html>`;
}
