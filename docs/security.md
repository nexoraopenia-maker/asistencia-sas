# Seguridad avanzada — Scire 360 Chronos

Verificación facial · Rate limiting · Retención de datos biométricos

---

## Verificación facial

[`face-match.service.ts`](../packages/api/src/modules/biometrics/face-match.service.ts). Compara la selfie de la marcación contra la foto de perfil oficial del empleado.

**Las imágenes nunca salen del bucket.** Rekognition recibe referencias `S3Object`, no bytes: la foto no viaja por la API ni se carga en memoria del servidor.

**Corre siempre en segundo plano.** Una llamada a Rekognition tarda entre 300 ms y 2 s; meter eso en el camino caliente convertiría el fichaje de la mañana en una cola. La marcación nace `PENDING` y el trabajador la resuelve en segundos.

### Estados posibles

| Resultado | Estado | Por qué |
|---|---|---|
| Similitud ≥ umbral | `VERIFIED` | Coincide |
| Similitud < umbral | `SUSPICIOUS` | Revisión humana |
| Sin rostro utilizable | `REJECTED` | La foto no sirve para verificar |
| Sin foto de perfil | `SUSPICIOUS` | Problema **administrativo**, no indicio de fraude |
| Fallo del proveedor | `PENDING` | Se reintenta; no se penaliza al empleado |

> **Nunca se trunca el registro.** Una marcación rechazada por face‑match conserva su hora, ubicación, selfie y rastro de auditoría: sigue siendo documentación laboral. Lo que cambia es la etiqueta de verificación, para que RRHH la revise.

**El umbral lo decide la empresa, no el proveedor.** Se pide a Rekognition *toda* coincidencia (`SimilarityThreshold: 0`) y la decisión se toma con `Company.faceMatchMinScore`. Delegarlo en AWS haría que un cambio de política exigiera redesplegar.

**Feature gating**: exclusivo de `ENTERPRISE`. El flag por empresa existe, pero sin el plan no hace nada — el trabajador ni siquiera recoge esas marcaciones.

### Comparador local

Sin credenciales de AWS se usa un sustituto determinista. No reconoce caras: deriva una puntuación estable de las claves de los objetos. Sirve para ejercitar el flujo completo —cola, umbral, estados, auditoría— sin cuenta de AWS ni coste por llamada.

Es determinista a propósito: una puntuación aleatoria haría que un mismo caso pasara unas veces y fallara otras, y un test así no prueba nada.

> ⚠️ Nunca debe usarse en producción. Convención para tests: una clave con `nomatch` simula desajuste facial; con `noface`, una selfie sin rostro utilizable.

---

## Rate limiting

[`rate-limit.ts`](../packages/api/src/lib/rate-limit.ts) · ventana deslizante sobre Redis.

**Ventana deslizante, no fija.** La fija tiene un agujero conocido: con un límite de 5 por minuto, un atacante hace 5 peticiones a las 12:00:59 y otras 5 a las 12:01:00 — 10 en dos segundos. La deslizante cuenta siempre los últimos N segundos reales.

La implementación usa un sorted set por clave: cada petición es un miembro con el timestamp como score. Purgar + registrar + contar van en un `MULTI` para que sea atómico entre procesos; sin eso, dos instancias podrían leer el mismo recuento y dejar pasar el doble.

### Límites

| Ruta | Límite | Clave |
|---|---|---|
| `/auth/*` | 5/min | **IP y credencial**, a la vez |
| `/punch`, `/punch/batch` | 10/min | usuario autenticado |

**El login aplica dos límites simultáneos y manda el más restrictivo.** Solo por IP, una botnet prueba una contraseña por IP contra la misma cuenta sin tocar el límite; solo por credencial, un atacante recorre miles de correos desde una IP. Juntos cierran ambos caminos.

Diez marcaciones por minuto deja margen de sobra para una jornada real (cuatro) más reintentos y sincronización offline, y corta en seco el envío repetido.

### Cabeceras

Se emiten **siempre**, no solo al bloquear: un cliente bien hecho baja el ritmo antes de chocar.

```
RateLimit-Limit: 5
RateLimit-Remaining: 4
RateLimit-Reset: 60
Retry-After: 58        ← solo con el 429
```

### Cuando Redis no está

Cae a un respaldo **en memoria por proceso**, no a dejar pasar todo. Un limitador que se abre ante una caída de infraestructura convierte un incidente en una ventana de fuerza bruta. Con N instancias el límite efectivo es N veces mayor: degradado, pero muy lejos de ilimitado.

> El cliente se conecta al arrancar el servidor (`initRedis`) y `consumeInRedis` espera hasta 250 ms a que la conexión esté lista. Sin eso, la **primera** petición tras cada despliegue se contaría solo en memoria — justo cuando llega la avalancha de reconexiones.

