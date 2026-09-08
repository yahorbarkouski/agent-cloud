import { CloudError, type Recipe } from '@agent-cloud/contracts';

const database = {
  name: 'database',
  image:
    'postgres:17.11-alpine3.24@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
  memoryBytes: 384 * 1024 * 1024,
  cpus: 0.5,
  pids: 100,
};
const commonInstructions = [
  'Prepare an explicit version into a new private directory. Existing directories and secrets are never overwritten.',
  'Retain the context and release-id. Deploy with compose apply --source <directory> --release <saved-release-id>; reconnect with compose inspect or compose wait.',
  'Every regular file in the context is uploaded. Include no unrelated files. Never print secrets or expanded Compose configuration.',
  'Keep passwords and keys on upgrades. Take a protected backup and verify an isolated restore before risky changes. Compose recovery does not reverse SQL migrations.',
  'Database storage is a named volume on an internal bridge without a host port. Connect application services through the same Compose network.',
];

/** These versioned assets are bundled with the CLI; preparation never fetches remote code. */
export const recipes: readonly Recipe[] = [
  {
    id: 'postgres',
    version: '1.0.0',
    description: 'PostgreSQL 17 with private networking, persistent storage and bounded resources.',
    architectures: ['amd64', 'arm64'],
    services: [database],
    loopbackPort: null,
    secrets: ['secrets/database-password'],
    backup: {
      kind: 'postgres-17',
      service: 'database',
      database: 'app',
      user: 'app',
      requiresOperatorStorage: true,
      scope: 'selected-database-and-compose-source',
      pointInTimeRecovery: false,
    },
    instructions: commonInstructions,
  },
  {
    id: 'umami',
    version: '1.0.0',
    description:
      'Umami analytics with PostgreSQL 17 and a generated administrator password before HTTP starts.',
    architectures: ['amd64', 'arm64'],
    services: [
      database,
      {
        name: 'umami',
        image:
          'ghcr.io/umami-software/umami:3.3.1@sha256:fa32d116cf20cad52cbc3fad9a63b46e7fa02299d8f967168eb453d49c476b4a',
        memoryBytes: 768 * 1024 * 1024,
        cpus: 1,
        pids: 100,
      },
    ],
    loopbackPort: 3000,
    secrets: ['secrets/database-password', 'secrets/umami.env'],
    backup: {
      kind: 'postgres-17',
      service: 'database',
      database: 'umami',
      user: 'umami',
      requiresOperatorStorage: true,
      scope: 'selected-database-and-compose-source',
      pointInTimeRecovery: false,
    },
    instructions: [
      ...commonInstructions,
      'Wait for compose health, then publish the selected loopback port with route publish. Set --wait-seconds 300 for Umami startup.',
      'The initial admin password is RECIPE_ADMIN_PASSWORD in secrets/umami.env. Read it privately; verify the upstream default password is rejected. Change it and enable two-factor authentication.',
      'Preserve APP_SECRET and TWO_FACTOR_ENCRYPTION_KEY across updates and restoration. Startup preserves an administrator password changed through Umami.',
      'Create the actual website in Umami, retain its UUID, add the HTTPS script.js URL and data-website-id to the deployed frontend, and tag an intended action with data-umami-event.',
      'Visit the real site and perform that action in a browser. Verify a pageview, visitor and event through authenticated Umami readback. Installing analytics alone does not instrument a site.',
    ],
  },
];

export function findRecipe(id: string, version?: string): Recipe {
  const recipe = recipes.find(
    (item) => item.id === id && (version === undefined || item.version === version),
  );
  if (!recipe)
    throw new CloudError(
      'not_found',
      'Recipe version is not bundled. Inspect recipe list and select an available version.',
    );
  return recipe;
}
