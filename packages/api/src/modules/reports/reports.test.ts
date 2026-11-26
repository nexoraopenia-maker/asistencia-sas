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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let tenant: TestTenant;

beforeAll(async () => {
  tenant = await createTestTenant();
  // Turno arrancando ahora: la puntualidad no debe depender de la hora a la
  // que se ejecute la bateria.
  await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId, limaTimeOffset(0));

  for (const type of ["IN", "LUNCH_START", "LUNCH_END", "OUT"] as const) {
    await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(punchBody(tenant.branchId, type))
      .expect(201);
  }
});

afterAll(() => tenant.cleanup());

describe("resumen de asistencia", () => {
  it("devuelve los KPIs del rango", async () => {
    const today = todayInLima();
    const response = await request(tenant.app)
      .get(`/api/v1/reports/summary?from=${today}&to=${today}`)
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);

    const data = response.body.data;
    expect(data.totalEmployees).toBe(3);
    expect(data.punctualityRate).toBe(100);
    expect(data.absenteeismRate).toBe(0);
    expect(data.daily).toHaveLength(1);
    expect(data.daily[0].present).toBe(1);
  });

  it("solo cuenta como ausencia los dias CON turno asignado", async () => {
    const quiet = await createTestTenant();
    try {
      // Nadie tiene turno: un dia sin jornada programada no es ausentismo.
      const today = todayInLima();
      const response = await request(quiet.app)
        .get(`/api/v1/reports/summary?from=${today}&to=${today}`)
        .set(auth(quiet.hrAdmin.accessToken))
        .expect(200);

      expect(response.body.data.absenteeismRate).toBe(0);
      expect(response.body.data.daily[0].absent).toBe(0);
    } finally {
      await quiet.cleanup();
    }
  });

  it("cuenta como ausente a quien tiene turno y no marco", async () => {
    const absent = await createTestTenant();
    try {
      await seedTodayShifts(absent.companyId, absent.employee.id, absent.branchId);
      const today = todayInLima();

      const response = await request(absent.app)
        .get(`/api/v1/reports/summary?from=${today}&to=${today}`)
        .set(auth(absent.hrAdmin.accessToken))
        .expect(200);

      expect(response.body.data.daily[0].absent).toBe(1);
      expect(response.body.data.absenteeismRate).toBe(100);
    } finally {
      await absent.cleanup();
    }
  });

  it("rechaza un rango invertido", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/reports/summary?from=2026-09-30&to=2026-09-01")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(422);
    expect(response.body.error.details).toHaveProperty("from");
  });

  it("un EMPLOYEE no puede consultar los KPIs de la empresa", async () => {
    const today = todayInLima();
    await request(tenant.app)
      .get(`/api/v1/reports/summary?from=${today}&to=${today}`)
      .set(auth(tenant.employee.accessToken))
      .expect(403);
  });
});

describe("nomina", () => {
  it("devuelve una fila por colaborador con el desglose completo", async () => {
    const today = todayInLima();
    const response = await request(tenant.app)
      .get(`/api/v1/reports/payroll?from=${today}&to=${today}`)
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);

    expect(response.body.data).toHaveLength(3);
    const row = response.body.data.find(
      (r: { userId: string }) => r.userId === tenant.employee.id,
    );
    expect(row).toMatchObject({ daysWorked: 1, daysAbsent: 0 });
    expect(row).toHaveProperty("regularMinutes");
    expect(row).toHaveProperty("lunchMinutes");
    expect(row).toHaveProperty("tardinessMinutes");
    expect(row).toHaveProperty("earlyLeaveMinutes");
    expect(row).toHaveProperty("overtimeMinutes");
    expect(row.branchName).toBe("Sede Test");
  });

  it("no cuenta el dia como trabajado si falta la salida", async () => {
    const partial = await createTestTenant();
    try {
      await seedTodayShifts(
        partial.companyId,
        partial.employee.id,
        partial.branchId,
        limaTimeOffset(0),
      );
      await request(partial.app)
        .post("/api/v1/punch")
        .set(auth(partial.employee.accessToken))
        .send(punchBody(partial.branchId, "IN"))
        .expect(201);

      const today = todayInLima();
      const response = await request(partial.app)
        .get(`/api/v1/reports/payroll?from=${today}&to=${today}`)
        .set(auth(partial.hrAdmin.accessToken))
        .expect(200);

      const row = response.body.data.find(
        (r: { userId: string }) => r.userId === partial.employee.id,
      );
      expect(row.daysWorked).toBe(0);
      expect(row.regularMinutes).toBe(0);
      // Tampoco es ausencia: si marco, estuvo.
      expect(row.daysAbsent).toBe(0);
    } finally {
      await partial.cleanup();
    }
  });

  it("no expone datos de otra empresa", async () => {
    const other = await createTestTenant();
    try {
      const today = todayInLima();
      const response = await request(other.app)
        .get(`/api/v1/reports/payroll?from=${today}&to=${today}`)
        .set(auth(other.hrAdmin.accessToken))
        .expect(200);

      const ids = response.body.data.map((r: { userId: string }) => r.userId);
      expect(ids).not.toContain(tenant.employee.id);
    } finally {
      await other.cleanup();
    }
  });

  it("un SUPERVISOR no puede exportar nomina", async () => {
    const today = todayInLima();
    await request(tenant.app)
      .get(`/api/v1/reports/payroll?from=${today}&to=${today}`)
      .set(auth(tenant.supervisor.accessToken))
      .expect(403);
  });
});

