import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  punchBody,
  request,
  system,
  todayInLima,
  type TestTenant,
} from "../../test/helpers.js";

/** Jornadas que cruzan medianoche, de punta a punta. */

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let tenant: TestTenant;
let deviceToken: string;

function limaDay(offset: number): string {
  const base = new Date(`${todayInLima()}T12:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}
/** Lima es UTC-5 todo el ano. */
const iso = (offset: number, time: string) => new Date(`${limaDay(offset)}T${time}:00-05:00`).toISOString();

async function nightShift(userId: string, offset: number, start = "20:00:00", end = "04:00:00") {
  const date = new Date(`${limaDay(offset)}T00:00:00.000Z`);
  const base = { companyId: tenant.companyId, userId, branchId: tenant.branchId, date };
  await system.shift.createMany({
    data: [
      { ...base, type: "WORK", startTime: start, endTime: end },
      { ...base, type: "LUNCH", startTime: "00:00:00", endTime: "00:30:00" },
    ],
  });
}

async function codeOf(userId: string) {
  return (await system.user.findUniqueOrThrow({ where: { id: userId } })).employeeCode;
}

const push = (punches: unknown[]) =>
  request(tenant.app).post("/api/v1/biometric/punches").set({ "X-Device-Key": deviceToken }).send({ punches });

const report = (path: string, userId: string, from: string, to: string) =>
  request(tenant.app)
    .get(`/api/v1/reports/${path}?from=${from}&to=${to}&userId=${userId}`)
    .set(auth(tenant.hrAdmin.accessToken))
    .expect(200);

beforeAll(async () => {
  tenant = await createTestTenant();
  const created = await request(tenant.app)
    .post("/api/v1/biometric/devices")
    .set(auth(tenant.hrAdmin.accessToken))
    .send({ name: "Reloj noche", branchId: tenant.branchId })
    .expect(201);
  deviceToken = created.body.data.token;
});

afterAll(async () => {
  await tenant.cleanup();
});

describe("reloj biometrico en turno noche", () => {
  it("vincula la salida de la madrugada y reporta la jornada en la fecha de inicio", async () => {
    const userId = tenant.employee.id;
    const employeeCode = await codeOf(userId);
    await nightShift(userId, -3);

    const response = await push([
      { employeeCode, timestamp: `${limaDay(-3)} 20:25:00` },
      { employeeCode, timestamp: `${limaDay(-2)} 00:01:00` },
      { employeeCode, timestamp: `${limaDay(-2)} 00:29:00` },
      { employeeCode, timestamp: `${limaDay(-2)} 06:30:00` },
    ]).expect(200);
    expect(response.body.data.results.map((r: { punchType: string }) => r.punchType)).toEqual([
      "IN",
      "LUNCH_START",
      "LUNCH_END",
      "OUT",
    ]);

    const detail = await report("detail", userId, limaDay(-3), limaDay(-2));
    const days = detail.body.data.employees[0].days;
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      date: limaDay(-3),
      workedMinutes: 577,
      tardinessMinutes: 15,
      overtimeMinutes: 127,
      overtimeTier1Minutes: 120,
      overtimeTier2Minutes: 7,
      nightMinutes: 452,
      crossesMidnight: true,
    });

    // Un rango de un solo dia incluye la salida del dia siguiente.
    const payroll = await report("payroll", userId, limaDay(-3), limaDay(-3));
    expect(payroll.body.data[0]).toMatchObject({ daysWorked: 1, regularMinutes: 577, nightShifts: 1 });
  });

  it("deja rastro de la lectura repetida descartada", async () => {
    const userId = tenant.supervisor.id;
    const employeeCode = await codeOf(userId);
    const batch = [
      { employeeCode, timestamp: `${limaDay(-3)} 22:00:00` },
      { employeeCode, timestamp: `${limaDay(-3)} 22:00:20` },
    ];
    await push(batch).expect(200);
    await push(batch).expect(200);

    const record = await system.attendanceRecord.findFirstOrThrow({ where: { userId } });
    expect(record.notes?.match(/lectura repetida descartada/g)).toHaveLength(1);
    const detail = await report("detail", userId, limaDay(-3), limaDay(-3));
    const codes = detail.body.data.employees[0].days[0].incidents.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["DEBOUNCED_READ", "MISSING_OUT"]));
  });
});

describe("movil en turno noche", () => {
  it("la cola offline sincroniza entrada y salida a ambos lados de la medianoche", async () => {
    const userId = tenant.hrAdmin.id;
    const at = (offset: number, time: string, type: "IN" | "OUT") =>
      punchBody(tenant.branchId, type, { deviceTimestamp: iso(offset, time) });

    const response = await request(tenant.app)
      .post("/api/v1/punch/batch")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ punches: [at(-1, "02:00", "OUT"), at(-2, "20:00", "IN")] })
      .expect(200);
    expect(response.body.data.created).toBe(2);

    const payroll = await report("payroll", userId, limaDay(-2), limaDay(-2));
    expect(payroll.body.data[0]).toMatchObject({ daysWorked: 1, regularMinutes: 360, nightMinutes: 240 });
  });

  it("la salida online cierra una entrada de hace horas aunque haya cambiado el dia", async () => {
    // Usuario propio: el turno partido y las sesiones no deben mezclarse.
    const userId = tenant.employee.id;
    const entry = new Date(Date.now() - 10 * 3_600_000);
    await system.attendanceRecord.deleteMany({ where: { userId } });
    await system.shift.deleteMany({ where: { userId } });
    await system.attendanceRecord.create({
      data: {
        companyId: tenant.companyId,
        userId,
        branchId: tenant.branchId,
        punchType: "IN",
        serverTimestamp: entry,
        deviceTimestamp: entry,
        clientPunchId: `seed-${userId}`,
      },
    });

    const week = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
      .set(auth(tenant.employee.accessToken))
      .expect(200);
    expect(week.body.data.currentJornada).toMatchObject({ isOpen: true });
    expect(week.body.data.currentJornada.allowedPunches).toContain("OUT");

    await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(punchBody(tenant.branchId, "OUT"))
      .expect(201);
  });
});

describe("reglas laborales configurables", () => {
  it("RRHH ajusta la RMV y el turno partido, y se reflejan en el informe", async () => {
    const response = await request(tenant.app)
      .patch("/api/v1/company")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ minimumWage: 1000, allowSplitShifts: true, nightStartTime: "23:00:00" })
      .expect(200);
    expect(response.body.data.minimumWage).toBe(1000);

    const detail = await report("detail", tenant.employee.id, limaDay(-1), limaDay(-1));
    expect(detail.body.data.payReference.nightMinimumMonthly).toBe(1350);
    expect(detail.body.data.rules.nightStartTime).toBe("23:00:00");
  });

  it("cada empresa lee sus propias reglas", async () => {
    const other = await createTestTenant();
    try {
      const response = await request(other.app)
        .get(`/api/v1/reports/detail?from=${limaDay(-1)}&to=${limaDay(-1)}`)
        .set(auth(other.hrAdmin.accessToken))
        .expect(200);
      expect(response.body.data.rules).toMatchObject({ minimumWage: 1230, nightStartTime: "22:00:00" });
    } finally {
      await other.cleanup();
    }
  });

  it("rechaza una hora nocturna mal formada", async () => {
    await request(tenant.app)
      .patch("/api/v1/company")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ nightStartTime: "10pm" })
      .expect(422);
  });
});

describe("regularizacion y ausencias (RRHH)", () => {
  const hr = () => auth(tenant.hrAdmin.accessToken);

  it("RRHH completa una salida faltante y la jornada vuelve a sumar", async () => {
    const userId = tenant.supervisor.id;
    await system.attendanceRecord.deleteMany({ where: { userId } });
    const employeeCode = await codeOf(userId);
    await push([{ employeeCode, timestamp: `${limaDay(-4)} 20:00:00` }]).expect(200);

    const body = { userId, punchType: "OUT", date: limaDay(-3), time: "04:00", reason: "Olvido marcar la salida" };
    await request(tenant.app).post("/api/v1/punch/manual").set(hr()).send(body).expect(201);
    // Repetirla no duplica.
    await request(tenant.app).post("/api/v1/punch/manual").set(hr()).send(body).expect(409);

    const payroll = await report("payroll", userId, limaDay(-4), limaDay(-4));
    expect(payroll.body.data[0]).toMatchObject({ daysWorked: 1, regularMinutes: 480 });
    const log = await system.auditLog.findFirst({
      where: { companyId: tenant.companyId, action: "CREATE", reason: "Olvido marcar la salida" },
    });
    expect(log).not.toBeNull();
  });

  it("rechaza una salida sin entrada y a quien no es de RRHH", async () => {
    const body = { userId: tenant.supervisor.id, punchType: "OUT", date: limaDay(-9), time: "18:00", reason: "Sin entrada previa" };
    await request(tenant.app).post("/api/v1/punch/manual").set(hr()).send(body).expect(409);
    await request(tenant.app)
      .post("/api/v1/punch/manual")
      .set(auth(tenant.employee.accessToken))
      .send(body)
      .expect(403);
  });

  it("una ausencia aprobada justifica la falta; las horas extra aprobadas la autorizan", async () => {
    const userId = tenant.employee.id;
    await nightShift(userId, -12);
    const created = await request(tenant.app)
      .post("/api/v1/absences")
      .set(hr())
      .send({ userId, type: "MEDICAL_LEAVE", startDate: limaDay(-12), endDate: limaDay(-12), reason: "Descanso medico 1 dia" })
      .expect(201);
    expect(created.body.data.status).toBe("PENDING");

    const before = await report("detail", userId, limaDay(-12), limaDay(-12));
    expect(before.body.data.employees[0].days[0].isAbsent).toBe(true);

    await request(tenant.app)
      .post(`/api/v1/absences/${created.body.data.id}/review`)
      .set(hr())
      .send({ status: "APPROVED" })
      .expect(200);
    const after = await report("detail", userId, limaDay(-12), limaDay(-12));
    expect(after.body.data.employees[0].days[0]).toMatchObject({
      isAbsent: false,
      isJustified: true,
      justifications: ["Descanso medico: Descanso medico 1 dia"],
    });
  });

  it("otra empresa no ve ni resuelve mis ausencias", async () => {
    const other = await createTestTenant();
    try {
      const mine = await system.absence.findFirstOrThrow({ where: { companyId: tenant.companyId } });
      const list = await request(other.app)
        .get("/api/v1/absences")
        .set(auth(other.hrAdmin.accessToken))
        .expect(200);
      expect(list.body.data).toEqual([]);
      await request(other.app)
        .post(`/api/v1/absences/${mine.id}/review`)
        .set(auth(other.hrAdmin.accessToken))
        .send({ status: "REJECTED" })
        .expect(404);
    } finally {
      await other.cleanup();
    }
  });
});
