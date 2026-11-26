/** Zona horaria de referencia del panel. La empresa demo opera en Lima. */
export const TZ = "America/Lima";

/** `HH:mm:ss` de un instante ISO, en la zona de la empresa. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

/** Minutos como `8h 30m`. La unidad de la nomina son minutos, no decimales. */
export function formatMinutes(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const sign = minutes < 0 ? "-" : "";
  return h > 0 ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(cents / 100);
}

/** Fecha de hoy `YYYY-MM-DD` en la zona de la empresa. */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** `YYYY-MM-DD` de hace `days` dias. */
export function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export const PUNCH_LABELS: Record<string, string> = {
  IN: "Entrada",
  OUT: "Salida",
  LUNCH_START: "Inicio refrigerio",
  LUNCH_END: "Fin refrigerio",
};

export const SOURCE_LABELS: Record<string, string> = {
  MOBILE: "Movil",
  MOBILE_OFFLINE: "Movil (sincronizada offline)",
  WEB: "Web",
  MANUAL: "Manual (RRHH)",
  BIOMETRIC: "Reloj biometrico",
};

export const ROLE_LABELS: Record<string, string> = {
  EMPLOYEE: "Colaborador",
  SUPERVISOR: "Supervisor",
  HR_ADMIN: "Recursos Humanos",
  SUPER_ADMIN: "Administrador de plataforma",
};

export const STATUS_LABELS: Record<string, string> = {
  INVITED: "Invitado",
  ACTIVE: "Activo",
  SUSPENDED: "Suspendido",
  TERMINATED: "Baja",
};
