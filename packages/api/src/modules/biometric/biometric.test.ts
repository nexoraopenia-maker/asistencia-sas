import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  request,
  system,
  todayInLima,
  type TestTenant,
} from "../../test/helpers.js";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const deviceAuth = (token: string) => ({ "X-Device-Key": token });

let tenant: TestTenant;
let other: TestTenant;
let deviceToken: string;
let deviceId: string;
let employeeCode: string;
let otherEmployeeCode: string;

/** Fecha de Lima desplazada `offset` dias respecto a hoy. Cada test usa su dia. */
function limaDay(offset: number): string {
  const base = new Date(`${todayInLima()}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

async function seedShifts(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  await system.shift.createMany({
    data: [
      { companyId: tenant.companyId, userId: tenant.employee.id, branchId: tenant.branchId, date, type: "WORK", startTime: "09:00:00", endTime: "18:00:00" },
      { companyId: tenant.companyId, userId: tenant.employee.id, branchId: tenant.branchId, date, type: "LUNCH", startTime: "13:00:00", endTime: "14:00:00" },
    ],
    skipDuplicates: true,
  });
}

function push(punches: unknown[], token = deviceToken) {
  return request(tenant.app).post("/api/v1/biometric/punches").set(deviceAuth(token)).send({ punches });
}

beforeAll(async () => {
  tenant = await createTestTenant();
  other = await createTestTenant();

  const created = await request(tenant.app)
    .post("/api/v1/biometric/devices")
    .set(auth(tenant.hrAdmin.accessToken))
    .send({ name: "Reloj recepcion", serialNumber: "ZK-0001", branchId: tenant.branchId })
    .expect(201);
  deviceToken = created.body.data.token;
  deviceId = created.body.data.device.id;

  employeeCode = (await system.user.findUniqueOrThrow({ where: { id: tenant.employee.id } })).employeeCode;
  otherEmployeeCode = (await system.user.findUniqueOrThrow({ where: { id: other.employee.id } }))
    .employeeCode;
});

afterAll(async () => {
  await tenant.cleanup();
  await other.cleanup();
});

describe("dispositivos", () => {
  it("guarda solo el hash: el listado no expone el token", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/biometric/devices")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
    const device = response.body.data[0];
    expect(device.tokenPrefix).toBe(deviceToken.slice(0, 14));
    expect(JSON.stringify(response.body)).not.toContain(deviceToken);
  });

  it("el ping identifica empresa y dispositivo", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/biometric/ping")
      .set(deviceAuth(deviceToken))
      .expect(200);
    expect(response.body.data.device.id).toBe(deviceId);
    expect(response.body.data.company.timezone).toBe("America/Lima");
  });

  it("rechaza un token inventado", async () => {
    await push([{ employeeCode, timestamp: `${limaDay(-1)} 09:00:00` }], "scire_dev_inventado").expect(401);
  });

  it("un empleado no puede importar ni gestionar relojes", async () => {
    await request(tenant.app)
      .post("/api/v1/biometric/punches")
      .set(auth(tenant.employee.accessToken))
      .send({ punches: [{ employeeCode, timestamp: `${limaDay(-1)} 09:00:00` }] })
      .expect(403);
    await request(tenant.app)
      .post("/api/v1/biometric/devices")
      .set(auth(tenant.employee.accessToken))
      .send({ name: "Pirata" })
      .expect(403);
  });
});

describe("recepcion de marcaciones", () => {
  it("deduce la jornada completa y convierte la hora local del reloj", async () => {
    const day = limaDay(-1);
    await seedShifts(day);

    // Enviadas desordenadas a proposito: el servidor las ordena por hora.
    const response = await push([
      { employeeCode, timestamp: `${day} 18:02:10`, verifyMode: "FINGERPRINT" },
      { employeeCode, timestamp: `${day} 09:25:00`, deviceLogId: "1001" },
      { employeeCode, timestamp: `${day} 13:01:00` },
      { employeeCode, timestamp: `${day} 13:58:30` },
    ]).expect(200);

    const { results, created } = response.body.data;
    expect(created).toBe(4);
    expect(results.map((r: { punchType: string }) => r.punchType)).toEqual([
      "OUT",
      "IN",
      "LUNCH_START",
      "LUNCH_END",
    ]);
    // Lima es UTC-5.
    expect(results[1].serverTimestamp).toBe(`${day}T14:25:00.000Z`);

    const entry = await system.attendanceRecord.findUniqueOrThrow({ where: { id: results[1].recordId } });
    expect(entry.source).toBe("BIOMETRIC");
    expect(entry.verificationStatus).toBe("VERIFIED");
    expect(entry.biometricDeviceId).toBe(deviceId);
    expect(entry.branchId).toBe(tenant.branchId);
    expect(entry.isWithinGeofence).toBeNull();
    // Turno a las 09:00 con 10 min de tolerancia: 25 - 10 = 15.
    expect(entry.tardinessMinutes).toBe(15);
    expect(entry.notes).toContain("log 1001");
  });

  it("es idempotente: reenviar el lote no duplica nada", async () => {
    const day = limaDay(-1);
    const before = await system.attendanceRecord.count({ where: { userId: tenant.employee.id } });

    const response = await push([
      { employeeCode, timestamp: `${day} 09:25:00` },
      // Misma marcacion en ISO con zona y con milisegundos: sigue siendo la misma.
      { employeeCode, timestamp: `${day}T09:25:00.400-05:00` },
    ]).expect(200);

    expect(response.body.data.duplicates).toBe(2);
    expect(response.body.data.created).toBe(0);
    expect(await system.attendanceRecord.count({ where: { userId: tenant.employee.id } })).toBe(before);
  });

  it("trata la doble lectura del dedo como una sola marcacion", async () => {
    const day = limaDay(-2);
    const response = await push([
      { employeeCode, timestamp: `${day} 08:55:00` },
      { employeeCode, timestamp: `${day} 08:55:20` },
    ]).expect(200);
    expect(response.body.data.created).toBe(1);
    expect(response.body.data.results[1].status).toBe("duplicate");
    expect(response.body.data.results[1].recordId).toBe(response.body.data.results[0].recordId);
  });

  it("usa el tipo del reloj si encaja y lo corrige si rompe la secuencia", async () => {
    const day = limaDay(-3);
    const response = await push([
      // Primera del dia marcada como salida (tecla equivocada): se registra entrada.
      { employeeCode, timestamp: `${day} 08:50:00`, deviceState: 1 },
      // Sin turno de refrigerio ese dia, pero el reloj dice Break-Out: se respeta.
      { employeeCode, timestamp: `${day} 12:30:00`, deviceState: 2 },
    ]).expect(200);

    const [first, second] = response.body.data.results;
    expect(first.punchType).toBe("IN");
    expect(second.punchType).toBe("LUNCH_START");
    const entry = await system.attendanceRecord.findUniqueOrThrow({ where: { id: first.recordId } });
    expect(entry.notes).toContain("el reloj indico OUT");
  });

  it("rechaza lecturas despues de la salida sin tumbar el resto del lote", async () => {
    const day = limaDay(-4);
    const response = await push([
      { employeeCode, timestamp: `${day} 09:00:00` },
      { employeeCode, timestamp: `${day} 18:00:00` },
      { employeeCode, timestamp: `${day} 19:30:00` },
      { employeeCode: "NO-EXISTE", timestamp: `${day} 09:00:00` },
    ]).expect(200);

    const { results, created, rejected } = response.body.data;
    expect(created).toBe(2);
    expect(rejected).toBe(2);
    expect(results[2].error.code).toBe("INVALID_PUNCH_SEQUENCE");
    expect(results[3].error.code).toBe("NOT_FOUND");
  });

  it("no resucita una marcacion anulada al reimportar el log", async () => {
    const day = limaDay(-5);
    const first = await push([{ employeeCode, timestamp: `${day} 09:00:00` }]).expect(200);
    const recordId = first.body.data.results[0].recordId;
    await system.attendanceRecord.update({ where: { id: recordId }, data: { isVoided: true } });

    const again = await push([{ employeeCode, timestamp: `${day} 09:00:00` }]).expect(200);
    expect(again.body.data.results[0].status).toBe("duplicate");
    expect(again.body.data.results[0].recordId).toBe(recordId);
  });

  it("rechaza fechas futuras y demasiado antiguas", async () => {
    const response = await push([
      { employeeCode, timestamp: `${limaDay(2)} 09:00:00` },
      { employeeCode, timestamp: `${limaDay(-60)} 09:00:00` },
    ]).expect(200);
    expect(response.body.data.results.map((r: { error: { code: string } }) => r.error.code)).toEqual([
      "CLOCK_SKEW_TOO_LARGE",
      "CLOCK_SKEW_TOO_LARGE",
    ]);
  });

  it("valida el formato del lote", async () => {
    await push([{ employeeCode, timestamp: "25/11/2026 09:00" }]).expect(422);
    await push([]).expect(422);
  });
});

describe("aislamiento entre empresas", () => {
  it("el token de una empresa no ve empleados de otra", async () => {
    const response = await push([{ employeeCode: otherEmployeeCode, timestamp: `${limaDay(-6)} 09:00:00` }]);
    expect(response.status).toBe(200);
    // Los codigos son unicos por empresa; si coincidieran se resolveria al
    // empleado PROPIO, nunca al ajeno.
    const result = response.body.data.results[0];
    if (result.status === "created") {
      const entry = await system.attendanceRecord.findUniqueOrThrow({ where: { id: result.recordId } });
      expect(entry.companyId).toBe(tenant.companyId);
    } else {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    expect(await system.attendanceRecord.count({ where: { userId: other.employee.id } })).toBe(0);
  });

  it("no acepta una sucursal de otra empresa", async () => {
    const response = await push([
      { employeeCode, timestamp: `${limaDay(-6)} 10:00:00`, branchId: other.branchId },
    ]).expect(200);
    expect(response.body.data.results[0].error.code).toBe("NOT_FOUND");
  });
});

describe("importacion manual de RRHH y revocacion", () => {
  it("RRHH importa con su sesion y debe indicar la sucursal", async () => {
    const day = limaDay(-7);
    const response = await request(tenant.app)
      .post("/api/v1/biometric/punches")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({
        punches: [
          { employeeCode, timestamp: `${day} 09:00:00` },
          { employeeCode, timestamp: `${day} 18:00:00`, branchId: tenant.branchId },
        ],
      })
      .expect(200);
    expect(response.body.data.results[0].error.code).toBe("VALIDATION_ERROR");
    expect(response.body.data.results[1].status).toBe("created");

    const entry = await system.attendanceRecord.findUniqueOrThrow({
      where: { id: response.body.data.results[1].recordId },
    });
    expect(entry.biometricDeviceId).toBeNull();
    expect(entry.notes).toContain("importacion manual");
  });

  it("un reloj revocado deja de poder enviar", async () => {
    await request(tenant.app)
      .post(`/api/v1/biometric/devices/${deviceId}/revoke`)
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
    await push([{ employeeCode, timestamp: `${limaDay(-8)} 09:00:00` }]).expect(401);
  });
});
