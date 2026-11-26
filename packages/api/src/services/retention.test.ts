import { VerificationStatus } from "@scire/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createTestTenant, system, type TestTenant } from "../test/helpers.js";
import {
  getRetentionStatus,
  purgeExpiredBiometrics,
  purgeUserBiometrics,
} from "./retention.service.js";

/**
 * Tests de retencion de datos biometricos.
 *
 * Sin almacenamiento S3 configurado, la purga desvincula la referencia sin
 * borrar el archivo (no hay archivo que borrar). Lo que se verifica aqui es
 * exactamente lo que importa desde el punto de vista de cumplimiento: que la
 * referencia a la imagen desaparece y que el registro laboral sobrevive.
 */

const tenants: TestTenant[] = [];

afterEach(async () => {
  await Promise.all(tenants.splice(0).map((tenant) => tenant.cleanup()));
});

async function tenantWith(retentionMonths: number): Promise<TestTenant> {
  const tenant = await createTestTenant();
  tenants.push(tenant);
  await system.company.update({
    where: { id: tenant.companyId },
    data: { dataRetentionMonths: retentionMonths },
  });
  return tenant;
}

/** Crea una marcacion con selfie fechada hace `monthsAgo` meses. */
async function punchAt(tenant: TestTenant, monthsAgo: number, label: string) {
  const at = new Date();
  at.setMonth(at.getMonth() - monthsAgo);

  return system.attendanceRecord.create({
    data: {
      companyId: tenant.companyId,
      userId: tenant.employee.id,
      branchId: tenant.branchId,
      punchType: "IN",
      source: "MOBILE",
      serverTimestamp: at,
      deviceTimestamp: at,
      clockSkewSeconds: 0,
      selfieObjectKey: `punches/${tenant.companyId}/${label}.jpg`,
      latitude: -12.046374,
      longitude: -77.042793,
      isWithinGeofence: true,
      tardinessMinutes: 7,
      verificationStatus: VerificationStatus.VERIFIED,
      clientPunchId: crypto.randomUUID(),
    },
    select: { id: true },
  });
}

describe("purga por plazo", () => {
  it("depura las selfies que superaron el plazo y respeta las recientes", async () => {
    const tenant = await tenantWith(12);
    const vieja = await punchAt(tenant, 18, "vieja");
    const reciente = await punchAt(tenant, 2, "reciente");

    const result = await purgeExpiredBiometrics({ companyId: tenant.companyId });
    expect(result.purged).toBe(1);

    const [purgada, intacta] = await Promise.all([
      system.attendanceRecord.findUniqueOrThrow({ where: { id: vieja.id } }),
      system.attendanceRecord.findUniqueOrThrow({ where: { id: reciente.id } }),
    ]);

    expect(purgada.selfieObjectKey).toBeNull();
    expect(purgada.selfiePurgedAt).toBeInstanceOf(Date);
    expect(intacta.selfieObjectKey).toBeTruthy();
    expect(intacta.selfiePurgedAt).toBeNull();
  });

  it("CONSERVA el registro laboral completo: solo desaparece la imagen", async () => {
    const tenant = await tenantWith(12);
    const record = await punchAt(tenant, 24, "antigua");

    await purgeExpiredBiometrics({ companyId: tenant.companyId });

    const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    // La documentacion laboral tiene plazos de conservacion propios, mucho mas
    // largos: destruirla dejaria a la empresa sin prueba de horas trabajadas.
    expect(stored.id).toBe(record.id);
    expect(stored.serverTimestamp).toBeInstanceOf(Date);
    expect(stored.punchType).toBe("IN");
    expect(stored.tardinessMinutes).toBe(7);
    expect(stored.latitude).toBeCloseTo(-12.046374, 5);
    expect(stored.verificationStatus).toBe(VerificationStatus.VERIFIED);
    // Solo la imagen se va.
    expect(stored.selfieObjectKey).toBeNull();
  });

  it("distingue 'nunca tuvo foto' de 'la tuvo y se purgo'", async () => {
    const tenant = await tenantWith(12);
    const conFoto = await punchAt(tenant, 20, "con-foto");
    const sinFoto = await system.attendanceRecord.create({
      data: {
        companyId: tenant.companyId,
        userId: tenant.employee.id,
        branchId: tenant.branchId,
        punchType: "OUT",
        source: "MOBILE",
        serverTimestamp: new Date(Date.now() - 600 * 86_400_000),
        deviceTimestamp: new Date(),
        clockSkewSeconds: 0,
        verificationStatus: VerificationStatus.VERIFIED,
        clientPunchId: crypto.randomUUID(),
      },
      select: { id: true },
    });

    await purgeExpiredBiometrics({ companyId: tenant.companyId });

    const [purgada, nunca] = await Promise.all([
      system.attendanceRecord.findUniqueOrThrow({ where: { id: conFoto.id } }),
      system.attendanceRecord.findUniqueOrThrow({ where: { id: sinFoto.id } }),
    ]);

    // Sin este campo, una auditoria no podria diferenciar una marcacion sin
    // verificar de una depurada conforme a la ley.
    expect(purgada.selfiePurgedAt).toBeInstanceOf(Date);
    expect(nunca.selfiePurgedAt).toBeNull();
  });

  it("cada empresa aplica SU plazo, no uno global", async () => {
    const corto = await tenantWith(3);
    const largo = await tenantWith(36);

    const enCorto = await punchAt(corto, 6, "corto");
    const enLargo = await punchAt(largo, 6, "largo");

    await purgeExpiredBiometrics();

    const [a, b] = await Promise.all([
      system.attendanceRecord.findUniqueOrThrow({ where: { id: enCorto.id } }),
      system.attendanceRecord.findUniqueOrThrow({ where: { id: enLargo.id } }),
    ]);

    expect(a.selfieObjectKey).toBeNull();
    expect(b.selfieObjectKey).toBeTruthy();
  });

  it("es idempotente: un segundo barrido no vuelve a tocar lo purgado", async () => {
    const tenant = await tenantWith(12);
    await punchAt(tenant, 18, "unica");

    const first = await purgeExpiredBiometrics({ companyId: tenant.companyId });
    const second = await purgeExpiredBiometrics({ companyId: tenant.companyId });

    expect(first.purged).toBe(1);
    expect(second.purged).toBe(0);
  });

  it("el modo simulacion informa sin borrar nada", async () => {
    const tenant = await tenantWith(12);
    const record = await punchAt(tenant, 18, "simulada");

    const result = await purgeExpiredBiometrics({ companyId: tenant.companyId, dryRun: true });
    expect(result.purged).toBe(1);

    // Es lo primero que se ejecuta al activar la politica: saber cuanto se
    // borraria antes de borrarlo.
    const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(stored.selfieObjectKey).toBeTruthy();
    expect(stored.selfiePurgedAt).toBeNull();
  });

  it("respeta el tamano de lote", async () => {
    const tenant = await tenantWith(12);
    for (let i = 0; i < 5; i++) await punchAt(tenant, 18, `lote-${i}`);

    const first = await purgeExpiredBiometrics({ companyId: tenant.companyId, batchSize: 2 });
    expect(first.purged).toBe(2);

    const remaining = await system.attendanceRecord.count({
      where: { companyId: tenant.companyId, selfieObjectKey: { not: null } },
    });
    expect(remaining).toBe(3);
  });
});

