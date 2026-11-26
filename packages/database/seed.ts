/**
 * Seed de datos iniciales — Scire 360 Chronos
 *
 * Ejecutar con:  pnpm db:seed
 *
 * Es IDEMPOTENTE: usa upsert sobre claves naturales, asi que puede correrse
 * tantas veces como haga falta sin duplicar datos.
 *
 * Usa el PrismaClient crudo (sin la extension de tenant) porque crea la propia
 * Company: en ese momento todavia no existe un tenant al que pertenecer.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { config as loadDotenv } from "dotenv";

// El seed se ejecuta con `tsx`, fuera del CLI de Prisma, asi que carga el .env
// de la raiz del monorepo por su cuenta antes de instanciar el cliente.
loadDotenv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

const prisma = new PrismaClient();

// -----------------------------------------------------------------------------
// Configuracion del entorno demo
// -----------------------------------------------------------------------------

const DEMO_COMPANY_SLUG = "corporacion-demo";
const DEMO_TIMEZONE = "America/Lima";
/** America/Lima es UTC-5 todo el ano (Peru no aplica horario de verano). */
const LIMA_UTC_OFFSET_HOURS = 5;

/** Sucursal central: Plaza San Martin, Lima. */
const BRANCH_LAT = -12.046374;
const BRANCH_LNG = -77.042793;
const BRANCH_RADIUS_M = 150;

/**
 * Contrasena de los usuarios demo. Configurable por entorno para que nadie
 * despliegue un demo con una contrasena conocida y hardcodeada.
 */
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "Chronos2026Demo!";
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);

// -----------------------------------------------------------------------------
// Helpers de fecha
// -----------------------------------------------------------------------------

