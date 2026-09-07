import {
  CloudError,
  selectOffer,
  microsSchema,
  imageBuildAdmissionSchema,
  imageBuildStateSchema,
  type Catalog,
  type ImageBuildAdmission,
  type ImageBuildLimits,
} from '@agent-cloud/contracts';

export function imageReservation(admission: ImageBuildAdmission) {
  const duration = Date.parse(admission.deadlineAt) - Date.parse(admission.admittedAt);
  if (duration <= 0 || duration > 86_400_000)
    throw new CloudError('invalid_input', 'Image builds need a deadline within 24 hours.');
  const hoursPerMachine = Math.ceil(duration / 3_600_000);
  return {
    // Builder and verifier may each exist for the entire window, including while stopped.
    vmGrossMicros: microsSchema.parse(2 * hoursPerMachine * admission.offer.hourlyMicros),
    snapshotMonthlyGrossMicros: microsSchema.parse(
      admission.budget.maxSnapshotGb * admission.storagePrice.grossMicrosPerGbMonth,
    ),
  };
}

export function checkImagePrices(input: {
  admission: ImageBuildAdmission;
  catalog: Catalog;
  storagePrice: ImageBuildAdmission['storagePrice'];
  now: number;
}) {
  const { admission, catalog, storagePrice, now } = input;
  const offer = admission.offer;
  const current = selectOffer({ catalog, size: offer.size, region: offer.region, now });
  if (
    catalog.provider !== 'hetzner' ||
    catalog.pricing !== 'account_gross' ||
    current.serverType !== offer.serverType ||
    current.architecture !== offer.architecture ||
    current.diskGb !== offer.diskGb ||
    current.memoryGb !== offer.memoryGb ||
    current.vcpus !== offer.vcpus
  )
    throw new CloudError(
      'capacity_unavailable',
      'The exact admitted image-build offer is unavailable.',
    );
  if (
    current.currency !== offer.currency ||
    storagePrice.currency !== offer.currency ||
    current.serverHourlyMicros > offer.serverHourlyMicros ||
    current.ipv4HourlyMicros > offer.ipv4HourlyMicros ||
    storagePrice.grossMicrosPerGbMonth > admission.storagePrice.grossMicrosPerGbMonth
  )
    throw new CloudError('budget_exceeded', 'Current image-build prices exceed the admission.');
  if (
    Date.parse(storagePrice.observedAt) > now + 5000 ||
    Date.parse(storagePrice.expiresAt) <= now ||
    Date.parse(storagePrice.expiresAt) <= Date.parse(storagePrice.observedAt)
  )
    throw new CloudError(
      'provider_unavailable',
      'Refresh snapshot pricing before admission or creation.',
      true,
    );
}

export function checkImageAdmission(admission: ImageBuildAdmission, now: number) {
  const { offer, budget, storagePrice, source } = admission;
  if (
    offer.priceBasis !== 'account_gross' ||
    !offer.available ||
    offer.currency !== budget.currency ||
    storagePrice.currency !== budget.currency ||
    source.manifest.architecture !== offer.architecture ||
    budget.maxSnapshotGb < offer.diskGb
  )
    throw new CloudError(
      'invalid_input',
      'Image architecture, gross currency and snapshot disk ceiling must match the offer.',
    );
  if (
    Math.abs(Date.parse(admission.admittedAt) - now) > 5000 ||
    Date.parse(admission.deadlineAt) <= now
  )
    throw new CloudError(
      'invalid_input',
      'Admission needs a current timestamp and a future deadline.',
    );
  if (admission.retention.kind === 'retain') {
    const expiry = Date.parse(admission.retention.deleteAfter);
    if (
      expiry <= Date.parse(admission.deadlineAt) ||
      expiry > Date.parse(admission.admittedAt) + 30 * 86_400_000
    )
      throw new CloudError(
        'invalid_input',
        'Snapshot retention must follow the build deadline and fit within 30 days.',
      );
  }
  const reservation = imageReservation(admission);
  if (
    reservation.vmGrossMicros > budget.maxVmGrossMicros ||
    reservation.snapshotMonthlyGrossMicros > budget.maxSnapshotMonthlyGrossMicros
  )
    throw new CloudError(
      'budget_exceeded',
      'Image-build caps do not cover both machines, IPv4 and snapshot storage.',
    );
}

export function parseImageReservations(rows: { admission: unknown; state: unknown }[]) {
  return rows.map((row) => {
    const admission = imageBuildAdmissionSchema.parse(row.admission);
    const state = imageBuildStateSchema.parse(row.state);
    return {
      currency: admission.budget.currency,
      openBuilds: state.kind === 'retained' || state.kind === 'cleaned' ? 0 : 1,
      vmGrossMicros:
        state.kind === 'retained' || state.kind === 'cleaned'
          ? 0
          : admission.budget.maxVmGrossMicros,
      snapshotMonthlyGrossMicros:
        state.kind === 'cleaned' ? 0 : admission.budget.maxSnapshotMonthlyGrossMicros,
    };
  });
}

export function checkImageLimits(
  reservations: ReturnType<typeof parseImageReservations>,
  limits: ImageBuildLimits,
) {
  if (
    reservations.reduce((sum, item) => sum + item.openBuilds, 0) > limits.maxOpenBuilds ||
    reservations.some((item) => item.currency !== limits.currency) ||
    reservations.reduce((sum, item) => sum + item.vmGrossMicros, 0) > limits.maxVmGrossMicros ||
    reservations.reduce((sum, item) => sum + item.snapshotMonthlyGrossMicros, 0) >
      limits.maxSnapshotMonthlyGrossMicros
  )
    throw new CloudError(
      'budget_exceeded',
      'Open image builds and retained snapshots exceed the current operator limits.',
    );
}
