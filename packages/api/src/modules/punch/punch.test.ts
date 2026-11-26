import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRANCH_LOCATION,
  createTestTenant,
  FAR_LOCATION,
  punchBody,
  request,
  seedTodayShifts,
  system,
  type TestTenant,
} from "../../test/helpers.js";

/** Cada bloque usa su propio tenant: la secuencia de marcaciones es estado. */
async function freshTenant(options?: Parameters<typeof createTestTenant>[0]) {
  const tenant = await createTestTenant(options);
  await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId);
  return tenant;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("validacion de geocerca", () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await freshTenant();
  });
  afterAll(() => tenant.cleanup());

  it("acepta una marcacion dentro del radio y devuelve la distancia", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(punchBody(tenant.branchId, "IN"))
      .expect(201);

    expect(response.body.data.geofence.isInside).toBe(true);
    expect(response.body.data.geofence.distanceMeters).toBeLessThan(150);
    expect(response.body.data.verificationStatus).toBe("VERIFIED");
  });

  it("rechaza una marcacion fuera del radio e informa a que distancia esta", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(punchBody(tenant.branchId, "OUT", { location: { ...FAR_LOCATION, isMockLocation: false } }))
      .expect(422);

    expect(response.body.error.code).toBe("OUTSIDE_GEOFENCE");
    expect(response.body.error.details.distanceMeters).toBeGreaterThan(150);
  });

  it("una precision de GPS declarada absurdamente alta no anula la geocerca", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(
        punchBody(tenant.branchId, "OUT", {
          location: { ...FAR_LOCATION, accuracyMeters: 9_000, isMockLocation: false },
        }),
      )
      .expect(422);

    expect(response.body.error.code).toBe("OUTSIDE_GEOFENCE");
  });

  it("no valida geocerca si la empresa la tiene desactivada (personal de campo)", async () => {
    const fieldWork = await freshTenant({ requireGeofence: false });
    try {
      const response = await request(fieldWork.app)
        .post("/api/v1/punch")
        .set(auth(fieldWork.employee.accessToken))
        .send(
          punchBody(fieldWork.branchId, "IN", {
            location: { ...FAR_LOCATION, isMockLocation: false },
          }),
        )
        .expect(201);

      // Se registra igual, pero queda marcada como sospechosa para revision.
      expect(response.body.data.geofence.isInside).toBe(false);
      expect(response.body.data.verificationStatus).toBe("SUSPICIOUS");
    } finally {
      await fieldWork.cleanup();
    }
  });
});

describe("deteccion de GPS simulado", () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await freshTenant();
  });
  afterAll(() => tenant.cleanup());

  it("registra la marcacion como SUSPICIOUS y guarda el flag", async () => {
    const body = punchBody(tenant.branchId, "IN", {
      location: {
        latitude: BRANCH_LOCATION.latitude,
        longitude: BRANCH_LOCATION.longitude,
        accuracyMeters: 10,
        isMockLocation: true,
      },
    });

    const response = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(body)
      .expect(201);

    expect(response.body.data.isMockLocation).toBe(true);
    expect(response.body.data.verificationStatus).toBe("SUSPICIOUS");

    // El flag persiste: es lo que alimenta la alerta del dashboard.
    const stored = await system.attendanceRecord.findFirst({
      where: { companyId: tenant.companyId, clientPunchId: body.clientPunchId },
    });
    expect(stored?.isMockLocation).toBe(true);
  });
});

describe("secuencia de marcaciones", () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await freshTenant();
  });
  afterAll(() => tenant.cleanup());

  it("recorre la jornada completa IN -> LUNCH_START -> LUNCH_END -> OUT", async () => {
    for (const type of ["IN", "LUNCH_START", "LUNCH_END", "OUT"] as const) {
      await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, type))
        .expect(201);
    }

    const today = await request(tenant.app)
      .get("/api/v1/punch/today")
      .set(auth(tenant.employee.accessToken))
      .expect(200);

    expect(today.body.data.map((p: { punchType: string }) => p.punchType)).toEqual([
      "IN",
      "LUNCH_START",
      "LUNCH_END",
      "OUT",
    ]);
  });

  it("rechaza una salida despues de haber cerrado la jornada", async () => {
    const response = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(punchBody(tenant.branchId, "OUT"))
      .expect(409);

    expect(response.body.error.code).toBe("INVALID_PUNCH_SEQUENCE");
  });

  it("rechaza dos entradas seguidas", async () => {
    const other = await freshTenant();
    try {
      await request(other.app)
        .post("/api/v1/punch")
        .set(auth(other.employee.accessToken))
        .send(punchBody(other.branchId, "IN"))
        .expect(201);

      const response = await request(other.app)
        .post("/api/v1/punch")
        .set(auth(other.employee.accessToken))
        .send(punchBody(other.branchId, "IN"))
        .expect(409);

      expect(response.body.error.code).toBe("INVALID_PUNCH_SEQUENCE");
      expect(response.body.error.message).toContain("IN");
    } finally {
      await other.cleanup();
    }
  });

  it("rechaza cerrar un refrigerio que nunca empezo", async () => {
    const other = await freshTenant();
    try {
      await request(other.app)
        .post("/api/v1/punch")
        .set(auth(other.employee.accessToken))
        .send(punchBody(other.branchId, "IN"))
        .expect(201);

      await request(other.app)
        .post("/api/v1/punch")
        .set(auth(other.employee.accessToken))
        .send(punchBody(other.branchId, "LUNCH_END"))
        .expect(409);
    } finally {
      await other.cleanup();
    }
  });
});

