import { getSystemClient } from "@scire/database";
import {
  AccountStatus,
  AppError,
  canOperate,
  DEFAULT_TRIAL_DAYS,
  ErrorCode,
  PLAN_LIMITS,
  SubscriptionTier,
  UserRole,
  UserStatus,
  type AcceptInvitationInput,
  type AuthTokens,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterCompanyInput,
} from "@scire/shared";
import { loadConfig } from "../../config.js";
import {
  accessTokenTtlSeconds,
  hashToken,
  refreshTokenExpiry,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../lib/jwt.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";

/**
 * Servicios de autenticacion.
 *
 * Todo este modulo usa `getSystemClient()` de forma deliberada: la
 * autenticacion es precisamente el proceso que ESTABLECE el tenant, asi que no
 * puede correr dentro de un contexto de tenant que aun no existe. Cada consulta
 * aplica el filtro por `companyId` de forma explicita en cuanto se conoce.
 */

const system = getSystemClient();

export interface SessionMeta {
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  deviceName?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string | null;
  role: UserRole;
  companyId: string;
  companyName: string;
  branchId: string | null;
  avatarKey: string | null;
}

/** Crea la sesion y devuelve el par de tokens. */
async function issueSession(
  user: { id: string; companyId: string; role: string },
  meta: SessionMeta,
): Promise<AuthTokens> {
  const session = await system.session.create({
    data: {
      companyId: user.companyId,
      userId: user.id,
      // Se rellena inmediatamente despues: el JWT necesita el id de la sesion,
      // y la sesion necesita el hash del JWT. Se rompe el ciclo con un valor
      // temporal unico que nunca es un hash valido.
      refreshTokenHash: `pending:${crypto.randomUUID()}`,
      expiresAt: refreshTokenExpiry(),
      deviceId: meta.deviceId ?? null,
      deviceName: meta.deviceName ?? null,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  const tokenInput = {
    userId: user.id,
    companyId: user.companyId,
    role: user.role as UserRole,
    sessionId: session.id,
  };

  const accessToken = signAccessToken(tokenInput);
  const refreshToken = signRefreshToken(tokenInput);

  await system.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: hashToken(refreshToken) },
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: accessTokenTtlSeconds(),
    tokenType: "Bearer",
  };
}

function toAuthenticatedUser(user: {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string | null;
  role: string;
  companyId: string;
  branchId: string | null;
  profilePhotoKey: string | null;
  company: { name: string };
}): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    employeeCode: user.employeeCode,
    jobTitle: user.jobTitle,
    role: user.role as UserRole,
    companyId: user.companyId,
    companyName: user.company.name,
    branchId: user.branchId,
    avatarKey: user.profilePhotoKey,
  };
}

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  employeeCode: true,
  jobTitle: true,
  role: true,
  companyId: true,
  branchId: true,
  profilePhotoKey: true,
  passwordHash: true,
  status: true,
  company: { select: { name: true, accountStatus: true } },
} as const;

/** Slug legible y unico por empresa, base para subdominios futuros. */
export async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "empresa";

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await system.company.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Onboarding self-service: crea la empresa, su suscripcion en trial y el
 * primer usuario HR_ADMIN, todo en una transaccion. Si algo falla no queda
 * una empresa a medio crear sin administrador que pueda entrar.
 */
