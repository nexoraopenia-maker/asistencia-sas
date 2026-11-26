import { z } from "zod";

/**
 * Configuracion de la API validada al arrancar.
 *
 * Se valida con Zod en el arranque, no en el punto de uso: un secreto ausente
 * tumba el proceso al iniciar (visible en el deploy) en lugar de fallar meses
 * despues en la primera marcacion que lo necesite.
 */
const booleanFromEnv = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // --- Autenticacion ---
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET debe tener al menos 32 caracteres"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET debe tener al menos 32 caracteres"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // --- Marcacion / antifraude ---
  GEOFENCE_ACCURACY_BUFFER_M: z.coerce.number().nonnegative().default(25),
  /** true = rechaza la marcacion con GPS falso; false = la guarda como SUSPICIOUS. */
  REJECT_MOCK_LOCATION: booleanFromEnv.default("false"),
  /**
   * Desfase maximo tolerado entre el reloj del movil y el del servidor en una
   * marcacion ONLINE, en segundos. Por encima, la marcacion se marca como
   * sospechosa: el reloj del dispositivo esta manipulado o muy desajustado.
   * No aplica al modo offline, donde el desfase es el tiempo en cola.
   */
  MAX_ONLINE_CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(300),
  /** Antigüedad maxima de una marcacion encolada offline, en horas. */
  MAX_OFFLINE_AGE_HOURS: z.coerce.number().int().positive().default(72),

  // --- Almacenamiento de selfies (S3 / Cloudflare R2) ---
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("scire360-punches"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default("true"),
  /**
   * Dominio propio o CDN por el que servir las selfies.
   *
   * Opcional. Enmascara el host del bucket en las URLs firmadas; el CDN debe
   * reenviar conservando la cabecera Host, o la firma SigV4 no valida.
   */
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_PRESIGN_PUT_TTL: z.coerce.number().int().positive().default(120),
  /**
   * Vida de las URLs firmadas de lectura, en segundos.
   *
   * Topado a 15 minutos por politica: una URL de una selfie es un dato
   * biometrico circulando por la red, y cuanto menos viva, menor es la ventana
   * en que un enlace reenviado por error sigue sirviendo.
   */
  S3_PRESIGN_GET_TTL: z.coerce.number().int().positive().max(900).default(300),

  // --- Notificaciones salientes ---
  N8N_WEBHOOK_URL: z.string().optional(),
  N8N_WEBHOOK_SECRET: z.string().optional(),
  /** Intervalo del despachador del outbox de webhooks, en segundos. */
  WEBHOOK_DISPATCH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  /** Reintentos antes de desactivar un endpoint que no responde. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

  // --- Facturacion ---
  TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  /** Pasarela por defecto. MercadoPago es la prioritaria en LATAM. */
  BILLING_PROVIDER: z
    .enum(["mercadopago", "stripe", "MERCADOPAGO", "STRIPE"])
    .default("mercadopago")
    .transform((v) => v.toUpperCase() as "MERCADOPAGO" | "STRIPE"),
  /** Moneda de cobro. ISO 4217. */
  BILLING_CURRENCY: z.string().length(3).default("USD"),
  /** Cada cuantos minutos corre el cron que suspende trials y gracias vencidas. */
  BILLING_EXPIRATION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),

  // --- Verificacion facial ---
  /** Interruptor de plataforma. Cada empresa tiene ademas el suyo. */
  FACE_MATCH_ENABLED: booleanFromEnv.default("false"),
  /** Cada cuantos segundos corre el trabajador de verificacion facial. */
  FACE_MATCH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
  AWS_REKOGNITION_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // --- Relojes biometricos ---
  /**
   * Dos lecturas del mismo empleado separadas por menos de estos segundos son
   * UNA marcacion: el dedo que no se leyo bien a la primera y se vuelve a
   * apoyar. Sin esto, la segunda lectura se interpretaria como la salida.
   */
  BIOMETRIC_DEBOUNCE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(60),
  /** Antigüedad maxima de una marcacion importada, en dias. Mas atras, RRHH a mano. */
  BIOMETRIC_MAX_AGE_DAYS: z.coerce.number().int().positive().max(366).default(31),

  // --- Retencion de datos ---
  /** Cada cuantas horas corre el barrido de purga de selfies. */
  RETENTION_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),

  // --- Rate limiting ---
  /** Interruptor global. Se apaga en algunos tests que miden otra cosa. */
  RATE_LIMIT_ENABLED: booleanFromEnv.default("true"),
  /** Intentos de autenticacion por minuto y por IP. */
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(5),
  /** Marcaciones por minuto y por usuario. */
  RATE_LIMIT_PUNCH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Lotes de marcaciones biometricas por minuto y por dispositivo. */
  RATE_LIMIT_BIOMETRIC_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /** Peticiones generales por minuto y por IP. */
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(300),

  REDIS_PASSWORD: z.string().optional(),

  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type ApiConfig = z.infer<typeof envSchema>;

