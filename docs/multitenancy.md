# Estrategia Multi-Tenant — Scire 360 Chronos

> **Modelo elegido: _Shared Database, Shared Schema_** con aislamiento por `companyId`.

---

## 1. Por qué este modelo

| Modelo | Aislamiento | Coste operativo | Migraciones | Veredicto |
|---|---|---|---|---|
| Database per tenant | Máximo | Muy alto (N bases) | N ejecuciones | Descartado: inviable para un SaaS self-service con miles de PyMEs |
| Schema per tenant | Alto | Alto (N schemas, connection pooling complejo) | N ejecuciones | Descartado: PostgreSQL degrada con miles de schemas |
| **Shared DB / Shared Schema** | **Lógico (aplicación + índices)** | **Bajo** | **1 ejecución** | **Elegido** |

El producto es un SaaS B2B de alto volumen transaccional (marcaciones) y bajo volumen de datos por tenant. Una empresa de 50 empleados genera ~4 000 filas de `AttendanceRecord` al mes. Una sola base particionable escala a decenas de miles de tenants sin fricción operativa.

**Puerta de escape:** un tenant `ENTERPRISE` que exija aislamiento físico se migra a una instancia dedicada de la misma imagen apuntando a otra `DATABASE_URL`. El código no cambia porque el filtro por `companyId` ya está en todas partes.

---

## 2. Regla invariable

> **Toda tabla transaccional lleva `companyId String` como llave foránea obligatoria e indexada.**

```prisma
model AttendanceRecord {
  id        String  @id @default(cuid())
  companyId String                                   // ← obligatorio
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  // ...
  @@index([companyId, serverTimestamp])              // ← el tenant SIEMPRE va primero
}
```

Tres consecuencias de diseño:

1. **`companyId` es siempre la primera columna del índice compuesto.** PostgreSQL solo puede usar un índice compuesto si el prefijo izquierdo está en el `WHERE`. Como el 100 % de las consultas filtran por tenant, esto convierte cada índice en un índice "por tenant" y mantiene los planes de ejecución estables aunque una empresa tenga 100× más datos que otra.
2. **`onDelete: Cascade` desde `Company`.** Un borrado de tenant (derecho al olvido / baja de contrato) elimina íntegramente su grafo de datos en una sola operación.
3. **Denormalización deliberada.** `AttendanceRecord` guarda `companyId` aunque podría derivarlo vía `userId → User.companyId`. Se acepta la redundancia porque evita un `JOIN` en el camino caliente de escritura y permite que el filtro de tenant se aplique sin resolver relaciones.

### Tablas exentas

Solo están exentas las tablas que **son** el tenant o viven por encima de él:

- `Company` — se filtra por `id`, no por `companyId`.
- `BillingWebhookEvent` — tabla de plataforma: su `companyId` es nullable porque se resuelve *después* de recibir el evento de la pasarela, a partir del `external_reference`.

`AuditLog` **no** está exenta: lleva `companyId` y está bajo la extensión como cualquier otra tabla. Una inspección global de plataforma por parte de un `SUPER_ADMIN` de Scire usa `getSystemClient()` de forma explícita.

La lista canónica vive en `TENANT_SCOPED_MODELS` en [`packages/database/src/tenant.ts`](../packages/database/src/tenant.ts). **Añadir un modelo transaccional al schema sin añadirlo a esa lista es un bug de seguridad.**

---

## 3. Defensa en profundidad: cuatro capas

El aislamiento no depende de que un desarrollador recuerde escribir `where: { companyId }`. Se aplica en cuatro capas independientes; cualquiera de ellas por sí sola detiene una fuga.

```
┌─────────────────────────────────────────────────────────┐
│ Capa 1 — JWT                                            │
│ El access token porta { sub, companyId, role }.          │
│ companyId NUNCA se lee del body, query o header.         │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Capa 2 — AsyncLocalStorage (contexto de request)         │
│ El middleware abre un scope con el tenant del token.     │
│ Vive durante todo el ciclo async del request.            │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Capa 3 — Prisma Client Extension                         │
│ Inyecta where.companyId en TODA lectura y escritura.     │
│ Lanza TenantIsolationError si el contexto falta.         │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│ Capa 4 — Esquema PostgreSQL                              │
│ FK NOT NULL + índices con companyId como prefijo +       │
│ unicidades compuestas por tenant.                        │
└─────────────────────────────────────────────────────────┘
```

