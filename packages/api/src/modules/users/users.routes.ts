import { db, getSystemClient, Prisma, tenantData, withAuditReason } from "@scire/database";
import {
  AppError,
  ASSIGNABLE_ROLES,
  createUserSchema,
  ErrorCode,
  idSchema,
  inviteUsersSchema,
  paginationSchema,
  updateUserSchema,
  UserRole,
  UserStatus,
} from "@scire/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, ok, parseBody, parseQuery } from "../../lib/http.js";
import { generateOpaqueToken, hashToken } from "../../lib/jwt.js";
import { requireRole } from "../../middleware/auth.js";
import { assertSeatsAvailable, checkSeatLimit } from "../../middleware/billing.js";

/**
 * Gestion de colaboradores.
 *
 * El limite de empleados del plan se comprueba aqui, en el punto donde se
 * consume: contar sobre `Company.maxEmployees` materializado es un COUNT sin
 * joins, y permite limites negociados fuera de tarifa en cuentas Enterprise.
 */
export const usersRouter: Router = Router();

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  employeeCode: true,
  jobTitle: true,
  phone: true,
  role: true,
  status: true,
  hiredAt: true,
  lastLoginAt: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
} as const;

/** Usuarios que cuentan para el cupo: activos y los invitados sin activar. */
const BILLABLE_STATUSES: UserStatus[] = [UserStatus.ACTIVE, UserStatus.INVITED];

async function assertSeatAvailable(companyId: string, seatsNeeded = 1): Promise<void> {
  const [company, used] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId }, select: { maxEmployees: true } }),
    db.user.count({ where: { status: { in: BILLABLE_STATUSES } } }),
  ]);

  if (used + seatsNeeded > company.maxEmployees) {
    throw new AppError(
      ErrorCode.EMPLOYEE_LIMIT_REACHED,
      `Tu plan permite ${company.maxEmployees} colaboradores y ya tienes ${used}. Amplia el plan para seguir dando de alta.`,
      { limit: company.maxEmployees, used, requested: seatsNeeded },
    );
  }
}

/** Impide escalada de privilegios: SUPER_ADMIN no se asigna desde el tenant. */
function assertAssignableRole(role: UserRole): void {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new AppError(ErrorCode.FORBIDDEN, "Ese rol no se puede asignar desde el panel");
  }
}

const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  branchId: idSchema.optional(),
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

usersRouter.get(
  "/",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const query = parseQuery(listQuerySchema, req.query);

    const where: Prisma.UserWhereInput = {
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: "insensitive" } },
              { employeeCode: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [items, total, activeCount] = await Promise.all([
      db.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: { fullName: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      db.user.count({ where }),
      db.user.count({ where: { status: { in: BILLABLE_STATUSES } } }),
    ]);

    ok(res, {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      seatsUsed: activeCount,
    });
  }),
);

usersRouter.get(
  "/:userId",
  requireRole(UserRole.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const user = await db.user.findUnique({
      where: { id: req.params.userId! },
      select: USER_SELECT,
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Empleado no encontrado");
    ok(res, user);
  }),
);

usersRouter.post(
  "/",
  requireRole(UserRole.HR_ADMIN),
  checkSeatLimit(),
  asyncHandler(async (req, res) => {
    const input = parseBody(createUserSchema, req.body);
    assertAssignableRole(input.role);
    await assertSeatAvailable(req.auth!.companyId);

    // El email es unico GLOBALMENTE (es el identificador de login), asi que la
    // colision hay que buscarla fuera del tenant. Se responde 409 sin decir a
    // que empresa pertenece: seria una fuga de informacion entre clientes.
    const taken = await getSystemClient().user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (taken) {
      throw new AppError(ErrorCode.CONFLICT, "Ese correo ya esta registrado en la plataforma");
    }

    try {
      const created = await db.user.create({
        data: tenantData<Prisma.UserUncheckedCreateInput>({
          email: input.email,
          fullName: input.fullName,
          employeeCode: input.employeeCode,
          jobTitle: input.jobTitle ?? null,
          phone: input.phone ?? null,
          role: input.role,
          branchId: input.branchId ?? null,
          hiredAt: input.hiredAt ? new Date(input.hiredAt) : null,
          status: UserStatus.INVITED,
        }),
        select: USER_SELECT,
      });
      ok(res, created, 201);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(ErrorCode.CONFLICT, "Ya existe un colaborador con ese codigo de empleado");
      }
      throw error;
    }
  }),
);

