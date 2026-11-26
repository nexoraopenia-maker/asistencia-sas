# Facturación y planes — Scire 360 Chronos

MercadoPago (prioritario en LATAM) · Stripe (alternativa)

---

## Planes

| | Free | Starter | Business | Enterprise |
|---|---|---|---|---|
| Precio mensual | $0 | $29 | $99 | $299 |
| Precio anual (por mes) | — | $24 | $82 | $249 |
| Colaboradores | 5 | 10 | 50 | Cuota negociada |
| Sucursales | 1 | 2 | 10 | Ilimitadas |
| Historial | 1 mes | 6 meses | 24 meses | 120 meses |
| Marcación con selfie y geocerca | ✅ | ✅ | ✅ | ✅ |
| Múltiples sucursales | — | ✅ | ✅ | ✅ |
| Modo sin conexión | — | — | ✅ | ✅ |
| Nómina en Excel y PDF | — | — | ✅ | ✅ |
| Integraciones y webhooks | — | — | ✅ | ✅ |
| Auditoría laboral | — | — | ✅ | ✅ |
| Auditoría completa, sin límite de historial | — | — | — | ✅ |
| Verificación facial | — | — | — | ✅ |

El catálogo vive en un solo sitio: [`packages/shared/src/plans.ts`](../packages/shared/src/plans.ts). Cambiar una tarifa es editar esa tabla; nada más la duplica.

> **El `AuditLog` se escribe en todos los planes, incluido Free.** Es un requisito legal, no una funcionalidad de pago. Lo que se factura es la *consola de consulta*, no la existencia del registro: una empresa que baje de plan no pierde su rastro, solo el acceso a la herramienta para leerlo.

---

## Estado de la cuenta

`Company.accountStatus` es la **única fuente de verdad** sobre si una empresa puede operar. Sustituye al antiguo booleano `isActive`, que no distinguía tres situaciones que exigen comportamientos distintos:

| Estado | Puede operar | Cuándo |
|---|---|---|
| `TRIALING` | ✅ | 14 días desde el alta |
| `ACTIVE` | ✅ | Suscripción al corriente |
| `PAST_DUE` | ✅ **durante la gracia** | Cobro rechazado |
| `SUSPENDED` | ❌ | Trial vencido, gracia agotada o baja |

Convive con `Subscription.status`, que refleja lo que dice la pasarela. No siempre coinciden, y es correcto que no lo hagan: durante los días de gracia la pasarela dice `PAST_DUE` y la plataforma sigue dejando trabajar.

### Por qué `PAST_DUE` sigue operando

Suspender el fichaje el mismo día que caduca una tarjeta castiga a los **empleados**, que no tienen forma de arreglarlo, y deja a la empresa sin registro de asistencia con valor legal justo cuando más lo va a necesitar. La gracia son 7 días (`PAST_DUE_GRACE_DAYS`), y un cron la convierte en suspensión al vencer.

---

## Pasarelas

Se usa la **API REST con `fetch`**, no los SDK oficiales. Ambos arrastran decenas de dependencias transitivas para lo poco que se necesita aquí —dos endpoints y una verificación HMAC—, y la superficie de una pasarela de pago es justo donde menos conviene tener código de terceros sin revisar.

[`providers.ts`](../packages/api/src/modules/billing/providers.ts) reduce cada pasarela a dos operaciones:

```ts
interface BillingProvider {
  createCheckout(input): Promise<CheckoutSession>;
  verifySignature(input): boolean;
  parseEvent(input): Promise<NormalizedBillingEvent | null>;
}
```

Así `billing.service.ts` no sabe con quién está hablando, y añadir una tercera pasarela no toca la lógica de negocio.

### Firmas

Cada pasarela firma distinto y hay que respetarlo al pie de la letra:

- **MercadoPago** — `x-signature: ts=<unix>,v1=<hmac>`. El HMAC se calcula sobre el manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, **no sobre el cuerpo**.
- **Stripe** — `Stripe-Signature: t=<unix>,v1=<hmac>` sobre `<t>.<rawBody>`. Puede llegar más de un `v1` durante una rotación de secreto: vale cualquiera.

Ambas llevan ventana temporal (10 y 5 minutos): sin ella, una notificación capturada sería reproducible indefinidamente.

> **El webhook se monta con `express.raw()` antes del parser JSON global.** Un `JSON.parse` + `JSON.stringify` de ida y vuelta reordena claves y normaliza espacios, y la firma deja de validar.

### Estado real, no tipo de notificación

MercadoPago envía solo un id en el webhook. El adaptador va a buscar el recurso a su API para conocer el estado real: fiarse del tipo de notificación deja huecos.

---

## Idempotencia

`BillingWebhookEvent` tiene un único compuesto `(provider, externalEventId)`. La fila se inserta **antes** de aplicar ningún cambio; si ya existe y está procesada, se sale sin tocar nada.

Las pasarelas reintentan de forma agresiva, y un evento aplicado dos veces significaría duplicar una factura o extender un periodo que no se ha pagado.