describe("idempotencia", () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await freshTenant();
  });
  afterAll(() => tenant.cleanup());

  it("el mismo clientPunchId no crea dos marcaciones", async () => {
    const body = punchBody(tenant.branchId, "IN");

    const first = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(body)
      .expect(201);

    const second = await request(tenant.app)
      .post("/api/v1/punch")
      .set(auth(tenant.employee.accessToken))
      .send(body)
      .expect(409);

    expect(second.body.error.code).toBe("DUPLICATE_PUNCH");
    expect(second.body.error.details.recordId).toBe(first.body.data.recordId);

    const count = await system.attendanceRecord.count({
      where: { companyId: tenant.companyId, clientPunchId: body.clientPunchId },
    });
    expect(count).toBe(1);
  });
});

describe("puntualidad", () => {
  it("no cuenta tardanza dentro de la tolerancia y la cuenta fuera", async () => {
    const tenant = await createTestTenant();
    try {
      // El turno arranco hace 45 minutos: con 10 min de tolerancia son ~35 de retraso.
      const start = new Date(Date.now() - 45 * 60_000);
      const startTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Lima",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(start);

      await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId, startTime);

      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      expect(response.body.data.tardinessMinutes).toBeGreaterThanOrEqual(33);
      expect(response.body.data.tardinessMinutes).toBeLessThanOrEqual(36);
    } finally {
      await tenant.cleanup();
    }
  });

  it("marca puntual a quien llega dentro de los minutos de gracia", async () => {
    const tenant = await createTestTenant();
    try {
      const start = new Date(Date.now() - 5 * 60_000);
      const startTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Lima",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(start);

      await seedTodayShifts(tenant.companyId, tenant.employee.id, tenant.branchId, startTime);

      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      expect(response.body.data.tardinessMinutes).toBe(0);
    } finally {
      await tenant.cleanup();
    }
  });
});

