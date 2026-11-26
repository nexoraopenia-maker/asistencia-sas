import { SubscriptionTier, VerificationStatus } from "@scire/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  punchBody,
  request,
  seedTodayShifts,
  system,
  limaTimeOffset,
  type TestTenant,
} from "../../test/helpers.js";
import { getComparator, processPendingVerifications, verifyRecord } from "./face-match.service.js";

/**
 * Tests de verificacion facial.
 *
 * Usan el comparador local (sin credenciales de AWS). Es determinista a
 * proposito: una puntuacion aleatoria haria que un mismo caso pasara unas
 * veces y fallara otras, y un test asi no prueba nada.
 *
 * Convencion del sustituto: una clave con "nomatch" simula desajuste facial y
 * una con "noface" una selfie sin rostro utilizable.
 */

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Empresa ENTERPRISE con face-match activo y fotos de perfil sembradas. */
async function enterpriseTenant(minScore = 80) {
  const tenant = await createTestTenant({ tier: SubscriptionTier.ENTERPRISE });
  await system.company.update({
    where: { id: tenant.companyId },
    data: { faceMatchEnabled: true, faceMatchMinScore: minScore, requireSelfie: false },
  });
  await system.user.updateMany({
    where: { companyId: tenant.companyId },
    data: { profilePhotoKey: `profiles/${tenant.companyId}/oficial.jpg` },
  });
  await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId, limaTimeOffset(0));
  return tenant;
}

/** Crea una marcacion con una clave de selfie controlada. */
async function punchWithSelfie(tenant: TestTenant, selfieName: string) {
  const record = await system.attendanceRecord.create({
    data: {
      companyId: tenant.companyId,
      userId: tenant.employee.id,
      branchId: tenant.branchId,
      punchType: "IN",
      source: "MOBILE",
      serverTimestamp: new Date(),
      deviceTimestamp: new Date(),
      clockSkewSeconds: 0,
      selfieObjectKey: `punches/${tenant.companyId}/${tenant.employee.id}/${selfieName}.jpg`,
      latitude: -12.046374,
      longitude: -77.042793,
      isWithinGeofence: true,
      verificationStatus: VerificationStatus.PENDING,
      clientPunchId: crypto.randomUUID(),
    },
    select: { id: true },
  });
  return record.id;
}

describe("comparador activo", () => {
  it("sin credenciales de AWS usa el sustituto local", () => {
    // El entorno de test no tiene credenciales reales: exigirlas obligaria a
    // cada persona del equipo a tener una cuenta de AWS para ejecutar tests.
    expect(getComparator().id).toBe("local-stub");
  });

  it("el sustituto es determinista", async () => {
    const input = { selfieKey: "a/b/selfie.jpg", profileKey: "p/perfil.jpg", minScore: 80 };
    const first = await getComparator().compare(input);
    const second = await getComparator().compare(input);
    expect(first.score).toBe(second.score);
  });
});

describe("coincidencia exitosa", () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await enterpriseTenant();
  });
  afterAll(() => tenant.cleanup());

  it("verifica la marcacion y guarda la puntuacion", async () => {
    const recordId = await punchWithSelfie(tenant, "buena");
    const outcome = await verifyRecord(recordId);

    expect(outcome.status).toBe(VerificationStatus.VERIFIED);
    expect(outcome.score).toBeGreaterThanOrEqual(80);
    expect(outcome.score).toBeLessThanOrEqual(100);

    const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(stored.verificationStatus).toBe(VerificationStatus.VERIFIED);
    expect(stored.faceMatchScore).toBe(outcome.score);
    expect(stored.faceMatchedAt).toBeInstanceOf(Date);
  });

  it("la puntuacion tiene dos decimales, no un entero", async () => {
    const recordId = await punchWithSelfie(tenant, "decimales");
    const outcome = await verifyRecord(recordId);
    // El rango 0.00-100.00 que pide el contrato.
    expect(outcome.score).toBe(Math.round(outcome.score! * 100) / 100);
  });
});

describe("desajuste facial", () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await enterpriseTenant();
  });
  afterAll(() => tenant.cleanup());

  it("marca como sospechosa SIN truncar el registro legal", async () => {
    const recordId = await punchWithSelfie(tenant, "nomatch-intruso");
    const outcome = await verifyRecord(recordId);

    expect(outcome.status).toBe(VerificationStatus.SUSPICIOUS);
    expect(outcome.score).toBeLessThan(80);

    const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } });
    // La marcacion sigue existiendo con su hora, ubicacion y selfie: una
    // marcacion rechazada por face-match sigue siendo documentacion laboral.
    expect(stored.verificationStatus).toBe(VerificationStatus.SUSPICIOUS);
    expect(stored.isVoided).toBe(false);
    expect(stored.selfieObjectKey).toBeTruthy();
    expect(stored.serverTimestamp).toBeInstanceOf(Date);
    expect(stored.latitude).toBeCloseTo(-12.046374, 5);
  });

  it("una selfie sin rostro utilizable se rechaza para revision", async () => {
    const recordId = await punchWithSelfie(tenant, "noface-borrosa");
    const outcome = await verifyRecord(recordId);

    expect(outcome.status).toBe(VerificationStatus.REJECTED);
    expect(outcome.reason).toContain("rostro");

    const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(stored.isVoided).toBe(false);
  });

  it("el umbral de la empresa decide, no el proveedor", async () => {
    // Con el umbral al maximo, hasta una coincidencia buena queda sospechosa.
    const strict = await enterpriseTenant(99.99);
    try {
      const recordId = await punchWithSelfie(strict, "buena");
      const outcome = await verifyRecord(recordId);
      expect(outcome.status).toBe(VerificationStatus.SUSPICIOUS);
    } finally {
      await strict.cleanup();
    }
  });
});

