# API v1 — Scire 360 Chronos

Base: `/api/v1` · Autenticación: `Authorization: Bearer <accessToken>`

Todas las respuestas siguen el mismo sobre:

```jsonc
// éxito
{ "success": true, "data": { /* ... */ } }

// error
{ "success": false, "error": { "code": "OUTSIDE_GEOFENCE", "message": "...", "details": { "distanceMeters": 1180.4 } } }
```

`error.code` es estable y forma parte del contrato: el cliente decide qué hacer según el código, nunca según el texto. `error.details` lleva contexto **accionable** — la distancia que falta para entrar en la geocerca, el `recordId` de un duplicado, los errores por campo de una validación.

---

## Autenticación — `/auth`

| Método | Ruta | Acceso | Qué hace |
|---|---|---|---|
| POST | `/auth/register-company` | público | Onboarding: crea empresa + suscripción en trial + primer `HR_ADMIN`, en una transacción |
| POST | `/auth/login` | público | Devuelve perfil y par de tokens |
| POST | `/auth/refresh` | público | Rota el refresh token y emite un par nuevo |
| POST | `/auth/biometric` | público | Desbloqueo por huella/Face ID (mismo flujo que refresh) |
| POST | `/auth/accept-invitation` | público | El empleado invitado fija contraseña y activa su cuenta |
| POST | `/auth/logout` | público | Revoca la sesión del dispositivo |
| GET | `/auth/me` | autenticado | Perfil del usuario del token |
| POST | `/auth/change-password` | autenticado | Cambia contraseña y cierra el resto de sesiones |
| GET | `/auth/sessions` | autenticado | Dispositivos con sesión activa |
| DELETE | `/auth/sessions/:id` | autenticado | Revoca un dispositivo concreto |

### Tokens

- **Access token** — JWT de 15 min. Lleva `{ sub, companyId, role, sid }`. `companyId` va **firmado**: es la raíz del aislamiento multi‑tenant y nunca se lee del body ni de una cabecera.
- **Refresh token** — JWT de 30 días ligado a una fila `Session`. Se guarda **hasheado** (SHA‑256): volcar la tabla de sesiones no da tokens utilizables.

### Rotación y detección de reutilización

Cada refresco invalida el token usado. Si llega uno ya rotado hay dos explicaciones posibles —un atacante con un token robado, o la víctima usando el suyo después del robo— y no se pueden distinguir. La respuesta es revocar **todas** las sesiones del usuario y registrarlo en `AuditLog`. Es lo que recomienda la OAuth 2.0 Security BCP: prefiere molestar al usuario legítimo antes que dejar viva una sesión comprometida.

### Biometría

El servidor **no recibe datos biométricos**. La huella o Face ID desbloquean el keychain del dispositivo, que libera el refresh token guardado; a partir de ahí el flujo es un refresco normal. Almacenar plantillas biométricas sería un riesgo y una carga regulatoria sin contrapartida.

---

## Marcación — `/punch`

| Método | Ruta | Acceso | Qué hace |
|---|---|---|---|
| POST | `/punch/presigned-url` | autenticado | Firma una URL PUT para subir la selfie directo a S3/R2 |
| POST | `/punch` | autenticado | Confirma la marcación citando la clave de la selfie |
| POST | `/punch/batch` | plan BUSINESS+ | Sincroniza la cola offline (hasta 100 marcaciones) |
| GET | `/punch/today` | autenticado | Marcaciones de hoy (modal "Detalle del Turno") |
| GET | `/punch` | autenticado | Feed del dashboard. Un `EMPLOYEE` solo ve las suyas |
| GET | `/punch/:id/selfie` | `SUPERVISOR`+ | URL GET firmada de vida corta |
| PATCH | `/punch/:id` | `HR_ADMIN`+ | Corrección manual. Exige `reason` · **audita** |
| POST | `/punch/:id/void` | `HR_ADMIN`+ | Anulación (soft delete). Exige `reason` · **audita** |

### Flujo completo desde el móvil

```
1. POST /punch/presigned-url  →  { uploadUrl, objectKey, expiresAt, requiredHeaders }
2. PUT  <uploadUrl>           →  el móvil sube la foto DIRECTAMENTE al bucket
3. POST /punch                →  { punchType, branchId, location, deviceTimestamp,
                                   selfieObjectKey: <objectKey>, clientPunchId }
```

