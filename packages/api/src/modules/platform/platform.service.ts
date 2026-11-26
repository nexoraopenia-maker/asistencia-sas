import { randomBytes } from "node:crypto";
import { getSystemClient, type Prisma } from "@scire/database";
import {
  AccountStatus,
  AppError,
  ErrorCode,
  PLAN_LIMITS,
  SubscriptionStatus,
  UserRole,
  UserStatus,
  type CreateTenantInput,
  type ListTenantsQuery,
  type SetTenantStatusInput,
} from "@scire/shared";
import { hashPassword } from "../../lib/password.js";
import { uniqueSlug } from "../auth/auth.service.js";

/**
 * Consola de plataforma: gestion de tenants por el SUPER_ADMIN.
 *
 * Usa `getSystemClient()` a proposito y en exclusiva. Estas operaciones cruzan
 * tenants por definicion —listar todas las empresas, suspender una ajena—, y
 * el cliente `db` las bloquearia (o peor, las filtraria en silencio a la
 * empresa del propio operador). Cada consulta lleva su `companyId` explicito.
 */

const system = getSystemClient();

/** Quien ejecuta la accion, para el AuditLog del tenant afectado. */
export interface PlatformActor {
  userId: string;
  companyId: string;
  ipAddress?: string;
  userAgent?: string;
}

const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  taxId: true,
  timezone: true,
  tier: true,
  maxEmployees: true,
  accountStatus: true,
  suspendedAt: true,
  graceEndsAt: true,
  createdAt: true,
  subscription: { select: { status: true, provider: true, externalSubscriptionId: true } },
  // El administrador "titular": el primer HR_ADMIN dado de alta.
  users: {
    where: { role: UserRole.HR_ADMIN },
    orderBy: { createdAt: "asc" },
    take: 1,
    select: { id: true, fullName: true, email: true, lastLoginAt: true },
  },
  _count: {
    select: {
      // Mismo criterio que la cuota de asientos: INVITED ya reserva plaza.
      users: { where: { status: { in: [UserStatus.ACTIVE, UserStatus.INVITED] } } },
      branches: { where: { isActive: true } },
    },
  },
} satisfies Prisma.CompanySelect;

type TenantRecord = Prisma.CompanyGetPayload<{ select: typeof TENANT_SELECT }>;

function toTenantRow(company: TenantRecord) {
  const { users, _count, subscription, ...rest } = company;
  return {
    ...rest,
    admin: users[0] ?? null,
    seatsUsed: _count.users,
    branchesActive: _count.branches,
    subscriptionStatus: subscription?.status ?? null,
    paymentProvider: subscription?.provider ?? null,
    /** Sin id externo, la cuenta se factura fuera de la pasarela (alta manual). */
    hasExternalBilling: Boolean(subscription?.externalSubscriptionId),
  };
}

export type TenantRow = ReturnType<typeof toTenantRow>;

export async function listTenants(query: ListTenantsQuery) {
  const search = query.search
    ? { contains: query.search, mode: "insensitive" as const }
    : undefined;

  const where: Prisma.CompanyWhereInput = {
    ...(query.status ? { accountStatus: query.status } : {}),
    ...(query.tier ? { tier: query.tier } : {}),
    ...(search ? { OR: [{ name: search }, { slug: search }, { taxId: search }] } : {}),
  };

  const [total, companies, byStatus] = await Promise.all([
    system.company.count({ where }),
    system.company.findMany({
      where,
      select: TENANT_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    // Totales globales (sin filtros): alimentan las tarjetas de resumen.
    system.company.groupBy({ by: ["accountStatus"], _count: { _all: true } }),
  ]);

  const totals = Object.fromEntries(
    Object.values(AccountStatus).map((status) => [
      status,
      byStatus.find((row) => row.accountStatus === status)?._count._all ?? 0,
    ]),
  ) as Record<AccountStatus, number>;

  return {
    items: companies.map(toTenantRow),
    total,
    page: query.page,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    totals,
  };
}

/**
 * Contrasena temporal que cumple `passwordSchema` por construccion: 16
 * caracteres aleatorios mas un sufijo que garantiza mayuscula, minuscula y
 * digito aunque el azar no los haya producido.
 */
function temporaryPassword(): string {
  return `${randomBytes(12).toString("base64url")}Aa7`;
}

/**
 * Alta asistida: empresa + suscripcion + HR_ADMIN inicial en una transaccion.
 *
 * La cuenta nace ACTIVE y sin `graceEndsAt`: el cron de vencimientos solo
 * suspende cuentas con fecha de gracia, asi que una venta cerrada a mano no
 * caduca sola a los 14 dias como un trial self-service.
 */
export async function createTenant(input: CreateTenantInput, actor: PlatformActor) {
  const existing = await system.user.findUnique({
    where: { email: input.adminEmail },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(ErrorCode.CONFLICT, "Ya existe una cuenta con ese correo electronico");
  }

  const generatedPassword = input.adminPassword ? null : temporaryPassword();
  const passwordHash = await hashPassword(input.adminPassword ?? generatedPassword!);
  const slug = await uniqueSlug(input.companyName);
  const plan = PLAN_LIMITS[input.tier];
  const now = new Date();

  const company = await system.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        name: input.companyName,
        slug,
        taxId: input.taxId ?? null,
        timezone: input.timezone,
        tier: input.tier,
        maxEmployees: plan.maxEmployees,
        accountStatus: AccountStatus.ACTIVE,
      },
      select: { id: true },
    });

    await tx.subscription.create({
      data: {
        companyId: created.id,
        tier: input.tier,
        status: SubscriptionStatus.ACTIVE,
        seats: plan.maxEmployees,
        currentPeriodStart: now,
      },
    });

    const admin = await tx.user.create({
      data: {
        companyId: created.id,
        email: input.adminEmail,
        passwordHash,
        fullName: input.adminFullName,
        employeeCode: "ADMIN-001",
        jobTitle: "Administrador de Recursos Humanos",
        phone: input.adminPhone ?? null,
        role: UserRole.HR_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: now,
        hiredAt: now,
      },
      select: { id: true },
    });

    await tx.auditLog.create({
      data: {
        companyId: created.id,
        entityType: "Company",
        recordId: created.id,
        action: "CREATE",
        modifiedByUserId: actor.userId,
        newValue: {
          name: input.companyName,
          tier: input.tier,
          accountStatus: AccountStatus.ACTIVE,
          adminUserId: admin.id,
          adminEmail: input.adminEmail,
        },
        reason: "Alta manual desde la consola de plataforma",
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });

    return tx.company.findUniqueOrThrow({ where: { id: created.id }, select: TENANT_SELECT });
  });

  return { tenant: toTenantRow(company), temporaryPassword: generatedPassword };
}