### Capa 1 — El tenant viene del token, nunca del cliente

```ts
// ✅ correcto
const companyId = req.auth.companyId;   // firmado en el JWT

// ❌ prohibido — un atacante controla el body
const companyId = req.body.companyId;
```

Esto elimina de raíz el IDOR de tenant: no existe ninguna ruta en la que el cliente pueda declarar a qué empresa pertenece.

### Capa 2 — Contexto propagado con `AsyncLocalStorage`

Node ejecuta cada request en su propio contexto async. `AsyncLocalStorage` propaga `{ companyId, userId, role }` a través de toda la cadena de `await` sin pasarlo por parámetro en cada función. No hay estado global compartido entre requests concurrentes.

```ts
import { enterTenantContext } from "@scire/database";

app.use((req, _res, next) => {
  if (!req.auth) return next();
  enterTenantContext(
    { companyId: req.auth.companyId, userId: req.auth.sub, role: req.auth.role },
    next,
  );
});
```

Hay dos entradas al contexto y la diferencia importa:

| Funcion | Uso | Por que |
|---|---|---|
| `runWithTenant(ctx, fn)` | Servicios y handlers | Devuelve una promesa y **espera dentro del contexto** |
| `enterTenantContext(ctx, fn)` | Middleware de Express | Sincrona: `next()` se llama tal cual y una excepcion se propaga sin envolverse |

⚠️ **Las `PrismaPromise` son perezosas.** `db.user.findMany()` no lanza la consulta:
construye un thenable que se ejecuta al esperarlo. Si el `await` cae fuera del scope,
la extension corre ya sin contexto y lanza `TenantIsolationError`:

```ts
// ❌ el await ocurre FUERA del contexto -> TenantIsolationError
const users = await enterTenantContext(ctx, () => db.user.findMany());

// ✅ runWithTenant espera dentro del contexto
const users = await runWithTenant(ctx, () => db.user.findMany());
```

Este comportamiento esta cubierto por los tests de integracion de
`packages/database/src/tenant.test.ts`, que corren contra PostgreSQL real: un mock
de Prisma probaria el mock, no el aislamiento.

### Capa 3 — Prisma Client Extension (el corazón del aislamiento)

`packages/database/src/tenant.ts` extiende el cliente con `$allOperations` y reescribe cada consulta antes de que llegue a la base:

| Operación | Transformación |
|---|---|
| `findMany`, `findFirst`, `count`, `aggregate`, `groupBy` | `where.companyId = <tenant>` |
| `findUnique`, `findUniqueOrThrow` | `where.companyId = <tenant>` — desde Prisma 5 (`extendedWhereUnique`) un `findUnique` admite filtros no únicos junto al `id`, así que un id de otra empresa devuelve `null` en vez de la fila ajena |
| `create` | `data.companyId = <tenant>` |
| `createMany` | `companyId` inyectado en cada fila del array |
| `update`, `updateMany`, `delete`, `deleteMany` | `where.companyId = <tenant>` |
| `upsert` | Filtro en `where` + `companyId` en `create` |

**Fail-closed:** si un modelo está en `TENANT_SCOPED_MODELS` y no hay contexto de tenant activo, la extensión **lanza `TenantIsolationError`** en lugar de ejecutar la consulta sin filtro. Es imposible leer datos cross-tenant "por olvido": el olvido produce una excepción, no una fuga silenciosa.

**Escotilla de escape explícita:** los procesos que legítimamente cruzan tenants (cron de retención de datos, webhooks de facturación, jobs de plataforma) usan `getSystemClient()`, un cliente sin extensión. El nombre es deliberadamente incómodo y su uso es auditable con un `grep`.

```ts
import { getSystemClient } from "@scire/database";
// Solo para cron jobs y webhooks de plataforma. NUNCA en un handler de request.
```

### Capa 4 — Garantías en el esquema