let cached: ApiConfig | undefined;

export function loadConfig(): ApiConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuracion de entorno invalida:\n${issues}\n\nRevisa .env.example.`);
  }

  cached = parsed.data;
  return cached;
}

/** Solo para tests: fuerza la relectura del entorno. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Detecta un valor de `.env.example` sin rellenar.
 *
 * Los marcadores tienen la forma `<tu-access-key>`: cadenas perfectamente
 * truthy que pasan cualquier comprobacion de "existe". Sin esto, un despliegue
 * a medio configurar se comporta como si todo estuviera listo y el fallo
 * aparece en el peor momento — a mitad de un pago, o abortando el barrido de
 * purga de datos biometricos en silencio.
 */
export function isPlaceholder(value?: string): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  return trimmed === "" || (trimmed.startsWith("<") && trimmed.endsWith(">"));
}

/**
 * El almacenamiento de selfies solo esta operativo si hay credenciales.
 * Sin ellas la API arranca igual (util en desarrollo y en CI), pero los
 * endpoints que firman URLs devuelven un error explicito en vez de fallar
 * con un mensaje del SDK de AWS.
 */
/**
 * Una pasarela solo esta operativa con credenciales Y secreto de webhook.
 *
 * Sin el secreto se podrian crear cobros pero no verificar las confirmaciones,
 * que es la mitad peligrosa: cualquiera podria activar suscripciones enviando
 * un POST. Mejor no ofrecer el checkout que ofrecerlo a medias.
 */
export function isBillingConfigured(config: ApiConfig): boolean {
  return config.BILLING_PROVIDER === "STRIPE"
    ? looksLikeStripeKey(config.STRIPE_SECRET_KEY) && Boolean(config.STRIPE_WEBHOOK_SECRET)
    : looksLikeMercadoPagoToken(config.MERCADOPAGO_ACCESS_TOKEN) &&
        Boolean(config.MERCADOPAGO_WEBHOOK_SECRET);
}

/**
 * Comprueba el FORMATO de la credencial, no solo que exista.
 *
 * `.env.example` trae marcadores como `<tu-access-token>`, que son cadenas
 * perfectamente truthy. Sin esta comprobacion, un despliegue que olvido
 * rellenar las variables anunciaria la facturacion como operativa y el
 * usuario descubriria el problema en mitad de un pago. Los prefijos son
 * los que documentan ambas pasarelas.
 */
function looksLikeMercadoPagoToken(token?: string): boolean {
  return !isPlaceholder(token) && /^(APP_USR-|TEST-)/.test(token!);
}

function looksLikeStripeKey(key?: string): boolean {
  return !isPlaceholder(key) && /^(sk_live_|sk_test_|rk_live_|rk_test_)/.test(key!);
}

export function isStorageConfigured(config: ApiConfig): boolean {
  return (
    !isPlaceholder(config.S3_ACCESS_KEY_ID) &&
    !isPlaceholder(config.S3_SECRET_ACCESS_KEY) &&
    !isPlaceholder(config.S3_ENDPOINT) &&
    Boolean(config.S3_BUCKET)
  );
}
