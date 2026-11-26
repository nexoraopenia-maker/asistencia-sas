export {
  db,
  getSystemClient,
  disconnectDatabase,
  checkDatabaseHealth,
  type TenantPrismaClient,
} from "./client.js";

export {
  runWithTenant,
  enterTenantContext,
  getTenantContext,
  requireTenantContext,
  tenantExtension,
  tenantData,
  TENANT_SCOPED_MODELS,
  type TenantContext,
} from "./tenant.js";

export { auditExtension, withAuditReason, AUDITED_MODELS } from "./audit.js";

// Reexporta los tipos generados por Prisma para que el resto del monorepo no
// tenga que depender de @prisma/client directamente.
export { Prisma } from "@prisma/client";
export type {
  Company,
  Branch,
  User,
  Session,
  Shift,
  AttendanceRecord,
  Absence,
  AuditLog,
  Subscription,
  Invoice,
  BillingWebhookEvent,
  WebhookEndpoint,
  WebhookDelivery,
  BiometricDevice,
} from "@prisma/client";