Un matiz: solo se considera duplicado si el evento **ya se aplicó** (`processedAt`). Uno recibido que falló a medias debe poder reintentarse.

Las facturas añaden una segunda capa con `externalInvoiceId` único, así que dos eventos distintos sobre el mismo cobro (`invoice.paid` y `invoice.payment_succeeded`) no la duplican.

---

## Efecto de cada evento

Todo ocurre en **una transacción**: `Company`, `Subscription` e `Invoice` se mueven juntos o no se mueven. Una cuenta `ACTIVE` sin su factura, o una factura pagada con la cuenta suspendida, son estados que nadie sabría interpretar después.

| Evento normalizado | Efecto |
|---|---|
| `PAYMENT_SUCCEEDED` | Cuenta a `ACTIVE`, plan y cuota fijados, periodo renovado, factura `PAID` |
| `SUBSCRIPTION_ACTIVATED` | Igual, pero **sin factura**: un checkout completado no es un cobro |
| `PAYMENT_FAILED` | Cuenta a `PAST_DUE` con gracia de 7 días, factura `FAILED`, webhook de alerta |
| `SUBSCRIPTION_CANCELLED` | Baja programada al final del ciclo pagado — **no se corta el servicio** |
| `IGNORED` | Se acepta con 200 y no se toca nada |

El webhook responde **200 incluso ante eventos que no aplican**: un 4xx haría que la pasarela reintentara indefinidamente algo que nunca va a cambiar.

---

## Guards

[`middleware/billing.ts`](../packages/api/src/middleware/billing.ts). Los tres comparten una idea: **el límite se comprueba en el servidor, en el punto donde se consume**. Ocultar un botón orienta al usuario; no impide nada a quien llame a la API directamente.

```ts
router.get("/payroll", requireRole(HR_ADMIN), checkFeature(Feature.ADVANCED_REPORTS), handler);
router.post("/users", requireRole(HR_ADMIN), checkSeatLimit(), handler);
// Una invitación masiva consume tantas plazas como personas lleve:
router.post("/users/invite", checkSeatLimit((body) => body.invitations.length), handler);
```

El error de `checkFeature` lleva `requiredTier`, para que el panel ofrezca el upgrade concreto en vez de un "no disponible" sin salida.

**Los asientos cuentan `ACTIVE` + `INVITED`**: una invitación pendiente ya reserva la plaza. Si no contara, una empresa podría invitar a 200 personas con un plan de 10 y encontrarse el límite superado en cuanto activaran su cuenta.

---

## Cambio de plan

`POST /api/v1/billing/checkout-session` valida **antes de cobrar** que la empresa cabe en el plan destino. Cobrar y luego rechazar el cambio es la peor combinación posible para el cliente.

Un upgrade libera plazas en cuanto llega el webhook de pago: `Company.maxEmployees` se actualiza en la misma transacción.

---

## Endpoints

| Método | Ruta | Acceso |
|---|---|---|
| GET | `/billing/plans` | público — alimenta la tabla comparativa |
| GET | `/billing/subscription` | `HR_ADMIN`+ |
| POST | `/billing/checkout-session` | `HR_ADMIN`+ |
| POST | `/billing/cancel` | `HR_ADMIN`+ |
| POST | `/billing/webhook` | pasarela (firma) |
| POST | `/billing/webhook/mercadopago` | MercadoPago (firma) |
| POST | `/billing/webhook/stripe` | Stripe (firma) |
| GET | `/subscription` | `HR_ADMIN`+ — vista completa del panel |

---

## Configuración

```bash
BILLING_PROVIDER=mercadopago          # o stripe
BILLING_CURRENCY=USD                  # PEN, ARS, MXN, BRL…
TRIAL_DAYS=14
BILLING_EXPIRATION_INTERVAL_MINUTES=60

MERCADOPAGO_ACCESS_TOKEN=APP_USR-…    # o TEST-… en sandbox
MERCADOPAGO_WEBHOOK_SECRET=…
```

**Se valida el formato de la credencial, no solo que exista.** `.env.example` trae marcadores como `<tu-access-token>`, que son cadenas perfectamente truthy: sin comprobar el prefijo, un despliegue que olvidó rellenar las variables anunciaría la facturación como operativa y el usuario lo descubriría en mitad de un pago.

Una pasarela solo se considera operativa con **credenciales y secreto de webhook**. Sin el secreto se podrían crear cobros pero no verificar las confirmaciones, que es la mitad peligrosa: cualquiera podría activar suscripciones enviando un POST.

---

## Probar los webhooks en local

Los tests firman el payload con el **mismo algoritmo** que usa la pasarela, no saltándose la verificación: si la firma se calculara mal, el test seguiría pasando y producción rechazaría todos los eventos.

```bash
pnpm --filter @scire/api vitest run src/modules/billing
```

Para un evento manual contra la API en marcha, ver el script de verificación en [`docs/dashboard.md`](dashboard.md) o firmar con:

```python
sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
# cabecera: stripe-signature: t=<ts>,v1=<sig>
```