describe("sin foto de perfil previa", () => {
  it("queda sospechosa, no rechazada: el problema es administrativo", async () => {
    const tenant = await enterpriseTenant();
    try {
      await system.user.update({
        where: { id: tenant.employee.id },
        data: { profilePhotoKey: null },
      });

      const recordId = await punchWithSelfie(tenant, "sin-patron");
      const outcome = await verifyRecord(recordId);

      // No hay indicio de fraude: falta subir la foto oficial.
      expect(outcome.status).toBe(VerificationStatus.SUSPICIOUS);
      expect(outcome.score).toBeNull();
      expect(outcome.reason).toContain("foto de perfil");

      const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } });
      expect(stored.faceMatchScore).toBeNull();
      expect(stored.verificationStatus).toBe(VerificationStatus.SUSPICIOUS);
    } finally {
      await tenant.cleanup();
    }
  });

  it("una marcacion sin selfie se da por verificada", async () => {
    const tenant = await enterpriseTenant();
    try {
      const record = await system.attendanceRecord.create({
        data: {
          companyId: tenant.companyId,
          userId: tenant.employee.id,
          branchId: tenant.branchId,
          punchType: "IN",
          source: "MOBILE",
          serverTimestamp: new Date(),
          deviceTimestamp: new Date(),
          clockSkewSeconds: 0,
          verificationStatus: VerificationStatus.PENDING,
          clientPunchId: crypto.randomUUID(),
        },
        select: { id: true },
      });

      const outcome = await verifyRecord(record.id);
      expect(outcome.status).toBe(VerificationStatus.VERIFIED);
      expect(outcome.reason).toContain("sin selfie");
    } finally {
      await tenant.cleanup();
    }
  });
});

describe("feature gating", () => {
  it("una empresa BUSINESS no ejecuta face-match aunque tenga el flag activo", async () => {
    const business = await createTestTenant({ tier: SubscriptionTier.BUSINESS });
    try {
      // El flag existe pero el plan no incluye la funcionalidad.
      await system.company.update({
        where: { id: business.companyId },
        data: { faceMatchEnabled: true },
      });
      await system.user.updateMany({
        where: { companyId: business.companyId },
        data: { profilePhotoKey: "profiles/x/oficial.jpg" },
      });

      const recordId = await punchWithSelfie(business, "nomatch-deberia-fallar");
      const outcome = await verifyRecord(recordId);

      expect(outcome.status).toBe(VerificationStatus.VERIFIED);
      expect(outcome.reason).toContain("no esta habilitada");
      expect(outcome.score).toBeNull();
    } finally {
      await business.cleanup();
    }
  });

  it("el trabajador solo recoge marcaciones de empresas ENTERPRISE", async () => {
    const [enterprise, business] = await Promise.all([
      enterpriseTenant(),
      createTestTenant({ tier: SubscriptionTier.BUSINESS }),
    ]);
    try {
      await system.company.update({
        where: { id: business.companyId },
        data: { faceMatchEnabled: true },
      });
      const businessRecord = await punchWithSelfie(business, "ignorada");
      await punchWithSelfie(enterprise, "procesada");

      await processPendingVerifications();

      const stored = await system.attendanceRecord.findUniqueOrThrow({
        where: { id: businessRecord },
      });
      // Recorrer todas las marcaciones del sistema para descartarlas por plan
      // seria trabajo tirado: el filtro va en la consulta.
      expect(stored.faceMatchedAt).toBeNull();
      expect(stored.verificationStatus).toBe(VerificationStatus.PENDING);
    } finally {
      await Promise.all([enterprise.cleanup(), business.cleanup()]);
    }
  });
});

describe("flujo completo desde la marcacion", () => {
  it("la marcacion nace PENDING y el trabajador la resuelve", async () => {
    const tenant = await enterpriseTenant();
    try {
      const body = punchBody(tenant.branchId, "IN", {
        selfieObjectKey: `punches/${tenant.companyId}/${tenant.employee.id}/vivo.jpg`,
      });

      // Sin almacenamiento configurado el servidor no puede comprobar que la
      // selfie llego, asi que se crea la marcacion sin clave y se asocia
      // despues: lo que se ejercita aqui es el ciclo de verificacion.
      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send({ ...body, selfieObjectKey: undefined })
        .expect(201);

      await system.attendanceRecord.update({
        where: { id: response.body.data.recordId },
        data: {
          selfieObjectKey: `punches/${tenant.companyId}/${tenant.employee.id}/vivo.jpg`,
          verificationStatus: VerificationStatus.PENDING,
        },
      });

      const result = await processPendingVerifications();
      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(result.verified).toBeGreaterThanOrEqual(1);

      const stored = await system.attendanceRecord.findUniqueOrThrow({
        where: { id: response.body.data.recordId },
      });
      expect(stored.verificationStatus).toBe(VerificationStatus.VERIFIED);
      expect(stored.faceMatchScore).toBeGreaterThan(0);
    } finally {
      await tenant.cleanup();
    }
  });

  it("una marcacion ya sospechosa por GPS falso no espera al face-match", async () => {
    const tenant = await enterpriseTenant();
    try {
      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(
          punchBody(tenant.branchId, "IN", {
            location: {
              latitude: -12.046374,
              longitude: -77.042793,
              accuracyMeters: 10,
              isMockLocation: true,
            },
          }),
        )
        .expect(201);

      // Una senal de fraude gana sobre la verificacion pendiente: no tiene
      // sentido esperar a Rekognition para marcar lo que ya es sospechoso.
      expect(response.body.data.verificationStatus).toBe(VerificationStatus.SUSPICIOUS);
    } finally {
      await tenant.cleanup();
    }
  });
});