usersRouter.patch(
  "/:userId",
  requireRole(UserRole.HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = parseBody(updateUserSchema, { ...req.body, id: req.params.userId });
    const { id, hiredAt, ...rest } = input;

    if (rest.role) assertAssignableRole(rest.role);

    const existing = await db.user.findUnique({
      where: { id },
      select: { id: true, status: true, role: true },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, "Empleado no encontrado");

    // Reactivar a alguien vuelve a ocupar un asiento del plan.
    const reactivating =
      rest.status !== undefined &&
      BILLABLE_STATUSES.includes(rest.status) &&
      !BILLABLE_STATUSES.includes(existing.status);
    if (reactivating) await assertSeatAvailable(req.auth!.companyId);

    // Un cambio de rol o de estado es una decision con consecuencias
    // laborales: la extension de auditoria lo registra sola, aqui solo se le
    // adjunta el motivo para que el rastro sea legible.
    const reason =
      rest.role && rest.role !== existing.role
        ? `Cambio de rol a ${rest.role} desde el panel de RRHH`
        : rest.status
          ? `Cambio de estado a ${rest.status} desde el panel de RRHH`
          : "Actualizacion de datos del colaborador";

    const updated = await withAuditReason({ reason }, () =>
      db.user.update({
        where: { id },
        data: {
          ...rest,
          ...(hiredAt !== undefined ? { hiredAt: hiredAt ? new Date(hiredAt) : null } : {}),
          ...(rest.status === UserStatus.TERMINATED ? { terminatedAt: new Date() } : {}),
        },
        select: USER_SELECT,
      }),
    );

    // Dar de baja cierra sus sesiones al instante: `requireAuth` comprueba el
    // estado en cada request, pero revocar tambien impide el refresco.
    if (rest.status === UserStatus.TERMINATED || rest.status === UserStatus.SUSPENDED) {
      await db.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    ok(res, updated);
  }),
);

/**
 * Invitacion de colaboradores.
 *
 * Genera un token de un solo uso por persona y devuelve el enlace. El envio
 * por email o WhatsApp lo dispara n8n / Evolution API a partir del webhook: la
 * API no habla directamente con proveedores de mensajeria.
 *
 * Solo se guarda el HASH del token; el valor en claro sale una unica vez en
 * esta respuesta y no vuelve a ser recuperable.
 */
usersRouter.post(
  "/invite",
  requireRole(UserRole.HR_ADMIN),
  // Una invitacion masiva consume tantas plazas como personas lleve.
  checkSeatLimit((body) => (body as { invitations?: unknown[] })?.invitations?.length ?? 1),
  asyncHandler(async (req, res) => {
    const input = parseBody(inviteUsersSchema, req.body);
    for (const invitation of input.invitations) assertAssignableRole(invitation.role);
    await assertSeatAvailable(req.auth!.companyId, input.invitations.length);

    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    const system = getSystemClient();
    const created: { email: string; fullName: string; invitationToken: string }[] = [];
    const skipped: { email: string; reason: string }[] = [];

    for (const invitation of input.invitations) {
      const taken = await system.user.findUnique({
        where: { email: invitation.email },
        select: { id: true },
      });
      if (taken) {
        skipped.push({ email: invitation.email, reason: "El correo ya esta registrado" });
        continue;
      }

      const token = generateOpaqueToken();
      try {
        await db.user.create({
          data: tenantData<Prisma.UserUncheckedCreateInput>({
            email: invitation.email,
            fullName: invitation.fullName,
            employeeCode: invitation.employeeCode,
            phone: invitation.phone ?? null,
            role: invitation.role,
            branchId: invitation.branchId ?? null,
            status: UserStatus.INVITED,
            invitationTokenHash: hashToken(token),
            invitationExpiresAt: expiresAt,
          }),
        });
        created.push({
          email: invitation.email,
          fullName: invitation.fullName,
          invitationToken: token,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          skipped.push({ email: invitation.email, reason: "Codigo de empleado duplicado" });
          continue;
        }
        throw error;
      }
    }

    ok(res, { invited: created.length, skipped, invitations: created, expiresAt }, 201);
  }),
);