Una petición rechazada **no ocupa sitio** en la ventana: si contara, un cliente que insiste se auto‑prolongaría el bloqueo indefinidamente.

---

## Endurecimiento de las URLs de selfie

- **TTL topado a 15 minutos** en la propia validación de configuración. Una URL firmada de una selfie es un dato biométrico circulando por la red; cuanto menos viva, menor es la ventana en que un enlace reenviado por error sigue sirviendo.
- **La clave del objeto nunca sale en los listados**: el feed expone un booleano `hasSelfie` y la URL se pide aparte, con su propia comprobación de permisos.
- **Las credenciales nunca aparecen en la URL.** La firma SigV4 es un HMAC derivado, no la clave secreta.
- **`S3_PUBLIC_BASE_URL`** (opcional) reescribe el host para servir por un dominio propio o CDN.

### Sobre "no exponer el nombre del bucket"

Conviene ser preciso: una URL firmada **tiene que direccionar el objeto**, así que el host o la ruta contienen inevitablemente el bucket. Enmascararlo tras un dominio propio es posible y está implementado, pero el CDN debe reenviar conservando la cabecera `Host` o la firma no valida.

Dicho eso: **el nombre del bucket no es un secreto y por sí solo no da acceso a nada**. El control real es la firma y su caducidad. Tratar el nombre como una credencial daría una falsa sensación de seguridad; lo que protege el objeto es que sin firma válida no se sirve.

---

## Retención de datos biométricos

[`retention.service.ts`](../packages/api/src/services/retention.service.ts).

Cumple el principio de limitación del plazo de conservación (GDPR art. 5.1.e y equivalentes en LATAM): una selfie de marcación es un dato biométrico y no puede guardarse indefinidamente.

**Se borra la IMAGEN, nunca el registro.** La marcación —hora, ubicación, tipo, resultado de verificación— y su auditoría se conservan intactas: son documentación laboral con plazos propios, mucho más largos, y destruirlas dejaría a la empresa sin prueba de las horas trabajadas.

**El plazo es por empresa** (`Company.dataRetentionMonths`, 12 por defecto): varía por país y por convenio, y un corte global aplicaría el plazo equivocado a casi todas.

**`selfiePurgedAt` distingue «nunca tuvo foto» de «la tuvo y se depuró».** Sin ese campo, una auditoría no podría diferenciar una marcación sin verificar de una depurada conforme a la ley.

**Primero el archivo, después la fila.** Si el orden fuera el inverso y el borrado en S3 fallara, la clave se habría perdido y el objeto quedaría huérfano en el bucket para siempre: un dato biométrico sin dueño ni forma de encontrarlo.

### Derecho al olvido

`purgeUserBiometrics(userId)` borra todas las selfies del colaborador **y su foto de perfil** (es el patrón biométrico de referencia).

Se conserva el registro de asistencia: su base jurídica no es el consentimiento sino el cumplimiento de una obligación legal del empleador, y no decae con la solicitud del interesado.

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/company/retention` | Estado: guardadas, pendientes, ya depuradas |
| POST | `/company/retention/purge` | Purga bajo demanda. `{"dryRun": true}` solo informa |
| PATCH | `/company` | Configura `dataRetentionMonths` (1–120) |

El modo simulación es lo primero que conviene ejecutar al endurecer la política: saber cuánto se borraría antes de borrarlo.

---

## Configuración

```bash
RATE_LIMIT_ENABLED=true
RATE_LIMIT_AUTH_PER_MINUTE=5
RATE_LIMIT_PUNCH_PER_MINUTE=10
REDIS_URL=redis://localhost:6379

FACE_MATCH_ENABLED=false          # requiere además plan ENTERPRISE
FACE_MATCH_INTERVAL_SECONDS=20
AWS_REKOGNITION_REGION=us-east-1

S3_PRESIGN_GET_TTL=300            # topado a 900
RETENTION_INTERVAL_HOURS=24
```

**Se detectan los marcadores de `.env.example` sin rellenar.** Un `<tu-access-key>` es una cadena truthy que pasaría cualquier comprobación de "existe": sin esa detección, un despliegue a medio configurar se comporta como si todo estuviera listo y el fallo aparece en el peor momento — a mitad de un pago, o abortando en silencio el barrido de purga.

---

## Tests

```bash
pnpm --filter @scire/api vitest run src/lib/rate-limit src/middleware/rate-limit src/modules/biometrics src/services/retention
```

El limitador está **apagado por defecto en la batería** (`vitest.setup.ts`): los helpers crean decenas de tenants y cada uno hace tres logins, lo que agotaría el límite en segundos. `src/middleware/rate-limit.test.ts` lo enciende explícitamente, que es donde toca.