describe("suscripcion", () => {
  it("informa del consumo de asientos frente al cupo del plan", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/subscription")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);

    const { usage, plan } = response.body.data;
    expect(usage.seatsUsed).toBe(3);
    expect(usage.seatsLimit).toBe(50);
    expect(usage.seatsPercent).toBe(6);
    expect(plan.displayName).toBe("Business");
  });
});

describe("empresa y sucursales", () => {
  it("expone la configuracion de tolerancias", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/company")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
    expect(response.body.data.lateToleranceMinutes).toBe(10);
  });

  it("RRHH puede cambiar la tolerancia de tardanza", async () => {
    const response = await request(tenant.app)
      .patch("/api/v1/company")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ lateToleranceMinutes: 15 })
      .expect(200);
    expect(response.body.data.lateToleranceMinutes).toBe(15);

    await request(tenant.app)
      .patch("/api/v1/company")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ lateToleranceMinutes: 10 })
      .expect(200);
  });

  it("no deja activar face-match fuera del plan Enterprise", async () => {
    const response = await request(tenant.app)
      .patch("/api/v1/company")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ faceMatchEnabled: true })
      .expect(402);
    expect(response.body.error.code).toBe("FEATURE_NOT_IN_PLAN");
  });

  it("crea una sucursal con su geocerca", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/company/branches")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({
        name: "Sucursal Norte",
        latitude: -12.02,
        longitude: -77.05,
        radiusMeters: 200,
      })
      .expect(201);

    expect(response.body.data.radiusMeters).toBe(200);
  });

  it("rechaza un radio de geocerca por debajo del minimo util", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/company/branches")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({ name: "Micro", latitude: -12.02, longitude: -77.05, radiusMeters: 5 })
      .expect(422);
    expect(response.body.error.details).toHaveProperty("radiusMeters");
  });

  it("no permite desactivar una sucursal con empleados asignados", async () => {
    const response = await request(tenant.app)
      .delete(`/api/v1/company/branches/${tenant.branchId}`)
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(409);
    expect(response.body.error.message).toContain("empleado");
  });
});

describe("colaboradores", () => {
  it("lista con el consumo de asientos", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/users")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
    expect(response.body.data.total).toBe(3);
    expect(response.body.data.seatsUsed).toBe(3);
  });

  it("filtra por busqueda de nombre o codigo", async () => {
    const response = await request(tenant.app)
      .get("/api/v1/users?search=HR-")
      .set(auth(tenant.hrAdmin.accessToken))
      .expect(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].role).toBe("HR_ADMIN");
  });

  it("no deja asignar SUPER_ADMIN desde el panel", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/users")
      .set(auth(tenant.hrAdmin.accessToken))
      .send({
        email: `escalada-${Date.now()}@test.scire360.com`,
        fullName: "Intento de escalada",
        employeeCode: `ESC-${Date.now()}`,
        role: "SUPER_ADMIN",
      })
      .expect(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("bloquea el alta al llegar al cupo del plan", async () => {
    const full = await createTestTenant({ tier: "FREE", maxEmployees: 3 });
    try {

      const response = await request(full.app)
        .post("/api/v1/users")
        .set(auth(full.hrAdmin.accessToken))
        .send({
          email: `cuarto-${Date.now()}@test.scire360.com`,
          fullName: "Cuarto colaborador",
          employeeCode: `C4-${Date.now()}`,
        })
        .expect(402);

      expect(response.body.error.code).toBe("EMPLOYEE_LIMIT_REACHED");
      expect(response.body.error.details.limit).toBe(3);
    } finally {
      await full.cleanup();
    }
  });

  it("dar de baja a un empleado revoca sus sesiones al instante", async () => {
    const target = await createTestTenant();
    try {
      await request(target.app)
        .patch(`/api/v1/users/${target.employee.id}`)
        .set(auth(target.hrAdmin.accessToken))
        .send({ status: "TERMINATED" })
        .expect(200);

      const after = await request(target.app)
        .get("/api/v1/auth/me")
        .set(auth(target.employee.accessToken))
        .expect(401);
      expect(after.body.error.code).toBe("TOKEN_REVOKED");

      // Y el cambio queda en el rastro de auditoria. Se filtra por accion:
      // ese usuario tambien tiene una entrada de LOGIN, que no lleva motivo.
      const entry = await system.auditLog.findFirst({
        where: {
          companyId: target.companyId,
          entityType: "User",
          recordId: target.employee.id,
          action: "UPDATE",
        },
      });
      expect(entry?.reason).toContain("TERMINATED");
      expect(entry?.previousValue).toMatchObject({ status: "ACTIVE" });
      expect(entry?.newValue).toMatchObject({ status: "TERMINATED" });
    } finally {
      await target.cleanup();
    }
  });

  it("invita colaboradores y devuelve el token una sola vez", async () => {
    const inviting = await createTestTenant();
    try {
      const response = await request(inviting.app)
        .post("/api/v1/users/invite")
        .set(auth(inviting.hrAdmin.accessToken))
        .send({
          invitations: [
            {
              email: `invitado-${Date.now()}@test.scire360.com`,
              fullName: "Persona Invitada",
              employeeCode: `INV-${Date.now()}`,
            },
          ],
        })
        .expect(201);

      expect(response.body.data.invited).toBe(1);
      const token = response.body.data.invitations[0].invitationToken;
      expect(token).toBeTruthy();

      // En la base solo vive el hash: el token en claro no es recuperable.
      const invited = await system.user.findFirst({
        where: { companyId: inviting.companyId, status: "INVITED" },
        select: { invitationTokenHash: true },
      });
      expect(invited?.invitationTokenHash).toBeTruthy();
      expect(invited?.invitationTokenHash).not.toBe(token);
    } finally {
      await inviting.cleanup();
    }
  });
});
