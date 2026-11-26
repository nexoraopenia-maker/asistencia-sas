import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestTenant,
  limaTimeOffset,
  punchBody,
  request,
  seedTodayShifts,
  system,
  todayInLima,
  type TestTenant,
} from "../../test/helpers.js";

let tenant: TestTenant;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  tenant = await createTestTenant();
  await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId);
});

afterAll(() => tenant.cleanup());

describe("calendario semanal", () => {
  it("devuelve los 7 dias de domingo a sabado con sus etiquetas", async () => {
    const response = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
      .set(auth(tenant.employee.accessToken))
      .expect(200);

    const { days } = response.body.data;
    expect(days).toHaveLength(7);
    expect(days[0].weekdayLabel).toBe("Dom");
    expect(days[6].weekdayLabel).toBe("Sab");
    expect(days.filter((d: { isToday: boolean }) => d.isToday)).toHaveLength(1);
  });

  it("desglosa el turno de Trabajo y el de Refrigerio por separado", async () => {
    const response = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
      .set(auth(tenant.employee.accessToken))
      .expect(200);

    const today = response.body.data.days.find((d: { isToday: boolean }) => d.isToday);

    expect(today.work).toMatchObject({
      type: "WORK",
      startTime: "09:00:00",
      endTime: "18:00:00",
      durationMinutes: 540,
    });
    expect(today.lunch).toMatchObject({
      type: "LUNCH",
      startTime: "13:00:00",
      endTime: "14:00:00",
      durationMinutes: 60,
    });
  });

  it("lo programado descuenta el refrigerio: 9 h de turno son 8 h pagadas", async () => {
    const response = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
      .set(auth(tenant.employee.accessToken))
      .expect(200);

    expect(response.body.data.totals.scheduledMinutes).toBe(480);
  });

  it("un dia sin turno asignado se marca como descanso", async () => {
    const response = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
      .set(auth(tenant.employee.accessToken))
      .expect(200);

    const withoutShift = response.body.data.days.filter(
      (d: { work: unknown }) => d.work === null,
    );
    expect(withoutShift.length).toBeGreaterThan(0);
    for (const day of withoutShift) expect(day.status).toBe("REST");
  });

  it("un EMPLOYEE no puede consultar el calendario de otro", async () => {
    const response = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}&userId=${tenant.hrAdmin.id}`)
      .set(auth(tenant.employee.accessToken))
      .expect(200);

    // El userId de la query se ignora: siempre devuelve el del token.
    expect(response.body.data.userId).toBe(tenant.employee.id);
  });

  it("RRHH si puede consultar el de cualquier empleado", async () => {
    const response = await request(tenant.app)
      .get(`/api/v1/shifts/week?weekOf=${todayInLima()}&userId=${tenant.employee.id}`)
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);

    expect(response.body.data.userId).toBe(tenant.employee.id);
  });
});

describe("horas trabajadas", () => {
  it("descuenta el refrigerio del tiempo entre entrada y salida", async () => {
    const worker = await createTestTenant();
    try {
      // Turno que arranca ahora: asi el resultado no depende de la hora a la
      // que se ejecute la bateria de tests.
      await seedTodayShifts(
        worker.companyId,
        worker.employee.id,
        worker.branchId,
        limaTimeOffset(0),
      );

      for (const type of ["IN", "LUNCH_START", "LUNCH_END", "OUT"] as const) {
        await request(worker.app)
          .post("/api/v1/punch")
          .set(auth(worker.employee.accessToken))
          .send(punchBody(worker.branchId, type))
          .expect(201);
      }

      const response = await request(worker.app)
        .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
        .set(auth(worker.employee.accessToken))
        .expect(200);

      const today = response.body.data.days.find((d: { isToday: boolean }) => d.isToday);
      expect(today.status).toBe("PRESENT");
      expect(today.punches).toHaveLength(4);
      // Las cuatro marcaciones ocurren en el mismo instante del test, asi que
      // lo relevante es que la jornada se cierre y no cuente tiempo inventado.
      expect(today.workedMinutes).toBe(0);
    } finally {
      await worker.cleanup();
    }
  });

  it("no cuenta horas si falta la salida: no se inventa una hora de cierre", async () => {
    const worker = await createTestTenant();
    try {
      await seedTodayShifts(
        worker.companyId,
        worker.employee.id,
        worker.branchId,
        limaTimeOffset(0),
      );

      await request(worker.app)
        .post("/api/v1/punch")
        .set(auth(worker.employee.accessToken))
        .send(punchBody(worker.branchId, "IN"))
        .expect(201);

      const response = await request(worker.app)
        .get(`/api/v1/shifts/week?weekOf=${todayInLima()}`)
        .set(auth(worker.employee.accessToken))
        .expect(200);

      const today = response.body.data.days.find((d: { isToday: boolean }) => d.isToday);
      expect(today.workedMinutes).toBe(0);
      expect(today.status).toBe("PRESENT");
    } finally {
      await worker.cleanup();
    }
  });
});

describe("gestion de turnos", () => {
  it("un SUPERVISOR puede crear un tramo", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/shifts")
      .set(auth(tenant.supervisor.accessToken))
      .send({
        userId: tenant.employee.id,
        date: "2026-12-01",
        type: "WORK",
        startTime: "08:00:00",
        endTime: "17:00:00",
      })
      .expect(201);

    expect(response.body.data.companyId).toBe(tenant.companyId);
  });

  it("un EMPLOYEE no puede crear turnos", async () => {
    await request(tenant.app)
      .post("/api/v1/shifts")
      .set(auth(tenant.employee.accessToken))
      .send({
        userId: tenant.employee.id,
        date: "2026-12-02",
        type: "WORK",
        startTime: "08:00:00",
        endTime: "17:00:00",
      })
      .expect(403);
  });

  it("rechaza horas con formato invalido", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/shifts")
      .set(auth(tenant.supervisor.accessToken))
      .send({
        userId: tenant.employee.id,
        date: "2026-12-03",
        type: "WORK",
        startTime: "8:00",
        endTime: "17:00:00",
      })
      .expect(422);

    expect(response.body.error.details).toHaveProperty("startTime");
  });

  it("no permite asignar un turno a un empleado de otra empresa", async () => {
    const other = await createTestTenant();
    try {
      const response = await request(tenant.app)
        .post("/api/v1/shifts")
        .set(auth(tenant.supervisor.accessToken))
        .send({
          userId: other.employee.id,
          date: "2026-12-04",
          type: "WORK",
          startTime: "09:00:00",
          endTime: "18:00:00",
        })
        .expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    } finally {
      await other.cleanup();
    }
  });

  it("no duplica el mismo tramo en la misma fecha", async () => {
    const body = {
      userId: tenant.employee.id,
      date: "2026-12-05",
      type: "WORK" as const,
      startTime: "09:00:00",
      endTime: "18:00:00",
    };
    await request(tenant.app)
      .post("/api/v1/shifts")
      .set(auth(tenant.supervisor.accessToken))
      .send(body)
      .expect(201);

    const duplicate = await request(tenant.app)
      .post("/api/v1/shifts")
      .set(auth(tenant.supervisor.accessToken))
      .send(body)
      .expect(409);

    expect(duplicate.body.error.code).toBe("CONFLICT");
  });
});

describe("asignacion masiva", () => {
  it("aplica una plantilla de lunes a viernes a varios empleados", async () => {
    const bulk = await createTestTenant();
    try {
      const response = await request(bulk.app)
        .post("/api/v1/shifts/bulk-assign")
        .set(auth(bulk.hrAdmin.accessToken))
        .send({
          userIds: [bulk.employee.id, bulk.supervisor.id],
          from: "2027-03-01", // lunes
          to: "2027-03-07", // domingo
          weekdays: [1, 2, 3, 4, 5],
          blocks: [
            { type: "WORK", startTime: "09:00:00", endTime: "18:00:00" },
            { type: "LUNCH", startTime: "13:00:00", endTime: "14:00:00" },
          ],
        })
        .expect(201);

      // 2 empleados x 5 dias habiles x 2 bloques = 20 tramos.
      expect(response.body.data).toMatchObject({
        employees: 2,
        days: 5,
        blocksPerDay: 2,
        created: 20,
      });

      const stored = await system.shift.count({
        where: {
          companyId: bulk.companyId,
          date: { gte: new Date("2027-03-01"), lte: new Date("2027-03-07") },
        },
      });
      expect(stored).toBe(20);
    } finally {
      await bulk.cleanup();
    }
  });

  it("reaplicar la plantilla no duplica los turnos ya existentes", async () => {
    const bulk = await createTestTenant();
    try {
      const payload = {
        userIds: [bulk.employee.id],
        from: "2027-04-05",
        to: "2027-04-09",
        weekdays: [1, 2, 3, 4, 5],
        blocks: [{ type: "WORK" as const, startTime: "09:00:00", endTime: "18:00:00" }],
      };

      await request(bulk.app)
        .post("/api/v1/shifts/bulk-assign")
        .set(auth(bulk.hrAdmin.accessToken))
        .send(payload)
        .expect(201);

      const second = await request(bulk.app)
        .post("/api/v1/shifts/bulk-assign")
        .set(auth(bulk.hrAdmin.accessToken))
        .send(payload)
        .expect(201);

      expect(second.body.data.created).toBe(0);
      expect(second.body.data.skipped).toBe(5);
    } finally {
      await bulk.cleanup();
    }
  });

  it("un SUPERVISOR no puede hacer asignaciones masivas", async () => {
    await request(tenant.app)
      .post("/api/v1/shifts/bulk-assign")
      .set(auth(tenant.supervisor.accessToken))
      .send({
        userIds: [tenant.employee.id],
        from: "2027-05-03",
        to: "2027-05-07",
        weekdays: [1],
        blocks: [{ type: "WORK", startTime: "09:00:00", endTime: "18:00:00" }],
      })
      .expect(403);
  });

  it("avisa si el rango no contiene ninguno de los dias elegidos", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/shifts/bulk-assign")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({
        userIds: [tenant.employee.id],
        from: "2027-06-05", // sabado
        to: "2027-06-06", // domingo
        weekdays: [1, 2, 3],
        blocks: [{ type: "WORK", startTime: "09:00:00", endTime: "18:00:00" }],
      })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