export async function registerCompany(
  input: RegisterCompanyInput,
  meta: SessionMeta,
): Promise<{ user: AuthenticatedUser; tokens: AuthTokens }> {
  const config = loadConfig();

  const existing = await system.user.findUnique({
    where: { email: input.adminEmail },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(ErrorCode.CONFLICT, "Ya existe una cuenta con ese correo electronico");
  }

  const slug = await uniqueSlug(input.companyName);
  const passwordHash = await hashPassword(input.adminPassword);
  const trialEndsAt = new Date(Date.now() + config.TRIAL_DAYS * 86_400_000);
  const plan = PLAN_LIMITS[SubscriptionTier.FREE];

  const created = await system.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        name: input.companyName,
        slug,
        taxId: input.taxId ?? null,
        timezone: input.timezone,
        tier: SubscriptionTier.FREE,
        maxEmployees: plan.maxEmployees,
        // El trial arranca aqui: la empresa disfruta del plan elegido durante
        // 14 dias y el cron la suspende si no ha pagado al vencer.
        accountStatus: AccountStatus.TRIALING,
        graceEndsAt: trialEndsAt,
      },
    });

    await tx.subscription.create({
      data: {
        companyId: company.id,
        tier: SubscriptionTier.FREE,
        status: "TRIALING",
        trialEndsAt,
        seats: plan.maxEmployees,
      },
    });

    const user = await tx.user.create({
      data: {
        companyId: company.id,
        email: input.adminEmail,
        passwordHash,
        fullName: input.adminFullName,
        // El fundador aun no tiene numero de empleado asignado por RRHH.
        employeeCode: "ADMIN-001",
        jobTitle: "Administrador de Recursos Humanos",
        phone: input.adminPhone ?? null,
        role: UserRole.HR_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        hiredAt: new Date(),
      },
      select: USER_SELECT,
    });

    return user;
  });

  const tokens = await issueSession(created, meta);
  return { user: toAuthenticatedUser(created), tokens };
}