describe("lote offline", () => {
  it("procesa el lote por elementos y detalla el veredicto de cada uno", async () => {
    const tenant = await freshTenant();
    try {
      const now = Date.now();
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

      const response = await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({
          punches: [
            // Deliberadamente desordenadas: el servidor las ordena por
            // deviceTimestamp antes de validar la secuencia.
            punchBody(tenant.branchId, "LUNCH_END", { deviceTimestamp: at(120) }),
            punchBody(tenant.branchId, "IN", { deviceTimestamp: at(300) }),
            punchBody(tenant.branchId, "LUNCH_START", { deviceTimestamp: at(180) }),
            // Fuera de la geocerca: debe caer sin arrastrar a las demas.
            punchBody(tenant.branchId, "OUT", {
              deviceTimestamp: at(10),
              location: { ...FAR_LOCATION, isMockLocation: false },
            }),
          ],
        })
        .expect(200);

      expect(response.body.data.created).toBe(3);
      expect(response.body.data.rejected).toBe(1);

      const rejected = response.body.data.results.find(
        (r: { status: string }) => r.status === "rejected",
      );
      expect(rejected.error.code).toBe("OUTSIDE_GEOFENCE");
    } finally {
      await tenant.cleanup();
    }
  });

  it("conserva la hora del dispositivo como instante efectivo de la marcacion", async () => {
    const tenant = await freshTenant();
    try {
      const punchedAt = new Date(Date.now() - 4 * 3_600_000); // hace 4 horas
      const body = punchBody(tenant.branchId, "IN", { deviceTimestamp: punchedAt.toISOString() });

      await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({ punches: [body] })
        .expect(200);

      const stored = await system.attendanceRecord.findFirstOrThrow({
        where: { companyId: tenant.companyId, clientPunchId: body.clientPunchId },
      });

      // El empleado ficho cuando ficho, no cuando el movil recupero cobertura.
      expect(Math.abs(stored.serverTimestamp.getTime() - punchedAt.getTime())).toBeLessThan(1000);
      expect(stored.source).toBe("MOBILE_OFFLINE");
      // Y `createdAt` conserva el momento real de recepcion: nada se pierde.
      expect(stored.createdAt.getTime()).toBeGreaterThan(stored.serverTimestamp.getTime());
      expect(stored.clockSkewSeconds).toBeLessThan(-14_000);
    } finally {
      await tenant.cleanup();
    }
  });

  it("un reenvio del mismo lote se resuelve como duplicado, no como error", async () => {
    const tenant = await freshTenant();
    try {
      const punches = [punchBody(tenant.branchId, "IN", { deviceTimestamp: new Date(Date.now() - 60_000).toISOString() })];

      await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({ punches })
        .expect(200);

      const retry = await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({ punches })
        .expect(200);

      expect(retry.body.data.duplicates).toBe(1);
      expect(retry.body.data.created).toBe(0);
    } finally {
      await tenant.cleanup();
    }
  });

  it("rechaza una marcacion encolada con fecha futura", async () => {
    const tenant = await freshTenant();
    try {
      const response = await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({
          punches: [
            punchBody(tenant.branchId, "IN", {
              deviceTimestamp: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          ],
        })
        .expect(200);

      expect(response.body.data.rejected).toBe(1);
      expect(response.body.data.results[0].error.code).toBe("CLOCK_SKEW_TOO_LARGE");
    } finally {
      await tenant.cleanup();
    }
  });

  it("el lote offline no esta disponible en el plan FREE", async () => {
    const free = await freshTenant({ tier: "FREE" });
    try {
      const response = await request(free.app)
        .post("/api/v1/punch/batch")
        .set(auth(free.employee.accessToken))
        .send({ punches: [punchBody(free.branchId, "IN")] })
        .expect(402);

      expect(response.body.error.code).toBe("FEATURE_NOT_IN_PLAN");
    } finally {
      await free.cleanup();
    }
  });
});

describe("selfie", () => {
  it("rechaza una clave de objeto que pertenece a otra empresa", async () => {
    const tenant = await freshTenant();
    try {
      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(
          punchBody(tenant.branchId, "IN", {
            selfieObjectKey: `punches/otra-empresa-id/${tenant.employee.id}/2026-09-07/in.jpg`,
          }),
        )
        .expect(403);

      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      await tenant.cleanup();
    }
  });
});

describe("aislamiento entre empresas", () => {
  it("una empresa no ve las marcaciones de otra", async () => {
    const [a, b] = await Promise.all([freshTenant(), freshTenant()]);
    try {
      await request(a.app)
        .post("/api/v1/punch")
        .set(auth(a.employee.accessToken))
        .send(punchBody(a.branchId, "IN"))
        .expect(201);

      const listB = await request(b.app)
        .get("/api/v1/punch")
        .set(auth(b.hrAdmin.accessToken))
        .expect(200);

      expect(listB.body.data.total).toBe(0);
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });

  it("no se puede marcar contra la sucursal de otra empresa", async () => {
    const [a, b] = await Promise.all([freshTenant(), freshTenant()]);
    try {
      const response = await request(a.app)
        .post("/api/v1/punch")
        .set(auth(a.employee.accessToken))
        // Sucursal de la empresa B: la extension de tenant la hace invisible.
        .send(punchBody(b.branchId, "IN"))
        .expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });

  it("un EMPLOYEE no puede listar las marcaciones de un companero", async () => {
    const tenant = await freshTenant();
    try {
      await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      // Pide explicitamente las del HR_ADMIN: el servidor ignora el userId
      // de la query y devuelve solo las suyas.
      const response = await request(tenant.app)
        .get(`/api/v1/punch?userId=${tenant.hrAdmin.id}`)
        .set(auth(tenant.employee.accessToken))
        .expect(200);

      for (const item of response.body.data.items) {
        expect(item.user.id).toBe(tenant.employee.id);
      }
    } finally {
      await tenant.cleanup();
    }
  });
});

describe("correccion manual y auditoria automatica", () => {
  it("una edicion de RRHH genera su entrada en AuditLog con el diff y el motivo", async () => {
    const tenant = await freshTenant();
    try {
      const created = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      const recordId = created.body.data.recordId as string;

      await request(tenant.app)
        .patch(`/api/v1/punch/${recordId}`)
        .set(auth(tenant.hrAdmin.accessToken))
        .send({ reason: "Tardanza justificada por comision de servicio autorizada" })
        .expect(200);

      const trail = await request(tenant.app)
        .get(`/api/v1/audit/record/${recordId}`)
        .set(auth(tenant.hrAdmin.accessToken))
        .expect(200);

      expect(trail.body.data).toHaveLength(1);
      const entry = trail.body.data[0];
      expect(entry.action).toBe("UPDATE");
      expect(entry.reason).toContain("comision de servicio");
      expect(entry.modifiedBy.id).toBe(tenant.hrAdmin.id);
      // Solo el diff, no la fila entera.
      expect(entry.previousValue.verificationStatus).toBe("VERIFIED");
      expect(entry.newValue.verificationStatus).toBe("MANUAL_OVERRIDE");
      expect(entry.previousValue).not.toHaveProperty("latitude");
    } finally {
      await tenant.cleanup();
    }
  });

  it("una anulacion queda registrada como VOID y no borra la fila", async () => {
    const tenant = await freshTenant();
    try {
      const created = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      const recordId = created.body.data.recordId as string;

      await request(tenant.app)
        .post(`/api/v1/punch/${recordId}/void`)
        .set(auth(tenant.hrAdmin.accessToken))
        .send({ reason: "Marcacion duplicada por error del dispositivo" })
        .expect(200);

      const stored = await system.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } });
      expect(stored.isVoided).toBe(true);
      expect(stored.voidedById).toBe(tenant.hrAdmin.id);

      const entry = await system.auditLog.findFirstOrThrow({
        where: { companyId: tenant.companyId, recordId, action: "VOID" },
      });
      expect(entry.reason).toContain("duplicada");
    } finally {
      await tenant.cleanup();
    }
  });

  it("un EMPLOYEE no puede editar ni anular marcaciones", async () => {
    const tenant = await freshTenant();
    try {
      const created = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      await request(tenant.app)
        .patch(`/api/v1/punch/${created.body.data.recordId}`)
        .set(auth(tenant.employee.accessToken))
        .send({ reason: "Quiero cambiar mi hora de entrada" })
        .expect(403);
    } finally {
      await tenant.cleanup();
    }
  });

  it("exige un motivo con contenido para poder editar", async () => {
    const tenant = await freshTenant();
    try {
      const created = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      const response = await request(tenant.app)
        .patch(`/api/v1/punch/${created.body.data.recordId}`)
        .set(auth(tenant.hrAdmin.accessToken))
        .send({ reason: "typo" })
        .expect(422);

      expect(response.body.error.details).toHaveProperty("reason");
    } finally {
      await tenant.cleanup();
    }
  });

  it("no se puede editar una marcacion ya anulada", async () => {
    const tenant = await freshTenant();
    try {
      const created = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN"))
        .expect(201);

      const recordId = created.body.data.recordId as string;

      await request(tenant.app)
        .post(`/api/v1/punch/${recordId}/void`)
        .set(auth(tenant.hrAdmin.accessToken))
        .send({ reason: "Anulada por revision de nomina" })
        .expect(200);

      const response = await request(tenant.app)
        .patch(`/api/v1/punch/${recordId}`)
        .set(auth(tenant.hrAdmin.accessToken))
        .send({ reason: "Intento de editar una marcacion anulada" })
        .expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
    } finally {
      await tenant.cleanup();
    }
  });
});

describe("validacion de entrada", () => {
  it("rechaza coordenadas fuera de rango", async () => {
    const tenant = await freshTenant();
    try {
      const response = await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(
          punchBody(tenant.branchId, "IN", {
            location: { latitude: 200, longitude: -77.04, isMockLocation: false },
          }),
        )
        .expect(422);

      expect(response.body.error.details).toHaveProperty("location.latitude");
    } finally {
      await tenant.cleanup();
    }
  });

  it("exige un clientPunchId con formato UUID", async () => {
    const tenant = await freshTenant();
    try {
      await request(tenant.app)
        .post("/api/v1/punch")
        .set(auth(tenant.employee.accessToken))
        .send(punchBody(tenant.branchId, "IN", { clientPunchId: "no-es-uuid" }))
        .expect(422);
    } finally {
      await tenant.cleanup();
    }
  });

  it("limita el tamano del lote", async () => {
    const tenant = await freshTenant();
    try {
      const punches = Array.from({ length: 101 }, () => punchBody(tenant.branchId, "IN"));
      await request(tenant.app)
        .post("/api/v1/punch/batch")
        .set(auth(tenant.employee.accessToken))
        .send({ punches })
        .expect(422);
    } finally {
      await tenant.cleanup();
    }
  });
});

// Silencia el aviso de variable no usada en helpers importados condicionalmente.
void randomUUID;
