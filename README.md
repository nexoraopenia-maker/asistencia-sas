# Scire 360 Chronos

Plataforma SaaS B2B de control de asistencia, turnos, marcación móvil y gestión laboral.

Marcación con selfie verificada, validación de geocerca, detección de GPS simulado, modo offline‑first y trazabilidad legal inmutable — multi‑tenant desde el primer día.

---

## Estado

| Fase | Alcance | Estado |
|---|---|---|
| 1 | Arquitectura base, monorepo y DevOps | ✅ Completada |
| 2 | Modelado de datos y persistencia | ✅ Completada |
| 3 | Backend API y servicios núcleo | ✅ Completada |
| 4 | Aplicación móvil (Expo) | ✅ Completada |
| 5 | Dashboard web para RRHH | ✅ Completada |
| 6 | Billing y monetización | ✅ Completada |
| 7 | Seguridad y verificación avanzada | ✅ Completada |
| 8 | Design system y pulido visual | ✅ Completada |

---

## Estructura

```
scire360-chronos/
├── apps/
│   ├── mobile/          Expo (React Native) + NativeWind — app del empleado
│   └── web/             Next.js App Router + Tailwind + shadcn/ui — panel RRHH
├── packages/
│   ├── api/             Servicios y endpoints REST (Express + TypeScript)
│   ├── database/        Prisma ORM, esquema PostgreSQL, seed y aislamiento de tenant
│   └── shared/          Tipos TypeScript y validaciones Zod compartidos
├── docker/              Dockerfiles productivos (API y web)
├── docs/                Documentación técnica
└── docker-compose.yml   PostgreSQL + Redis para desarrollo local
```

`packages/shared` no depende de Prisma: la app móvil la consume tal cual.

La API viva está documentada en [`docs/api.md`](docs/api.md), la app móvil en [`docs/mobile.md`](docs/mobile.md) el panel de RRHH en [`docs/dashboard.md`](docs/dashboard.md) la facturación en [`docs/billing.md`](docs/billing.md) la seguridad avanzada en [`docs/security.md`](docs/security.md) y el design system en [`docs/design-system.md`](docs/design-system.md).

---

## Requisitos

- Node.js ≥ 20
- pnpm ≥ 10
- Docker (para PostgreSQL y Redis en local)

> **Nota sobre pnpm:** el workspace usa `nodeLinker: hoisted` para que Metro (React Native) resuelva correctamente. Desde pnpm 10 esos ajustes van en `pnpm-workspace.yaml`, **no** en `.npmrc` — ahí se ignoran en silencio y el árbol queda a medio instalar.

---

## Puesta en marcha

```bash
# 1. Variables de entorno
cp .env.example .env
#    Genera los secretos JWT:  openssl rand -base64 48

# 2. Dependencias
pnpm install

# 3. Infraestructura local (PostgreSQL + Redis)
pnpm docker:up
#    Opcional — Adminer + MinIO: docker compose --profile tools up -d

# 4. Base de datos
pnpm db:migrate      # crea el esquema
pnpm db:seed         # datos demo

# 5. Desarrollo
pnpm dev             # arranca todas las apps en paralelo
```

### Datos demo

| Campo | Valor |
|---|---|
| Empresa | Corporación Demo S.A.C. (`America/Lima`) |
| Sucursal | Sede Central — geocerca de 150 m |
| Usuario RRHH | `maria.fernandez@demo.scire360.com` |
| Contraseña | La de `SEED_PASSWORD` en tu `.env` |
| Empleado | María Fernández · ID 98451237 · Analista de RRHH · `HR_ADMIN` |

