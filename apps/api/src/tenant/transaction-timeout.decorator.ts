import { SetMetadata } from '@nestjs/common';

export const TRANSACTION_TIMEOUT_KEY = 'tenantTransactionTimeoutMs';

/**
 * Lengthen the request transaction TenantInterceptor opens for this route.
 *
 * Every authenticated request runs inside one interactive transaction, and
 * Prisma closes those after 5 seconds by default. A handler that waits on
 * something slow in the middle — an S3 upload followed by an OCR call — can
 * outlive it, and then the next query fails with "Transaction already closed"
 * and the request 500s, even though the slow step itself succeeded.
 *
 * Use it only on routes that genuinely wait on an external service, and size
 * it to that service's own timeout plus a margin: the transaction holds a pool
 * connection for as long as it is open.
 */
export const TransactionTimeout = (ms: number): MethodDecorator & ClassDecorator =>
  SetMetadata(TRANSACTION_TIMEOUT_KEY, ms);