/**
 * Suspension o reactivacion manual, sin pasar por la pasarela de pago.
 *
 * Al suspender se revocan todas las sesiones de la empresa: `requireAuth` no
 * consulta el estado de la cuenta en cada request, y sin la revocacion los
 * usuarios ya conectados seguirian dentro hasta que caducara su refresh token.
 * El login y el refresco si comprueban `canOperate`, asi que no pueden volver.
 *
 * Si la pasarela envia despues un evento (un pago, un cobro fallido), ese
 * evento manda: es lo esperado, el ajuste manual no bloquea la facturacion.
 */
export async function setTenantStatus(
  companyId: string,
  input: SetTenantStatusInput,
  actor: PlatformActor,
) {
  if (companyId === actor.companyId && input.status === AccountStatus.SUSPENDED) {
    // Suspender la empresa del propio operador lo dejaria fuera de la consola
    // sin nadie capaz de revertirlo desde la web.
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "No puedes suspender la empresa a la que pertenece tu cuenta de plataforma",
    );
  }

  const current = await system.company.findUnique({
    where: { id: companyId },
    select: { accountStatus: true, suspendedAt: true, graceEndsAt: true },
  });
  if (!current) throw new AppError(ErrorCode.NOT_FOUND, "Empresa no encontrada");

  if (current.accountStatus === input.status) {
    throw new AppError(
      ErrorCode.CONFLICT,
      input.status === AccountStatus.SUSPENDED
        ? "La empresa ya esta suspendida"
        : "La empresa ya esta activa",
    );
  }

  const now = new Date();
  const suspending = input.status === AccountStatus.SUSPENDED;

  const company = await system.$transaction(async (tx) => {
    const updated = await tx.company.update({
      where: { id: companyId },
      data: suspending
        ? { accountStatus: AccountStatus.SUSPENDED, suspendedAt: now, graceEndsAt: null }
        : { accountStatus: AccountStatus.ACTIVE, suspendedAt: null, graceEndsAt: null },
      select: TENANT_SELECT,
    });

    await tx.subscription.updateMany({
      where: { companyId },
      data: { status: suspending ? SubscriptionStatus.SUSPENDED : SubscriptionStatus.ACTIVE },
    });

    let sessionsRevoked = 0;
    if (suspending) {
      const revoked = await tx.session.updateMany({
        where: { companyId, revokedAt: null },
        data: { revokedAt: now },
      });
      sessionsRevoked = revoked.count;
    }

    await tx.auditLog.create({
      data: {
        companyId,
        entityType: "Company",
        recordId: companyId,
        action: "UPDATE",
        modifiedByUserId: actor.userId,
        previousValue: {
          accountStatus: current.accountStatus,
          suspendedAt: current.suspendedAt?.toISOString() ?? null,
          graceEndsAt: current.graceEndsAt?.toISOString() ?? null,
        },
        newValue: {
          accountStatus: input.status,
          suspendedAt: suspending ? now.toISOString() : null,
          graceEndsAt: null,
          ...(suspending ? { sessionsRevoked } : {}),
        },
        reason: `[Plataforma] ${input.reason}`,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });

    return updated;
  });

  return toTenantRow(company);
}
