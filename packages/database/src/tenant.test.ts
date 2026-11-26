/**
 * Tests de integracion del aislamiento multi-tenant.
 *
 * No son tests unitarios: corren contra PostgreSQL de verdad, porque lo que se
 * verifica es exactamente que la consulta que LLEGA A LA BASE lleva el filtro.
 * Un mock de Prisma probaria el mock, no el aislamiento.
 *
 * Requiere DATABASE_URL y el esquema migrado.
 */
import { TenantIsolationError } from "@scire/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getSystemClient } from "./client.js";
import { runWithTenant } from "./tenant.js";

const system = getSystemClient();

const SUFFIX = `iso-${Date.now()}`;
let companyA: string;
let companyB: string;
let branchB: string;

beforeAll(async () => {
  const a = await system.company.create({
    data: { name: `Tenant A ${SUFFIX}`, slug: `tenant-a-${SUFFIX}` },
  });
  const b = await system.company.create({
    data: { name: `Tenant B ${SUFFIX}`, slug: `tenant-b-${SUFFIX}` },
  });
  companyA = a.id;
  companyB = b.id;

  await system.branch.create({
    data: { companyId: companyA, name: "Sede A", latitude: -12.04, longitude: -77.04 },
  });
  const bBranch = await system.branch.create({
    data: { companyId: companyB, name: "Sede B", latitude: -12.05, longitude: -77.05 },
  });
  branchB = bBranch.id;
});

afterAll(async () => {
  // onDelete: Cascade arrastra sucursales, usuarios y marcaciones.
  await system.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
  await system.$disconnect();
});

describe("aislamiento en lectura", () => {
  it("findMany solo devuelve filas del tenant activo", async () => {
    const branches = await runWithTenant({ companyId: companyA }, () => db.branch.findMany());
    expect(branches).toHaveLength(1);
    expect(branches[0]!.name).toBe("Sede A");
  });

  it("findUnique con el id de otro tenant devuelve null, no la fila ajena", async () => {
    const stolen = await runWithTenant({ companyId: companyA }, () =>
      db.branch.findUnique({ where: { id: branchB } }),
    );
    expect(stolen).toBeNull();
  });

  it("count solo cuenta las filas del tenant activo", async () => {
    const total = await runWithTenant({ companyId: companyB }, () => db.branch.count());
    expect(total).toBe(1);
  });
});

describe("aislamiento en escritura", () => {
  it("create inyecta el companyId del contexto sin declararlo", async () => {
    const created = await runWithTenant({ companyId: companyA }, () =>
      db.branch.create({
        data: { name: "Sede A2", latitude: -12.06, longitude: -77.06 } as never,
      }),
    );
    expect(created.companyId).toBe(companyA);
  });

  it("un update no puede reasignar la fila a otra empresa", async () => {
    const branch = await runWithTenant({ companyId: companyA }, () =>
      db.branch.findFirst({ where: { name: "Sede A" } }),
    );
    const updated = await runWithTenant({ companyId: companyA }, () =>
      db.branch.update({
        where: { id: branch!.id },
        data: { companyId: companyB, address: "Av. Nueva 123" } as never,
      }),
    );
    expect(updated.companyId).toBe(companyA);
    expect(updated.address).toBe("Av. Nueva 123");
  });

  it("deleteMany del tenant A no toca las filas del tenant B", async () => {
    await runWithTenant({ companyId: companyA }, () =>
      db.branch.deleteMany({ where: { name: "Sede A2" } }),
    );
    const survivors = await system.branch.count({ where: { companyId: companyB } });
    expect(survivors).toBe(1);
  });
});

describe("fail-closed", () => {
  it("lanza TenantIsolationError si no hay contexto de tenant", async () => {
    await expect(db.branch.findMany()).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it("tampoco deja escribir sin contexto", async () => {
    await expect(
      db.branch.create({ data: { name: "Fuga", latitude: 0, longitude: 0 } as never }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it("Company no esta bajo la extension: se filtra por id, no por companyId", async () => {
    const company = await db.company.findUnique({ where: { id: companyA } });
    expect(company?.id).toBe(companyA);
  });

  it("getSystemClient ve a todos los tenants a proposito", async () => {
    const both = await system.company.findMany({
      where: { id: { in: [companyA, companyB] } },
    });
    expect(both).toHaveLength(2);
  });
});