describe("derecho al olvido", () => {
  it("borra todas las selfies de un colaborador y su foto de perfil", async () => {
    const tenant = await tenantWith(120);
    await system.user.update({
      where: { id: tenant.employee.id },
      data: { profilePhotoKey: `profiles/${tenant.companyId}/oficial.jpg` },
    });

    const reciente = await punchAt(tenant, 1, "reciente");
    const antigua = await punchAt(tenant, 2, "antigua");

    // El plazo es de 120 meses: nada habria caducado por tiempo.
    const result = await purgeUserBiometrics(tenant.employee.id);
    expect(result.purged).toBe(2);

    const records = await system.attendanceRecord.findMany({
      where: { id: { in: [reciente.id, antigua.id] } },
    });
    for (const record of records) {
      expect(record.selfieObjectKey).toBeNull();
      expect(record.selfiePurgedAt).toBeInstanceOf(Date);
      // El registro de asistencia sobrevive: su base juridica es una
      // obligacion legal del empleador, no el consentimiento del interesado.
      expect(record.serverTimestamp).toBeInstanceOf(Date);
    }

    const user = await system.user.findUniqueOrThrow({ where: { id: tenant.employee.id } });
    expect(user.profilePhotoKey).toBeNull();
  });

  it("no toca a los demas colaboradores", async () => {
    const tenant = await tenantWith(120);
    const propia = await punchAt(tenant, 1, "propia");

    const ajena = await system.attendanceRecord.create({
      data: {
        companyId: tenant.companyId,
        userId: tenant.supervisor.id,
        branchId: tenant.branchId,
        punchType: "IN",
        source: "MOBILE",
        serverTimestamp: new Date(),
        deviceTimestamp: new Date(),
        clockSkewSeconds: 0,
        selfieObjectKey: `punches/${tenant.companyId}/ajena.jpg`,
        verificationStatus: VerificationStatus.VERIFIED,
        clientPunchId: crypto.randomUUID(),
      },
      select: { id: true },
    });

    await purgeUserBiometrics(tenant.employee.id);

    const [mia, suya] = await Promise.all([
      system.attendanceRecord.findUniqueOrThrow({ where: { id: propia.id } }),
      system.attendanceRecord.findUniqueOrThrow({ where: { id: ajena.id } }),
    ]);

    expect(mia.selfieObjectKey).toBeNull();
    expect(suya.selfieObjectKey).toBeTruthy();
  });
});

describe("estado de cumplimiento", () => {
  it("informa de lo almacenado, lo pendiente y lo ya depurado", async () => {
    const tenant = await tenantWith(12);
    await punchAt(tenant, 18, "caducada-1");
    await punchAt(tenant, 20, "caducada-2");
    await punchAt(tenant, 1, "vigente");

    const before = await getRetentionStatus(tenant.companyId);
    expect(before.retentionMonths).toBe(12);
    expect(before.selfiesStored).toBe(3);
    expect(before.pendingPurge).toBe(2);
    expect(before.alreadyPurged).toBe(0);

    await purgeExpiredBiometrics({ companyId: tenant.companyId });

    const after = await getRetentionStatus(tenant.companyId);
    expect(after.selfiesStored).toBe(1);
    expect(after.pendingPurge).toBe(0);
    expect(after.alreadyPurged).toBe(2);
  });

  it("el corte se calcula desde el plazo de la empresa", async () => {
    const tenant = await tenantWith(6);
    const status = await getRetentionStatus(tenant.companyId);

    const expected = new Date();
    expected.setMonth(expected.getMonth() - 6);
    const diffDays = Math.abs(
      (new Date(status.cutoffDate).getTime() - expected.getTime()) / 86_400_000,
    );
    expect(diffDays).toBeLessThan(1);
  });
});