El seed genera turnos de lunes a viernes (trabajo 09:00:00–18:00:00, refrigerio 13:00:00–14:00:00) y marcaciones de la semana en curso, incluidas una tardanza y una marcación con GPS simulado para poblar las alertas del dashboard.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Arranca todas las apps en modo desarrollo |
| `pnpm build` | Compila todo el monorepo |
| `pnpm test` | Ejecuta la batería de tests (los de `packages/database` necesitan PostgreSQL en marcha) |
| `pnpm typecheck` | Comprobación de tipos |
| `pnpm db:migrate` | Crea/aplica migraciones en desarrollo |
| `pnpm db:deploy` | Aplica migraciones en producción |
| `pnpm db:seed` | Carga los datos demo |
| `pnpm db:studio` | Abre Prisma Studio |
| `pnpm db:reset` | Reinicia la base de datos y vuelve a sembrar |
| `pnpm docker:up` / `docker:down` | Levanta/baja la infraestructura local |

---

## Multi‑tenancy

*Shared Database, Shared Schema*: toda tabla transaccional lleva `companyId` no nulo e indexado como primera columna.

El aislamiento no depende de recordar escribir el filtro. Una extensión de cliente Prisma inyecta `where: { companyId }` en cada consulta a partir del contexto del JWT, y **lanza una excepción** si el contexto falta — olvidarlo produce un error ruidoso, nunca una fuga silenciosa.

```ts
import { db, runWithTenant } from "@scire/database";

// Solo empleados de esa empresa. Sin escribir el filtro.
const users = await runWithTenant({ companyId: req.auth.companyId }, () =>
  db.user.findMany(),
);
```

Los procesos de plataforma que cruzan tenants (onboarding, webhooks de facturación, cron de retención) usan `getSystemClient()` de forma explícita y auditable.

Los tests de `packages/database/src/tenant.test.ts` verifican el aislamiento contra PostgreSQL real —un mock de Prisma probaría el mock, no el aislamiento—: lectura cruzada, `findUnique` con id ajeno, inyección de `companyId` al crear, intento de reasignar tenant en un `update`, `deleteMany` acotado y el comportamiento *fail‑closed* sin contexto.

Detalle completo en [`docs/multitenancy.md`](docs/multitenancy.md).

---

## API

Base `/api/v1`. Referencia completa en [`docs/api.md`](docs/api.md).

| Módulo | Qué cubre |
|---|---|
| `/auth` | JWT con rotación de refresh tokens y detección de reutilización, RBAC jerárquico, desbloqueo biométrico, gestión de sesiones por dispositivo |
| `/punch` | Presigned URLs para subir la selfie directo a S3/R2, validación Haversine de geocerca, detección de GPS simulado, secuencia de jornada, idempotencia, lote offline |
| `/shifts` | Calendario semanal con desglose Trabajo/Refrigerio, CRUD de tramos y asignación masiva de plantillas |
| `/audit` | Consulta de solo lectura del rastro inmutable |

Decisiones que conviene conocer antes de tocar el código:

- **La foto nunca pasa por la API.** El móvil la sube directamente al bucket con una URL PUT firmada de vida corta; la marcación solo cita la clave del objeto. `ContentType` y `ContentLength` van dentro de la firma.
- **En una marcación offline manda el reloj del dispositivo.** El empleado fichó cuando fichó, no cuando el móvil recuperó cobertura. `createdAt` conserva el momento de recepción, así que el rastro completo sigue siendo reconstruible.
- **El lote offline se procesa por elementos.** Una marcación inválida no tira las buenas que la acompañan; cada `clientPunchId` recibe su veredicto para que el dispositivo vacíe de su cola solo lo confirmado.
- **La auditoría es una extensión de Prisma, no una llamada en cada servicio.** Una entrada que hay que acordarse de escribir es una entrada que algún día falta.
- **Los webhooks usan patrón outbox.** Si n8n está caído, la marcación se confirma igual y la notificación se reintenta con backoff.
- **Un recurso de otro tenant devuelve 404, no 403.** Un 403 confirmaría que el id existe en alguna parte.

---

## App móvil

Expo SDK 54 con expo-router y NativeWind. Referencia completa en [`docs/mobile.md`](docs/mobile.md).

