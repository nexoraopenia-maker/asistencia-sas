/**
 * Utilidades de tiempo.
 *
 * Convenciones del proyecto:
 * - Los instantes (`serverTimestamp`, `deviceTimestamp`) son SIEMPRE UTC.
 * - Las horas de turno son strings `HH:mm:ss` en la zona horaria de la empresa,
 *   no instantes: "el turno empieza a las 09:00:00" es independiente del DST.
 * - Las fechas de jornada son strings `YYYY-MM-DD` en la zona de la empresa.
 */

/** `HH:mm:ss` en 24 h. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

/** `YYYY-MM-DD`. */
export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isValidTimeString(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function isValidDateString(value: string): boolean {
  return DATE_PATTERN.test(value);
}

/** Convierte `HH:mm:ss` a segundos desde medianoche. */
export function timeToSeconds(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new RangeError(`Hora invalida (se esperaba HH:mm:ss): "${time}"`);
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** Convierte segundos desde medianoche a `HH:mm:ss`. Admite turnos nocturnos (>24 h). */
export function secondsToTime(totalSeconds: number): string {
  const normalized = ((Math.trunc(totalSeconds) % 86_400) + 86_400) % 86_400;
  const h = Math.floor(normalized / 3600);
  const m = Math.floor((normalized % 3600) / 60);
  const s = normalized % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Duracion en segundos entre dos horas `HH:mm:ss`.
 * Si `end` es menor que `start` se asume que el turno cruza la medianoche
 * (ej. 22:00:00 -> 06:00:00 = 8 h).
 */
export function durationSeconds(start: string, end: string): number {
  const startS = timeToSeconds(start);
  const endS = timeToSeconds(end);
  return endS >= startS ? endS - startS : endS + 86_400 - startS;
}

/** Formatea una duracion en segundos como `Xh Ym`. */
export function formatDuration(totalSeconds: number): string {
  const abs = Math.abs(Math.trunc(totalSeconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sign = totalSeconds < 0 ? "-" : "";
  return h > 0 ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}

/** Extrae `HH:mm:ss` UTC de un instante. */
export function toUtcTimeString(date: Date): string {
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** Extrae `YYYY-MM-DD` UTC de un instante. */
export function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Desfase en segundos entre el reloj del dispositivo y el del servidor.
 * Positivo = el dispositivo va adelantado.
 *
 * En una marcacion online un desfase grande delata manipulacion del reloj.
 * En una marcacion offline el desfase es esperado y equivale al tiempo que
 * la marcacion estuvo encolada.
 */
export function clockSkewSeconds(deviceTimestamp: Date, serverTimestamp: Date): number {
  return Math.round((deviceTimestamp.getTime() - serverTimestamp.getTime()) / 1000);
}

/**
 * Minutos de tardanza de una marcacion respecto a la hora prevista del turno.
 * Devuelve 0 si llego puntual o antes. `toleranceMinutes` es la tolerancia
 * configurada por la empresa: dentro de ella, la tardanza no computa.
 */
export function tardinessMinutes(
  scheduledStart: string,
  actualTime: string,
  toleranceMinutes = 0,
): number {
  const diffSeconds = timeToSeconds(actualTime) - timeToSeconds(scheduledStart);
  const lateMinutes = Math.floor(diffSeconds / 60) - toleranceMinutes;
  return lateMinutes > 0 ? lateMinutes : 0;
}

/**
 * Fecha de jornada (`YYYY-MM-DD`) de un instante en la zona de la empresa.
 *
 * Importa mas de lo que parece: una marcacion de salida a las 20:00 en Lima
 * son las 01:00 UTC del dia SIGUIENTE. Agrupar por fecha UTC partiria la
 * jornada en dos y descuadraria la nomina.
 */
export function toZonedDateString(date: Date, timeZone: string): string {
  // `en-CA` produce directamente el formato YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Hora local (`HH:mm:ss`) de un instante en la zona de la empresa. */
export function toZonedTimeString(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Instante UTC de una fecha y hora LOCALES de una zona (`2026-03-02`, `08:01:33`).
 *
 * Es la inversa de `toZonedDateString` + `toZonedTimeString`. La necesitan
 * los relojes biometricos, que guardan la hora de pared sin zona horaria.
 * Se corrige el offset en dos pasadas para que funcione tambien en zonas con
 * horario de verano; en la hora que "no existe" al adelantar el reloj, el
 * resultado cae en el instante valido inmediatamente posterior.
 */
export function zonedLocalToUtc(localDate: string, localTime: string, timeZone: string): Date {
  const target = Date.parse(`${localDate}T${localTime}.000Z`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // h23 y no `hour12: false`: algunos motores pintan la medianoche como "24".
    hourCycle: "h23",
  });

  let guess = target;
  for (let pass = 0; pass < 2; pass++) {
    const p = Object.fromEntries(parts.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`);
    guess += target - wall;
  }
  return new Date(guess);
}

/** Indice de dia de la semana (0 = domingo) de un instante en una zona dada. */
export function toZonedWeekday(date: Date, timeZone: string): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
  return index === -1 ? date.getUTCDay() : index;
}

/** Etiquetas cortas de la tira semanal del movil (`Dom 12` ... `Sab 18`). */
export const WEEKDAY_LABELS_ES = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"] as const;

/**
 * Los 7 dias (domingo -> sabado) de la semana que contiene `date`, como
 * strings `YYYY-MM-DD`. La semana arranca en domingo para coincidir con el
 * CalendarStrip de la app.
 */
export function weekDaysFrom(date: string): string[] {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  const sunday = new Date(anchor);
  sunday.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(sunday);
    day.setUTCDate(sunday.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });
}

/** Zona horaria por defecto para tenants nuevos en LATAM. */
export const DEFAULT_TIMEZONE = "America/Lima";

export interface PeriodPreset {
  key: "today" | "yesterday" | "week" | "fortnight1" | "fortnight2" | "month" | "lastMonth";
  label: string;
  from: string;
  to: string;
}

/**
 * Periodos de cierre habituales a partir de la fecha local de hoy. Son fechas
 * operativas: el reporte incluye completas las jornadas que terminan de
 * madrugada, aunque la salida caiga fuera del rango.
 */
export function periodPresets(today: string): PeriodPreset[] {
  const anchor = new Date(`${today}T12:00:00.000Z`);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m, d, 12)).toISOString().slice(0, 10);
  const date = anchor.getUTCDate();
  const yesterday = day(year, month, date - 1);
  // Semana laboral de lunes a domingo.
  const monday = day(year, month, date - ((anchor.getUTCDay() + 6) % 7));

  return [
    { key: "today", label: "Hoy", from: today, to: today },
    { key: "yesterday", label: "Ayer", from: yesterday, to: yesterday },
    { key: "week", label: "Esta semana", from: monday, to: today },
    { key: "fortnight1", label: "1.a quincena", from: day(year, month, 1), to: day(year, month, 15) },
    { key: "fortnight2", label: "2.a quincena", from: day(year, month, 16), to: day(year, month + 1, 0) },
    { key: "month", label: "Mes actual", from: day(year, month, 1), to: day(year, month + 1, 0) },
    { key: "lastMonth", label: "Mes anterior", from: day(year, month - 1, 1), to: day(year, month, 0) },
  ];
}