Las unicidades son **compuestas con el tenant**, nunca globales. Dos empresas distintas pueden tener un empleado con el mismo documento de identidad:

```prisma
@@unique([companyId, employeeCode])   // ✅ único dentro de la empresa
```

Un `@unique` global en `employeeCode` sería una fuga de información: permitiría a la empresa A descubrir por colisión que la empresa B tiene a un empleado concreto.

El `email` de `User` sí es globalmente único porque es el identificador de login de la plataforma.

---

## 4. Resolución del tenant en el borde

| Superficie | Cómo se resuelve |
|---|---|
| App móvil | JWT emitido en el login; el `companyId` va firmado en el claim |
| Dashboard web | Sesión → JWT con el mismo claim |
| Onboarding (registro) | No hay tenant todavía; usa `getSystemClient()` en una transacción que crea `Company` + `User` HR_ADMIN + `Subscription` |
| Webhooks de billing | El `external_reference` del proveedor mapea a `companyId`; se resuelve con `getSystemClient()` |
| Cron de retención | Itera empresas explícitamente con `getSystemClient()` |

No se usa resolución por subdominio en la v1. Si se añade (`acme.scire360.com`), el subdominio solo **sugiere** el tenant para la UI de login; la autorización real sigue viniendo del JWT.

---

## 5. Límites por plan

`Company.maxEmployees` se materializa en la fila (no se deriva del tier en tiempo de consulta) para que el chequeo de cuota sea un `count` + comparación sin joins, y para permitir límites negociados fuera de tarifa en cuentas `ENTERPRISE`.

Los valores por defecto viven en `PLAN_LIMITS` en [`packages/shared`](../packages/shared/src/plans.ts) y se aplican al crear o cambiar de plan.

---

## 6. Rendimiento y crecimiento

- **`AttendanceRecord` es la tabla que crece.** Índice principal `@@index([companyId, serverTimestamp])`: soporta tanto el feed en tiempo real como los reportes de nómina por rango de fechas.
- **Particionado futuro:** cuando `AttendanceRecord` supere ~50 M de filas, se particiona por `RANGE (serverTimestamp)` mensual. `companyId` como prefijo de índice mantiene el pruning eficaz dentro de cada partición. No se particiona por tenant: produciría miles de particiones desbalanceadas.
- **Connection pooling:** PgBouncer en modo `transaction`. `DIRECT_URL` (sin pooler) se reserva para `prisma migrate`, que necesita sesiones con estado.

---

## 7. Checklist para añadir una tabla nueva

- [ ] ¿Contiene datos de un cliente? → lleva `companyId String` **no nulo**.
- [ ] Relación a `Company` con `onDelete: Cascade`.
- [ ] Todo `@@index` y `@@unique` empieza por `companyId`.
- [ ] El modelo está añadido a `TENANT_SCOPED_MODELS` en `packages/database/src/tenant.ts`.
- [ ] Si es mutable y tiene valor legal, sus cambios generan `AuditLog`.
- [ ] Hay un test que verifica que el tenant A no puede leer la fila del tenant B.

---

## 8. Qué este modelo NO protege

Ser explícito sobre los límites evita una falsa sensación de seguridad:

- **Un bug en `getSystemClient()`** salta todas las capas de la extensión. Su uso debe revisarse en code review como código de seguridad.
- **SQL crudo** (`$queryRaw`) **no pasa por la extensión de Prisma.** Cualquier `$queryRaw` debe llevar el `companyId` parametrizado a mano y justificarse en el PR.
- **Row Level Security de PostgreSQL no está activo.** Se evaluó y se descartó en v1: con PgBouncer en modo transaction, `SET LOCAL app.tenant_id` requiere envolver cada consulta en una transacción explícita, lo que penaliza el camino caliente de marcación. La extensión de Prisma cubre el mismo vector con menor coste. **Si en el futuro se abre acceso directo a la base (BI, réplicas de lectura de cliente), RLS pasa a ser obligatorio** — sería la única capa que sobrevive fuera de la aplicación.
- **Un `SUPER_ADMIN` de plataforma comprometido** ve todos los tenants por diseño. Ese rol requiere MFA y sus acciones quedan en `AuditLog`.