/** Fecha (sin hora) en UTC a partir de `YYYY-MM-DD`. */
function dateOnly(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Convierte una hora local de Lima (`HH:mm:ss`) del dia `day` a un instante UTC. */
function limaToUtc(day: string, time: string): Date {
  const [h = "0", m = "0", s = "0"] = time.split(":");
  const utc = new Date(`${day}T00:00:00.000Z`);
  utc.setUTCHours(Number(h) + LIMA_UTC_OFFSET_HOURS, Number(m), Number(s), 0);
  return utc;
}

/** Los 7 dias (domingo -> sabado) de la semana que contiene `reference`. */
function weekDays(reference: Date): string[] {
  const sunday = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()),
  );
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setUTCDate(sunday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------

async function main() {
  console.log("🌱 Sembrando datos demo de Scire 360 Chronos...\n");

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);
  const now = new Date();
  const days = weekDays(now);
  const today = now.toISOString().slice(0, 10);

  const trialEndsAt = new Date(now);
  trialEndsAt.setDate(trialEndsAt.getDate() + 14);
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // --- Empresa -------------------------------------------------------------
  const company = await prisma.company.upsert({
    where: { slug: DEMO_COMPANY_SLUG },
    update: {},
    create: {
      name: "Corporacion Demo S.A.C.",
      slug: DEMO_COMPANY_SLUG,
      taxId: "20512345678",
      timezone: DEMO_TIMEZONE,
      lateToleranceMinutes: 10,
      earlyLeaveToleranceMinutes: 10,
      requireSelfie: true,
      requireGeofence: true,
      // Face-match requiere plan ENTERPRISE; el demo va en BUSINESS.
      faceMatchEnabled: false,
      faceMatchMinScore: 85,
      tier: "BUSINESS",
      maxEmployees: 50,
      accountStatus: "TRIALING",
      graceEndsAt: trialEndsAt,
    },
  });
  console.log(`✓ Empresa: ${company.name} (${company.id})`);

  // --- Suscripcion ---------------------------------------------------------
  await prisma.subscription.upsert({
    where: { companyId: company.id },
    update: {},
    create: {
      companyId: company.id,
      tier: "BUSINESS",
      status: "TRIALING",
      interval: "MONTHLY",
      provider: "MERCADOPAGO",
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      seats: 50,
      amountCents: 9_900,
      currency: "USD",
    },
  });
  console.log("✓ Suscripcion: BUSINESS en trial de 14 dias");

  // --- Sucursal con geocerca ----------------------------------------------
  const branch = await prisma.branch.upsert({
    where: { companyId_name: { companyId: company.id, name: "Sede Central" } },
    update: {},
    create: {
      companyId: company.id,
      name: "Sede Central",
      address: "Jr. de la Union 1050, Cercado de Lima",
      latitude: BRANCH_LAT,
      longitude: BRANCH_LNG,
      radiusMeters: BRANCH_RADIUS_M,
      timezone: DEMO_TIMEZONE,
      isActive: true,
    },
  });
  console.log(`✓ Sucursal: ${branch.name} — geocerca de ${branch.radiusMeters} m`);

  // --- Usuarios ------------------------------------------------------------
  const staff = [
    {
      email: "maria.fernandez@demo.scire360.com",
      fullName: "Maria Fernandez",
      employeeCode: "98451237",
      jobTitle: "Analista de Recursos Humanos",
      role: "HR_ADMIN" as const,
      phone: "+51987654321",
    },
    {
      email: "carlos.mendoza@demo.scire360.com",
      fullName: "Carlos Mendoza",
      employeeCode: "71205488",
      jobTitle: "Supervisor de Operaciones",
      role: "SUPERVISOR" as const,
      phone: "+51987654322",
    },
    {
      email: "lucia.rojas@demo.scire360.com",
      fullName: "Lucia Rojas",
      employeeCode: "44839012",
      jobTitle: "Asistente Administrativa",
      role: "EMPLOYEE" as const,
      phone: "+51987654323",
    },
    {
      email: "diego.paredes@demo.scire360.com",
      fullName: "Diego Paredes",
      employeeCode: "60117453",
      jobTitle: "Tecnico de Soporte",
      role: "EMPLOYEE" as const,
      phone: "+51987654324",
    },
  ];

  const hiredAt = new Date("2024-03-01T00:00:00.000Z");
  const users = [];
  for (const person of staff) {
    const user = await prisma.user.upsert({
      where: {
        companyId_employeeCode: { companyId: company.id, employeeCode: person.employeeCode },
      },
      update: {},
      create: {
        companyId: company.id,
        branchId: branch.id,
        email: person.email,
        passwordHash,
        fullName: person.fullName,
        employeeCode: person.employeeCode,
        jobTitle: person.jobTitle,
        phone: person.phone,
        role: person.role,
        status: "ACTIVE",
        hiredAt,
        emailVerifiedAt: hiredAt,
      },
    });
    users.push(user);
    console.log(`✓ Usuario: ${user.fullName} — ${user.jobTitle} (${user.employeeCode}) [${user.role}]`);
  }

  const maria = users[0]!;

  // --- Turnos de la semana en curso ---------------------------------------
  // Lunes a viernes: trabajo 09:00-18:00 con refrigerio 13:00-14:00.
  const WORK_START = "09:00:00";
  const WORK_END = "18:00:00";
  const LUNCH_START = "13:00:00";
  const LUNCH_END = "14:00:00";

  let shiftCount = 0;
  for (const user of users) {
    for (const day of days) {
      const weekday = dateOnly(day).getUTCDay();
      if (weekday === 0 || weekday === 6) continue; // domingo y sabado: descanso

      for (const block of [
        { type: "WORK" as const, startTime: WORK_START, endTime: WORK_END },
        { type: "LUNCH" as const, startTime: LUNCH_START, endTime: LUNCH_END },
      ]) {
        await prisma.shift.upsert({
          where: {
            companyId_userId_date_type_startTime: {
              companyId: company.id,
              userId: user.id,
              date: dateOnly(day),
              type: block.type,
              startTime: block.startTime,
            },
          },
          update: {},
          create: {
            companyId: company.id,
            userId: user.id,
            branchId: branch.id,
            date: dateOnly(day),
            type: block.type,
            startTime: block.startTime,
            endTime: block.endTime,
            createdById: maria.id,
          },
        });
        shiftCount++;
      }
    }
  }
  console.log(`✓ Turnos: ${shiftCount} tramos creados (Lun-Vie, trabajo + refrigerio)`);

  // --- Marcaciones de ejemplo ---------------------------------------------
  // Solo dias laborables ya transcurridos de esta semana.
  const pastWorkdays = days.filter((day) => {
    const weekday = dateOnly(day).getUTCDay();
    return weekday !== 0 && weekday !== 6 && day <= today;
  });

  interface PunchSpec {
    type: "IN" | "LUNCH_START" | "LUNCH_END" | "OUT";
    time: string;
    tardiness?: number;
    mock?: boolean;
    status?: "VERIFIED" | "SUSPICIOUS";
    distance?: number;
    inside?: boolean;
  }

  let punchCount = 0;
  for (const [dayIndex, day] of pastWorkdays.entries()) {
    for (const [userIndex, user] of users.entries()) {
      // Maria llega tarde el segundo dia laborable: alimenta la alerta de
      // tardanza del dashboard y el webhook de notificacion por WhatsApp.
      const isLateDay = userIndex === 0 && dayIndex === 1;
      // Diego marca con GPS simulado: alimenta la alerta de Mock Location.
      const isMockDay = userIndex === 3 && dayIndex === 0;

      const punches: PunchSpec[] = [
        {
          type: "IN",
          time: isLateDay ? "09:23:41" : `08:5${userIndex}:1${userIndex}`,
          tardiness: isLateDay ? 13 : 0,
          mock: isMockDay,
          status: isMockDay ? "SUSPICIOUS" : "VERIFIED",
        },
        { type: "LUNCH_START", time: "13:00:0" + userIndex },
        { type: "LUNCH_END", time: "13:5" + (5 + userIndex) + ":30" },
        { type: "OUT", time: `18:0${userIndex}:2${userIndex}` },
      ];

      for (const punch of punches) {
        const serverTimestamp = limaToUtc(day, punch.time);
        // El reloj del movil adelanta unos pocos segundos: desfase normal.
        const deviceTimestamp = new Date(serverTimestamp.getTime() + 2_000);

        const shift = await prisma.shift.findFirst({
          where: {
            companyId: company.id,
            userId: user.id,
            date: dateOnly(day),
            type: punch.type === "LUNCH_START" || punch.type === "LUNCH_END" ? "LUNCH" : "WORK",
          },
        });

        // clientPunchId determinista: hace el seed re-ejecutable sin duplicar.
        const clientPunchId = deterministicUuid(`${user.id}:${day}:${punch.type}`);

        await prisma.attendanceRecord.upsert({
          where: { companyId_clientPunchId: { companyId: company.id, clientPunchId } },
          update: {},
          create: {
            companyId: company.id,
            userId: user.id,
            branchId: branch.id,
            shiftId: shift?.id ?? null,
            punchType: punch.type,
            source: "MOBILE",
            serverTimestamp,
            deviceTimestamp,
            clockSkewSeconds: 2,
            selfieObjectKey: `${company.id}/${user.id}/${day}/${punch.type.toLowerCase()}.jpg`,
            latitude: BRANCH_LAT + (Math.random() - 0.5) * 0.0004,
            longitude: BRANCH_LNG + (Math.random() - 0.5) * 0.0004,
            accuracyMeters: 12 + Math.random() * 8,
            distanceMeters: punch.distance ?? Math.random() * 40,
            isWithinGeofence: punch.inside ?? true,
            isMockLocation: punch.mock ?? false,
            verificationStatus: punch.status ?? "VERIFIED",
            faceMatchScore: null,
            tardinessMinutes: punch.tardiness ?? 0,
            clientPunchId,
          },
        });
        punchCount++;
      }
    }
  }
  console.log(`✓ Marcaciones: ${punchCount} registros en ${pastWorkdays.length} dias laborables`);

  // --- Ausencia de ejemplo -------------------------------------------------
  const lucia = users[2]!;
  const existingAbsence = await prisma.absence.findFirst({
    where: { companyId: company.id, userId: lucia.id, type: "MEDICAL_LEAVE" },
  });
  if (!existingAbsence) {
    await prisma.absence.create({
      data: {
        companyId: company.id,
        userId: lucia.id,
        type: "MEDICAL_LEAVE",
        status: "PENDING",
        startDate: dateOnly(days[5]!),
        endDate: dateOnly(days[5]!),
        reason: "Descanso medico por consulta odontologica programada.",
        attachmentObjectKey: `${company.id}/${lucia.id}/justificantes/descanso-medico.pdf`,
      },
    });
    console.log("✓ Ausencia: 1 descanso medico pendiente de aprobacion");
  }

  // --- Entrada de auditoria de ejemplo ------------------------------------
  const lateRecord = await prisma.attendanceRecord.findFirst({
    where: { companyId: company.id, userId: maria.id, tardinessMinutes: { gt: 0 } },
  });
  if (lateRecord) {
    const alreadyAudited = await prisma.auditLog.findFirst({
      where: { companyId: company.id, recordId: lateRecord.id, action: "UPDATE" },
    });
    if (!alreadyAudited) {
      await prisma.auditLog.create({
        data: {
          companyId: company.id,
          entityType: "AttendanceRecord",
          recordId: lateRecord.id,
          action: "UPDATE",
          modifiedByUserId: maria.id,
          previousValue: { verificationStatus: "VERIFIED", tardinessMinutes: 13 },
          newValue: { verificationStatus: "MANUAL_OVERRIDE", tardinessMinutes: 0 },
          reason: "Tardanza justificada: retraso por comision de servicio autorizada.",
          ipAddress: "190.234.11.42",
          userAgent: "Scire360Web/0.1.0",
        },
      });
      console.log("✓ Auditoria: 1 ajuste manual registrado en AuditLog");
    }
  }

  // --- Endpoint de webhook -------------------------------------------------
  await prisma.webhookEndpoint.upsert({
    where: { companyId_name: { companyId: company.id, name: "n8n - Alertas RRHH" } },
    update: {},
    create: {
      companyId: company.id,
      name: "n8n - Alertas RRHH",
      url: process.env.N8N_WEBHOOK_URL ?? "https://n8n.example.com/webhook/scire360",
      // Secreto aleatorio por instalacion: nunca un valor fijo en el repositorio.
      secret: randomUUID().replace(/-/g, ""),
      events: ["punch.late", "punch.mock_location", "punch.missing", "absence.created"],
      isActive: true,
    },
  });
  console.log("✓ Webhook: endpoint de alertas hacia n8n / Evolution API");

  console.log(`
──────────────────────────────────────────────────────────
  Datos demo listos.

  Empresa    Corporacion Demo S.A.C.  (${DEMO_TIMEZONE})
  Sucursal   Sede Central — radio ${BRANCH_RADIUS_M} m
  Semana     ${days[0]} → ${days[6]}

  Acceso RRHH
    email      maria.fernandez@demo.scire360.com
    password   ${SEED_PASSWORD}

  Cambia la contrasena con la variable SEED_PASSWORD.
──────────────────────────────────────────────────────────
`);

  await seedPlatformAdmin();
}