Login con JWT y desbloqueo biométrico, marcación con selfie en vivo y geocerca, cola offline en SQLite con sincronización automática por lotes, y navegación en cinco pestañas.

Decisiones que conviene conocer:

- **El refresco de token es single-flight.** El backend revoca todas las sesiones al detectar reutilización de un refresh token; tres peticiones caducando a la vez dispararían esa defensa contra el propio usuario.
- **Solo un fallo de red encola una marcación.** Un rechazo por geocerca se muestra al empleado con los metros que le faltan; encolarlo solo aplazaría el mismo error.
- **Si la red cae a mitad del envío, se encola con el mismo `clientPunchId`.** Si el servidor la recibió, la sincronización la resuelve como duplicado en vez de crear una segunda marcación.
- **Los tokens viven en el Keychain / KeyStore**, nunca en AsyncStorage.
- **La cola usa SQLite.** Una marcación perdida es una hora que el empleado no cobra; leer‑modificar‑escribir un JSON entero abre una ventana de corrupción en cada guardado.

---

## Dashboard web de RRHH

Next.js 15 con App Router, shadcn/ui y Recharts. Referencia completa en [`docs/dashboard.md`](docs/dashboard.md).

Feed de marcaciones en vivo con inspección de selfie y geocerca, gestión de empleados, matriz semanal de turnos, reportes con exportación a Excel y PDF, visor inmutable de auditoría y panel de suscripción. Sidebar retráctil con selector global de sucursal y tema claro/oscuro.

Decisiones que conviene conocer:

- **Los tokens viven en cookies httpOnly y el navegador nunca los ve.** Todo pasa por un proxy BFF en `/api/proxy` que adjunta el Bearer del lado del servidor: un XSS no puede exfiltrar la sesión.
- **El rol se comprueba en el servidor al iniciar sesión.** Un colaborador con credenciales válidas entra en la app móvil, no en el panel.
- **La exportación se genera en el servidor de Next**, no en el navegador: el token no es legible desde el cliente y un informe grande no debe construirse en el hilo principal de una pestaña.
- **El mapa de geocerca es SVG propio**, no un proveedor externo: no se envían las coordenadas de un empleado a un tercero solo para pintar un recuadro.
- **El rastro de auditoría oculta los accesos por defecto**, o los `LOGIN` entierran las modificaciones que el módulo existe para inspeccionar.

---

## Facturación y planes

MercadoPago (prioritario en LATAM) con Stripe como alternativa. Referencia completa en [`docs/billing.md`](docs/billing.md).

Cuatro planes con feature gating, trial de 14 días, checkout recurrente, webhooks idempotentes y guards de cuota. El catálogo vive en un solo sitio: [`packages/shared/src/plans.ts`](packages/shared/src/plans.ts).

Decisiones que conviene conocer:

- **`Company.accountStatus` es la única fuente de verdad** sobre si una empresa puede operar. Sustituye al booleano `isActive`, que no distinguía "en prueba" de "moroso en gracia" de "suspendido".
- **Una cuenta `PAST_DUE` sigue operando durante 7 días.** Cortar el fichaje el mismo día que caduca una tarjeta castiga a empleados que no pueden arreglarlo y deja a la empresa sin registro con valor legal.
- **El `AuditLog` se escribe en todos los planes, incluido Free.** Es un requisito legal, no una funcionalidad de pago: lo que se factura es la consola de consulta.
- **Los webhooks se montan con `express.raw()`** antes del parser JSON: la firma se calcula sobre los bytes exactos y un `JSON.parse` de ida y vuelta la invalida.
- **La idempotencia es doble**: `(provider, externalEventId)` único en `BillingWebhookEvent` y `externalInvoiceId` único en `Invoice`. Las pasarelas reintentan de forma agresiva.
- **Se valida el formato de las credenciales**, no solo que existan: un `<tu-access-token>` sin rellenar es una cadena truthy que anunciaría la facturación como operativa.
- **Un cambio de plan se rechaza antes de cobrar** si la empresa no cabe en el destino.