export async function login(
  input: LoginInput,
  meta: SessionMeta,
): Promise<{ user: AuthenticatedUser; tokens: AuthTokens }> {
  const user = await system.user.findUnique({
    where: { email: input.email },
    select: USER_SELECT,
  });

  // Se verifica la contrasena aunque el usuario no exista para que el tiempo
  // de respuesta no revele que correos estan dados de alta.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? null);

  if (!user || !valid) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS, "Correo o contrasena incorrectos");
  }

  if (user.status === UserStatus.INVITED) {
    throw new AppError(
      ErrorCode.USER_SUSPENDED,
      "Aun no has activado tu cuenta. Revisa la invitacion que te enviamos.",
    );
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError(ErrorCode.USER_SUSPENDED, "Tu cuenta no esta activa");
  }
  // Se comprueba con `canOperate`, no con una igualdad a ACTIVE: una empresa
  // en periodo de gracia tras un cobro fallido sigue pudiendo entrar.
  if (!canOperate(user.company.accountStatus as AccountStatus)) {
    throw new AppError(
      ErrorCode.SUBSCRIPTION_INACTIVE,
      "La cuenta de tu empresa esta suspendida. Contacta con el administrador.",
    );
  }

  const tokens = await issueSession(user, meta);

  await system.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await system.auditLog.create({
    data: {
      companyId: user.companyId,
      entityType: "User",
      recordId: user.id,
      action: "LOGIN",
      modifiedByUserId: user.id,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  return { user: toAuthenticatedUser(user), tokens };
}

/**
 * Rotacion de refresh tokens con deteccion de reutilizacion.
 *
 * Cada refresco invalida el token usado y emite uno nuevo. Si llega un token
 * que ya fue rotado, solo hay dos explicaciones: o el atacante esta usando un
 * token robado, o la victima esta usando el suyo despues de que se lo robaran.
 * No se puede distinguir cual es cual, asi que se revocan TODAS las sesiones
 * del usuario y se obliga a volver a iniciar sesion. Es la respuesta estandar
 * (OAuth 2.0 BCP) y prefiere molestar al usuario legitimo antes que dejar viva
 * una sesion comprometida.
 */
export async function refresh(refreshToken: string, meta: SessionMeta): Promise<AuthTokens> {
  const payload = verifyRefreshToken(refreshToken);
  const tokenHash = hashToken(refreshToken);

  const session = await system.session.findUnique({
    where: { id: payload.sid },
    select: {
      id: true,
      refreshTokenHash: true,
      revokedAt: true,
      expiresAt: true,
      userId: true,
      companyId: true,
      user: { select: { id: true, companyId: true, role: true, status: true } },
    },
  });

  if (!session) {
    throw new AppError(ErrorCode.TOKEN_REVOKED, "La sesion ya no existe");
  }

  const isCurrentToken = session.refreshTokenHash === tokenHash;

  if (session.revokedAt || !isCurrentToken) {
    // Token ya rotado o revocado: se asume compromiso y se corta todo.
    await system.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await system.auditLog.create({
      data: {
        companyId: session.companyId,
        entityType: "Session",
        recordId: session.id,
        action: "DELETE",
        modifiedByUserId: session.userId,
        reason:
          "Reutilizacion de refresh token detectada: se revocaron todas las sesiones del usuario",
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
    throw new AppError(
      ErrorCode.TOKEN_REVOKED,
      "Se detecto un uso anomalo de la sesion. Vuelve a iniciar sesion.",
    );
  }

  if (session.expiresAt < new Date()) {
    throw new AppError(ErrorCode.TOKEN_EXPIRED, "La sesion ha expirado, vuelve a iniciar sesion");
  }
  if (session.user.status !== UserStatus.ACTIVE) {
    throw new AppError(ErrorCode.USER_SUSPENDED, "Tu cuenta no esta activa");
  }

  const tokens = await issueSession(session.user, meta);

  // La sesion anterior queda encadenada a la nueva: el rastro completo de
  // rotaciones queda reconstruible ante una investigacion.
  const newSid = verifyRefreshToken(tokens.refreshToken).sid;
  await system.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), replacedBySessionId: newSid },
  });

  return tokens;
}

/**
 * Login biometrico.
 *
 * El servidor NO recibe datos biometricos. La huella o Face ID desbloquean el
 * keychain seguro del dispositivo, que libera el refresh token guardado; a
 * partir de ahi el flujo es exactamente el de un refresco normal. Guardar o
 * transmitir plantillas biometricas seria un riesgo innecesario y una carga
 * regulatoria que no aporta nada.
 */
export async function biometricAuth(
  refreshToken: string,
  meta: SessionMeta,
): Promise<AuthTokens> {
  return refresh(refreshToken, meta);
}

export async function logout(refreshToken: string): Promise<void> {
  const payload = verifyRefreshToken(refreshToken);
  await system.session.updateMany({
    where: { id: payload.sid, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getProfile(userId: string, companyId: string): Promise<AuthenticatedUser> {
  const user = await system.user.findFirst({
    where: { id: userId, companyId },
    select: USER_SELECT,
  });
  if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Usuario no encontrado");
  return toAuthenticatedUser(user);
}

export async function changePassword(
  userId: string,
  companyId: string,
  input: ChangePasswordInput,
): Promise<void> {
  const user = await system.user.findFirst({
    where: { id: userId, companyId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new AppError(ErrorCode.NOT_FOUND, "Usuario no encontrado");

  const valid = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!valid) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS, "La contrasena actual no es correcta");
  }

  await system.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });

  // Un cambio de contrasena cierra el resto de dispositivos: es la accion que
  // hace un usuario justo despues de sospechar que le han robado la cuenta.
  await system.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Un empleado invitado fija su contrasena y activa su cuenta. */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  meta: SessionMeta,
): Promise<{ user: AuthenticatedUser; tokens: AuthTokens }> {
  const user = await system.user.findUnique({
    where: { invitationTokenHash: hashToken(input.token) },
    select: { ...USER_SELECT, invitationExpiresAt: true },
  });

  if (!user || user.status !== UserStatus.INVITED) {
    throw new AppError(ErrorCode.NOT_FOUND, "La invitacion no es valida o ya fue utilizada");
  }
  if (user.invitationExpiresAt && user.invitationExpiresAt < new Date()) {
    throw new AppError(ErrorCode.NOT_FOUND, "La invitacion ha caducado. Pide una nueva a RRHH.");
  }

  const activated = await system.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName ?? user.fullName,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      invitationTokenHash: null,
      invitationExpiresAt: null,
    },
    select: USER_SELECT,
  });

  const tokens = await issueSession(activated, meta);
  return { user: toAuthenticatedUser(activated), tokens };
}

export async function listSessions(userId: string, companyId: string) {
  const sessions = await system.session.findMany({
    where: { userId, companyId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      deviceId: true,
      deviceName: true,
      ipAddress: true,
      userAgent: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { lastUsedAt: "desc" },
  });
  return sessions;
}

export async function revokeSession(
  sessionId: string,
  userId: string,
  companyId: string,
): Promise<void> {
  const result = await system.session.updateMany({
    where: { id: sessionId, userId, companyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    throw new AppError(ErrorCode.NOT_FOUND, "Sesion no encontrada");
  }
}
