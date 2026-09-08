/** Policy for the pinned local MinIO fixture; validate provider IAM separately. */
export function createFixtureDeleterPolicy(bucket: string, keyPrefix: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetBucketVersioning',
          's3:GetBucketObjectLockConfiguration',
          // S3 needs ListBucket to distinguish missing objects (404) from denied HEAD (403).
          's3:ListBucket',
        ],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObjectVersion', 's3:GetObjectRetention'],
        Resource: [`arn:aws:s3:::${bucket}/${keyPrefix}/*`],
      },
      {
        Effect: 'Allow',
        // MinIO checks DeleteObject even for versioned requests and uses lowercase versionid.
        Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        Resource: [`arn:aws:s3:::${bucket}/${keyPrefix}/*`],
        Condition: {
          StringLike: { 's3:versionid': '?*' },
          StringNotEquals: { 's3:versionid': 'null' },
        },
      },
    ],
  };
}