---

## Design system

Plus Jakarta Sans, gradiente noche‑púrpura, acentos turquesa y morado. Referencia completa en [`docs/design-system.md`](docs/design-system.md).

- **Todo el color sale de variables CSS.** Ningún componente fija un tono de Tailwind: el mismo tono no puede servir sobre el gradiente oscuro y sobre blanco.
- **Contraste medido, no estimado.** `pnpm --filter @scire/web contrast` calcula el ratio WCAG real de cada par, incluida la mezcla del tinte translúcido. La primera pasada encontró 9 fallos —`text-amber-400` sobre fondo claro daba **1.54:1**—; ahora los 26 pares cumplen AA.
- **Movimiento corto y uniforme**: 240 ms de entrada, cascada de 35 ms entre filas. Esto es una herramienta de trabajo, no una landing.
- **`prefers-reduced-motion` respetado**: el contenido aparece sin desplazamiento, no sin aparecer.
- **Navegación adaptativa**: cajón por debajo de 1024 px. Un sidebar fijo de 256 px sobre una pantalla de 390 px deja el panel inservible.

---

## Seguridad avanzada

Verificación facial, rate limiting y retención de datos biométricos. Referencia completa en [`docs/security.md`](docs/security.md).

- **El face‑match corre en segundo plano**, nunca en el camino caliente del fichaje: Rekognition tarda hasta 2 s y eso convertiría la marcación de las 9:00 en una cola.
- **Nunca se trunca el registro.** Una marcación rechazada por face‑match conserva hora, ubicación y auditoría: sigue siendo documentación laboral, solo cambia su etiqueta de verificación.
- **Ventana deslizante, no fija.** Con ventana fija, un límite de 5/min deja pasar 10 peticiones en dos segundos a caballo del cambio de minuto.
- **El login limita por IP y por credencial a la vez.** Solo por IP, una botnet prueba una contraseña por IP; solo por credencial, un atacante recorre miles de correos desde una IP.
- **Sin Redis, el limitador cae a memoria por proceso**, no a dejar pasar todo: un limitador que se abre ante una caída convierte un incidente en una ventana de fuerza bruta.
- **La purga borra la imagen, nunca el registro.** Y `selfiePurgedAt` distingue «nunca tuvo foto» de «la tuvo y se depuró conforme a la ley».

---

## Seguridad

- **Secretos** solo en `.env` / `.env.local`, nunca en el repositorio. `.gitignore` cubre `.env*`, claves, keystores y credenciales de servicio.
- **Selfies y justificantes** se guardan como *object keys*, nunca como URLs públicas: el acceso es siempre vía presigned URL de vida corta.
- **`AuditLog` es append‑only**: no tiene `updatedAt` y la aplicación nunca hace `UPDATE`/`DELETE` sobre ella.
- **Datos biométricos** con política de retención por plan y depuración programada.
- **Contraseñas** con bcrypt (12 rondas por defecto); los refresh tokens se guardan hasheados con rotación y detección de reutilización.
- **El `companyId` viaja firmado en el JWT** y nunca se lee del body, la query ni una cabecera: no existe ruta por la que un cliente pueda declarar a qué empresa pertenece.
- **Cada request comprueba en base que la sesión sigue viva y el empleado activo.** Un access token vive 15 minutos y no se puede invalidar por firma; sin esa comprobación, un empleado dado de baja podría seguir fichando ese cuarto de hora.
- **El login responde igual ante un correo inexistente y una contraseña incorrecta**, con verificación en tiempo constante, para no revelar qué cuentas existen.

---

## Despliegue

Imágenes productivas listas para Easypanel / Docker:

```bash
docker build -f docker/Dockerfile.api -t scire360-api .
docker build -f docker/Dockerfile.web -t scire360-web .
```

La imagen de la API aplica `prisma migrate deploy` al arrancar y expone `/health` para el healthcheck del orquestador.