La foto nunca pasa por la API. Además de ahorrar ancho de banda, evita que la avalancha de marcaciones de las 9:00 sature el servidor con binarios. `ContentType` y `ContentLength` van dentro de la firma, así que la URL no sirve para colar un objeto arbitrario en el bucket.

### Validaciones que aplica el servidor

| Regla | Comportamiento |
|---|---|
| **Geocerca** (Haversine) | Radio efectivo = radio de sucursal + buffer de plataforma + precisión GPS (topada, para que un GPS "impreciso" a propósito no anule la geocerca). Fuera → `OUTSIDE_GEOFENCE` con `distanceMeters` |
| **GPS simulado** | Se registra **siempre** en `isMockLocation`. Según `REJECT_MOCK_LOCATION`: rechaza (`MOCK_LOCATION_DETECTED`) o guarda como `SUSPICIOUS` |
| **Secuencia** | `NONE→IN→{LUNCH_START,OUT}`, `LUNCH_START→LUNCH_END→OUT`. Violación → `INVALID_PUNCH_SEQUENCE` |
| **Idempotencia** | `clientPunchId` (UUID del cliente) es único por empresa. Reintento → `DUPLICATE_PUNCH` con el `recordId` original |
| **Selfie** | Si la empresa la exige y falta → `SELFIE_REQUIRED`. La clave debe estar bajo el prefijo del propio tenant, y se comprueba con `HeadObject` que el objeto llegó de verdad |
| **Desfase de reloj** | Online: desfase > `MAX_ONLINE_CLOCK_SKEW_SECONDS` → `SUSPICIOUS`. Offline: es el tiempo en cola, se registra sin penalizar |
| **Puntualidad** | Minutos de tardanza sobre el turno `WORK` del día, descontada la tolerancia de la empresa. Se materializa en la fila para que la nómina no recalcule reglas de otro momento |

### Modo offline

`POST /punch/batch` acepta hasta 100 marcaciones encoladas. Dos decisiones importan:

1. **Se procesa por elementos, no como transacción única.** Una marcación inválida no puede tirar las 20 buenas que la acompañan. La respuesta detalla el veredicto de cada `clientPunchId` (`created` / `duplicate` / `rejected`) para que el dispositivo vacíe de su cola solo lo confirmado.
2. **Se ordena por `deviceTimestamp` antes de validar.** La secuencia depende del orden real de los hechos; un lote desordenado evaluaría un `LUNCH_END` antes que su `LUNCH_START`.

**Instante efectivo:** en una marcación offline, `serverTimestamp` se fija al reloj del dispositivo — el empleado fichó cuando fichó, no cuando el móvil recuperó cobertura. `createdAt` conserva el momento real de recepción y `clockSkewSeconds` la diferencia, así que el rastro completo queda reconstruible. Se rechazan las fechas futuras y las de más de `MAX_OFFLINE_AGE_HOURS`.

Un lote reenviado entero se resuelve como `duplicate`, no como error: es el caso normal cuando se pierde la respuesta de red.

---

## Turnos — `/shifts`

| Método | Ruta | Acceso | Qué hace |
|---|---|---|---|
| GET | `/shifts/week?weekOf=YYYY-MM-DD` | autenticado | Calendario `Dom`→`Sáb` con desglose Trabajo/Refrigerio |
| POST | `/shifts` | `SUPERVISOR`+ | Crea un tramo |
| PATCH | `/shifts/:id` | `SUPERVISOR`+ | Edita un tramo |
| DELETE | `/shifts/:id` | `SUPERVISOR`+ | Elimina un tramo |
| POST | `/shifts/bulk-assign` | `HR_ADMIN`+ | Aplica una plantilla a N empleados sobre un rango |

Un turno es **un tramo con tipo**. La jornada estándar son dos filas — `WORK 09:00:00‑18:00:00` y `LUNCH 13:00:00‑14:00:00` — y no un turno de trabajo con campos de almuerzo dentro. Eso admite jornadas partidas y dobles refrigerios sin tocar el esquema.

