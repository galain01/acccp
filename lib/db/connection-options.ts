/**
 * A supplied CA enables certificate-verified TLS even when DATABASE_URL has a
 * weaker sslmode. Without it, keep the driver's existing URL/env behavior.
 * DATABASE_SSL_CA contains the public PEM certificate, never a private key.
 */
export function databaseConnectionOptions(
  certificate = process.env.DATABASE_SSL_CA
): { prepare: false; ssl?: { ca: string; rejectUnauthorized: true } } {
  const ca = certificate?.replace(/\\n/g, "\n").trim();
  return {
    prepare: false,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  };
}
