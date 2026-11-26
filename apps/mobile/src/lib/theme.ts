/**
 * Tokens visuales de Scire 360 Chronos para React Native.
 *
 * NativeWind cubre casi todo con clases, pero algunas APIs nativas
 * (LinearGradient, StatusBar, iconos de Lucide) necesitan el valor literal.
 * Este archivo es la unica fuente de esos literales, espejo de
 * `apps/mobile/tailwind.config.js`.
 */
export const colors = {
  brand: {
    400: "#818cf8",
    500: "#6366f1",
    600: "#4f46e5",
    700: "#4338ca",
    900: "#312e81",
    950: "#1e1b4b",
  },
  teal: "#14b8a6",
  violet: "#8b5cf6",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  slate: {
    100: "#f1f5f9",
    300: "#cbd5e1",
    400: "#94a3b8",
    500: "#64748b",
    700: "#334155",
    800: "#1e293b",
    900: "#0f172a",
  },
  surface: "#0f172a",
  surfaceRaised: "#171e35",
} as const;

/** Gradiente maestro noche-purpura de la marca. */
export const BRAND_GRADIENT = ["#0f172a", "#1e1b4b", "#3b0764"] as const;

/** Gradiente de accion primaria (boton de marcar). */
export const CTA_GRADIENT = ["#312e81", "#4f46e5"] as const;

/** Colores por estado de asistencia, alineados con los badges del dashboard web. */
export const STATUS_STYLES = {
  PRESENT: { label: "Presente", dot: colors.emerald, text: "text-emerald-400" },
  LATE: { label: "Tardanza", dot: colors.amber, text: "text-amber-400" },
  ABSENT: { label: "Ausente", dot: colors.rose, text: "text-rose-400" },
  SCHEDULED: { label: "Programado", dot: colors.slate[500], text: "text-slate-400" },
  REST: { label: "Descanso", dot: colors.slate[700], text: "text-slate-500" },
  JUSTIFIED: { label: "Justificado", dot: colors.violet, text: "text-violet-400" },
} as const;

export type AttendanceStatus = keyof typeof STATUS_STYLES;
