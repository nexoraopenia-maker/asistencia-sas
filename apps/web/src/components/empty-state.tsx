import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * Estados vacios ilustrados.
 *
 * Las ilustraciones son SVG en linea, no imagenes: heredan el color del tema
 * —asi funcionan igual en claro y oscuro sin duplicar assets—, pesan unos
 * cientos de bytes y no provocan un salto de layout al cargar.
 *
 * Cada una dibuja el objeto que falta (un calendario sin turnos, una lupa sin
 * resultados) en vez de un icono generico: el dibujo explica la situacion
 * antes de que se lea el texto.
 */

function IllustrationFrame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 160 120"
      className="h-28 w-40 text-muted-foreground"
      fill="none"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Calendario con los dias vacios. */
export function EmptyScheduleArt() {
  return (
    <IllustrationFrame>
      <rect x="26" y="24" width="108" height="80" rx="12" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
      <path d="M26 46h108" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
      <path d="M52 16v16M108 16v16" stroke="currentColor" strokeOpacity=".45" strokeWidth="3" strokeLinecap="round" />
      {[0, 1, 2, 3].map((col) =>
        [0, 1].map((row) => (
          <rect
            key={`${col}-${row}`}
            x={40 + col * 22}
            y={58 + row * 20}
            width="14"
            height="10"
            rx="3"
            fill="currentColor"
            fillOpacity={row === 0 && col === 1 ? ".22" : ".08"}
          />
        )),
      )}
      <circle cx="118" cy="88" r="14" fill="hsl(var(--state-info-bg))" fillOpacity=".12" />
      <path d="M113 88h10M118 83v10" stroke="hsl(var(--state-info-fg))" strokeWidth="2" strokeLinecap="round" />
    </IllustrationFrame>
  );
}

/** Lupa sobre una lista sin coincidencias. */
export function EmptySearchArt() {
  return (
    <IllustrationFrame>
      <rect x="20" y="26" width="76" height="72" rx="10" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x="32"
          y={42 + row * 18}
          width={52 - row * 12}
          height="8"
          rx="4"
          fill="currentColor"
          fillOpacity=".1"
        />
      ))}
      <circle cx="112" cy="56" r="24" fill="hsl(var(--background))" stroke="currentColor" strokeOpacity=".45" strokeWidth="3" />
      <path d="M130 74l14 14" stroke="currentColor" strokeOpacity=".45" strokeWidth="4" strokeLinecap="round" />
      <path d="M104 56h16" stroke="currentColor" strokeOpacity=".3" strokeWidth="2.5" strokeLinecap="round" />
    </IllustrationFrame>
  );
}

/** Reloj en calma: no hay actividad todavia. */
export function EmptyFeedArt() {
  return (
    <IllustrationFrame>
      <circle cx="80" cy="60" r="34" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
      <circle cx="80" cy="60" r="46" stroke="currentColor" strokeOpacity=".12" strokeWidth="2" strokeDasharray="5 7" />
      <path d="M80 40v20l14 9" stroke="hsl(var(--accent))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="80" cy="60" r="3" fill="hsl(var(--accent))" />
      <rect x="28" y="98" width="104" height="8" rx="4" fill="currentColor" fillOpacity=".07" />
    </IllustrationFrame>
  );
}

/** Carpeta vacia para historiales y registros. */
export function EmptyRecordsArt() {
  return (
    <IllustrationFrame>
      <path
        d="M24 40a8 8 0 018-8h24l10 12h38a8 8 0 018 8v40a8 8 0 01-8 8H32a8 8 0 01-8-8V40z"
        stroke="currentColor"
        strokeOpacity=".28"
        strokeWidth="2"
      />
      <path d="M24 62h112" stroke="currentColor" strokeOpacity=".18" strokeWidth="2" strokeDasharray="4 6" />
      <rect x="44" y="74" width="48" height="7" rx="3.5" fill="currentColor" fillOpacity=".1" />
      <rect x="44" y="86" width="30" height="7" rx="3.5" fill="currentColor" fillOpacity=".07" />
    </IllustrationFrame>
  );
}

export function EmptyState({
  art,
  title,
  description,
  action,
  className,
}: {
  art?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 px-6 py-14 text-center",
        className,
      )}
    >
      {art ?? <EmptyRecordsArt />}
      <p className="mt-4 text-base font-semibold">{title}</p>
      {description && (
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
