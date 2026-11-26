import { randomUUID } from "node:crypto";
import { getSystemClient } from "@scire/database";
import { AccountStatus, PLAN_LIMITS, type SubscriptionTier } from "@scire/shared";
import bcrypt from "bcryptjs";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../app.js";

/**
 * Utilidades para los tests de integracion.
 *
 * Cada suite crea su propio tenant con un sufijo unico y lo borra al terminar.
 * El `onDelete: Cascade` desde `Company` se lleva por delante sucursales,
 * usuarios, turnos y marcaciones, asi que no hace falta limpiar tabla a tabla.
 */

const system = getSystemClient();

export const TEST_PASSWORD = "TestChronos2026!";

/** Sucursal de referencia: Plaza San Martin, Lima. */
export const BRANCH_LOCATION = { latitude: -12.046374, longitude: -77.042793 };
export const BRANCH_RADIUS_M = 150;

/** A ~1.2 km del centro de la geocerca: claramente fuera. */
export const FAR_LOCATION = { latitude: -12.057, longitude: -77.042793 };

export interface TestTenant {
  app: Express;
  companyId: string;
  branchId: string;
  hrAdmin: TestUser;
  employee: TestUser;
  supervisor: TestUser;
  cleanup: () => Promise<void>;
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export async function createTestTenant(
  options: {
    tier?: SubscriptionTier;
    requireGeofence?: boolean;
    accountStatus?: AccountStatus;
    /** Sobreescribe la cuota del plan; util para probar el limite de asientos. */
    maxEmployees?: number;
  } = {},
): Promise<TestTenant> {
  const app = createApp();
  const suffix = randomUUID().slice(0, 8);
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  const company = await system.company.create({
    data: {
      name: `Test Co ${suffix}`,
      slug: `test-co-${suffix}`,
      timezone: "America/Lima",
      // Sin selfie: el bucket S3 no existe en el entorno de test y no es lo
      // que estos tests ejercitan.
      requireSelfie: false,
      requireGeofence: options.requireGeofence ?? true,
      lateToleranceMinutes: 10,
      tier: options.tier ?? "BUSINESS",
      // La cuota sale del catalogo de planes para que los tests no se
      // desincronicen de la tarifa real al cambiarla.
      maxEmployees:
        options.maxEmployees ?? PLAN_LIMITS[options.tier ?? "BUSINESS"].maxEmployees,
      accountStatus: options.accountStatus ?? AccountStatus.ACTIVE,
    },
  });

  const branch = await system.branch.create({
    data: {
      companyId: company.id,
      name: "Sede Test",
      latitude: BRANCH_LOCATION.latitude,
      longitude: BRANCH_LOCATION.longitude,
      radiusMeters: BRANCH_RADIUS_M,
    },
  });

  const makeUser = async (role: "HR_ADMIN" | "SUPERVISOR" | "EMPLOYEE", code: string) => {
    const user = await system.user.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        email: `${role.toLowerCase()}-${suffix}@test.scire360.com`,
        passwordHash,
        fullName: `Usuario ${role}`,
        employeeCode: code,
        role,
        status: "ACTIVE",
      },
    });

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    return {
      id: user.id,
      email: user.email,
      accessToken: response.body.data.tokens.accessToken as string,
      refreshToken: response.body.data.tokens.refreshToken as string,
    };
  };

  const hrAdmin = await makeUser("HR_ADMIN", `HR-${suffix}`);
  const supervisor = await makeUser("SUPERVISOR", `SV-${suffix}`);
  const employee = await makeUser("EMPLOYEE", `EM-${suffix}`);

  return {
    app,
    companyId: company.id,
    branchId: branch.id,
    hrAdmin,
    supervisor,
    employee,
    cleanup: async () => {
      await system.company.delete({ where: { id: company.id } });
    },
  };
}

/** Fecha de jornada de hoy en la zona de la empresa de prueba. */
export function todayInLima(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Hora local de Lima desplazada `offsetMinutes` respecto a ahora, en `HH:mm:ss`.
 *
 * Los tests que miden horas trabajadas siembran el turno arrancando "ahora"
 * para que la puntualidad no interfiera: si se fijara 09:00:00, el resultado
 * dependeria de la hora a la que se ejecute la bateria.
 */
export function limaTimeOffset(offsetMinutes = 0): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Date.now() + offsetMinutes * 60_000));
}

/** Crea el turno de trabajo y el refrigerio de hoy para un empleado. */
export async function seedTodayShifts(
  companyId: string,
  userId: string,
  branchId: string,
  workStart = "09:00:00",
): Promise<void> {
  const date = new Date(`${todayInLima()}T00:00:00.000Z`);
  await system.shift.createMany({
    data: [
      { companyId, userId, branchId, date, type: "WORK", startTime: workStart, endTime: "18:00:00" },
      { companyId, userId, branchId, date, type: "LUNCH", startTime: "13:00:00", endTime: "14:00:00" },
    ],
    skipDuplicates: true,
  });
}

/** Cuerpo de una marcacion valida, dentro de la geocerca. */
export function punchBody(
  branchId: string,
  punchType: "IN" | "OUT" | "LUNCH_START" | "LUNCH_END",
  overrides: Record<string, unknown> = {},
) {
  return {
    punchType,
    branchId,
    location: {
      // Unos 11 m al sur del centro: comodamente dentro del radio de 150 m.
      latitude: BRANCH_LOCATION.latitude - 0.0001,
      longitude: BRANCH_LOCATION.longitude,
      accuracyMeters: 12,
      isMockLocation: false,
    },
    deviceTimestamp: new Date().toISOString(),
    clientPunchId: randomUUID(),
    ...overrides,
  };
}

export { request, system };