/**
 * Operador de la plataforma (SUPER_ADMIN), para entrar en /admin.
 *
 * Solo se crea si se definen PLATFORM_ADMIN_EMAIL y PLATFORM_ADMIN_PASSWORD:
 * no hay credencial por defecto para el rol mas privilegiado del sistema. Vive
 * en su propio tenant interno para no mezclarse con los datos de ningun cliente.
 */
async function seedPlatformAdmin() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("· SUPER_ADMIN omitido: define PLATFORM_ADMIN_EMAIL y PLATFORM_ADMIN_PASSWORD");
    return;
  }

  const company = await prisma.company.upsert({
    where: { slug: "scire-platform" },
    update: {},
    create: {
      name: "Scire 360 (plataforma)",
      slug: "scire-platform",
      timezone: DEMO_TIMEZONE,
      tier: "ENTERPRISE",
      maxEmployees: 100_000,
      accountStatus: "ACTIVE",
    },
  });

  // `update: {}`: re-sembrar nunca pisa la contrasena que el operador ya cambio.
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      companyId: company.id,
      email,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      fullName: process.env.PLATFORM_ADMIN_NAME ?? "Administrador de plataforma",
      employeeCode: "PLATFORM-001",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });

  if (admin.role !== "SUPER_ADMIN") {
    console.warn(`⚠ ${email} ya existe con rol ${admin.role}; no se ha promovido a SUPER_ADMIN.`);
    return;
  }
  console.log(`✓ SUPER_ADMIN: ${admin.email} → entra en /admin`);
}

/** UUID v4 estable derivado de una semilla, para que el seed sea idempotente. */
function deterministicUuid(seed: string): string {
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 1597334677) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  const raw = hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0);
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    "4" + raw.slice(13, 16),
    "8" + raw.slice(17, 20),
    raw.slice(20, 32),
  ].join("-");
}

main()
  .catch((error) => {
    console.error("✗ El seed fallo:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