Cada día devuelve `status` (`SCHEDULED` · `PRESENT` · `LATE` · `ABSENT` · `REST` · `JUSTIFIED`), las marcaciones reales y los minutos trabajados. **Lo programado descuenta el refrigerio**: 9 h de turno son 480 min pagados. Si falta la marcación de salida el día cuenta 0 — inventar una hora de cierre sería fabricar datos de nómina.

Las horas se guardan como `HH:mm:ss` local, no como instantes: "las 09:00" no se desplaza con el horario de verano. Las agrupaciones por jornada usan la zona de la empresa, porque una salida a las 20:00 en Lima es la 01:00 UTC del día siguiente y agrupar por UTC partiría la jornada en dos.

---

## Auditoría — `/audit`

| Método | Ruta | Acceso | Qué hace |
|---|---|---|---|
| GET | `/audit` | `HR_ADMIN`+ | Rastro filtrable por entidad, acción, actor |
| GET | `/audit/record/:recordId` | `HR_ADMIN`+ | Historial completo de una marcación |

**Solo lectura.** No existe ningún endpoint que modifique o borre `AuditLog`: esa ausencia *es* la garantía.

La auditoría no se escribe a mano en cada servicio, sino en una **extensión de cliente Prisma** ([`packages/database/src/audit.ts`](../packages/database/src/audit.ts)) que intercepta todo `UPDATE`/`DELETE` sobre `AttendanceRecord`, `Shift`, `Absence` y `User`. Una entrada que hay que acordarse de escribir es una entrada que algún día falta.

Cada registro guarda **solo el diff** —no la fila entera, para no duplicar datos personales—, el actor, la IP, el user‑agent y el motivo. La acción se deduce del cambio: anular una marcación es técnicamente un `UPDATE`, pero se registra como `VOID`, que es como lo espera ver un inspector.

*Limitación conocida:* la entrada se escribe **después** de que la mutación tenga éxito, en una operación separada. No comparte transacción con el cambio auditado. Es el precio de que la auditoría sea automática y no se pueda olvidar.

---

## Webhooks salientes (n8n / Evolution API)

Eventos: `punch.created` · `punch.late` · `punch.mock_location` · `punch.outside_geofence` · `absence.created` · `absence.reviewed`

**Patrón outbox.** La marcación escribe una fila en `WebhookDelivery` y termina; un despachador aparte hace las entregas con reintentos y backoff exponencial (30 s → 1 h). Si n8n está caído, un empleado fichando a las 9 de la mañana no puede quedarse esperando —ni perder su marcación— por una notificación.

Cada entrega va firmada al estilo Stripe:

```
X-Scire-Event: punch.late
X-Scire-Delivery: <id>
X-Scire-Signature: t=<unix>,v1=<hmac-sha256 de "<t>.<body>">
```

El timestamp entra en la firma para que el receptor pueda rechazar reenvíos antiguos; sin él, una entrega capturada sería reproducible indefinidamente. Un endpoint que acumula fallos se desactiva solo.

---

## Códigos de error

| Código | HTTP | Cuándo |
|---|---|---|
| `UNAUTHENTICATED` · `INVALID_CREDENTIALS` · `TOKEN_EXPIRED` · `TOKEN_REVOKED` | 401 | Autenticación |
| `FORBIDDEN` · `USER_SUSPENDED` · `CROSS_TENANT_ACCESS` | 403 | Autorización |
| `NOT_FOUND` | 404 | Recurso inexistente **o de otro tenant** |
| `CONFLICT` · `DUPLICATE_PUNCH` · `INVALID_PUNCH_SEQUENCE` | 409 | Estado incompatible |
| `SUBSCRIPTION_INACTIVE` · `FEATURE_NOT_IN_PLAN` · `EMPLOYEE_LIMIT_REACHED` | 402 | Plan o suscripción |
| `VALIDATION_ERROR` · `OUTSIDE_GEOFENCE` · `MOCK_LOCATION_DETECTED` · `SELFIE_REQUIRED` · `SELFIE_NOT_UPLOADED` · `CLOCK_SKEW_TOO_LARGE` | 422 | Datos rechazados |
| `RATE_LIMITED` | 429 | Límite de peticiones (FASE 7) |
| `STORAGE_ERROR` · `INTERNAL_ERROR` | 5xx | Infraestructura |

Un recurso de otro tenant devuelve **404, no 403**: un 403 confirmaría que el id existe en alguna parte.
