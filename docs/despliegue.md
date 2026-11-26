# Despliegue y variables de entorno

## Orden

1. `pnpm db:deploy` (usa `DIRECT_URL`).
2. API.
3. Web.

La web nueva contra una API antigua muestra errores en *Incidencias*; el Excel sale solo con el resumen.

## Web (Vercel)

| Variable | Obligatoria | Uso |
|---|---|---|
| `API_URL` | Sí | URL HTTPS pública de la API. Sin ella usa `http://localhost:4000` y nada funciona |
| `MOBILE_APK_URL` | No | Enlace `https` del APK en `/descargar` |

`NODE_ENV` la define Vercel. La web **no** necesita `DATABASE_URL`, secretos JWT ni claves de almacenamiento.

## API (servidor Node / Docker: `docker/Dockerfile.api`)

Obligatorias:

| Variable | Notas |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon con `-pooler` |
| `DIRECT_URL` | Neon sin `-pooler` (migraciones) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | 32 caracteres o más, distintos |
| `APP_URL` | URL de la web (CORS y enlaces) |
| `REDIS_URL` | Si no hay Redis, los limitadores usan memoria |

Según funciones:

| Función | Variables |
|---|---|
| Selfies | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`, `S3_PRESIGN_PUT_TTL`, `S3_PRESIGN_GET_TTL` |
| Verificación facial | `FACE_MATCH_ENABLED`, `FACE_MATCH_INTERVAL_SECONDS`, `AWS_REKOGNITION_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Cobros | `BILLING_PROVIDER`, `BILLING_CURRENCY`, `BILLING_EXPIRATION_INTERVAL_MINUTES`, `TRIAL_DAYS`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Webhooks | `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `WEBHOOK_DISPATCH_INTERVAL_SECONDS`, `WEBHOOK_MAX_ATTEMPTS` |

Opcionales con valor por defecto (ver `packages/api/src/config.ts`): `PORT`, `BCRYPT_ROUNDS`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `GEOFENCE_ACCURACY_BUFFER_M`, `REJECT_MOCK_LOCATION`, `MAX_ONLINE_CLOCK_SKEW_SECONDS`, `MAX_OFFLINE_AGE_HOURS`, `BIOMETRIC_DEBOUNCE_SECONDS`, `BIOMETRIC_MAX_AGE_DAYS`, `RETENTION_INTERVAL_HOURS`, `RATE_LIMIT_*`, `REDIS_PASSWORD`.

El seed usa `SEED_PASSWORD` y `PLATFORM_ADMIN_*`; no se necesitan en producción en ejecución.

## Móvil (EAS)

`EXPO_PUBLIC_API_URL`. Ver [`mobile.md`](mobile.md).
