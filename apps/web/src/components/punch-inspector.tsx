"use client";

import { AlertTriangle, ExternalLink, Fingerprint, ImageOff, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, PUNCH_LABELS, SOURCE_LABELS } from "../lib/format";
import type { PunchRecord } from "./punch-feed";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Skeleton } from "./ui";

/**
 * Mapa esquematico de la geocerca.
 *
 * Se dibuja con SVG en vez de cargar un proveedor de mapas: lo que RRHH
 * necesita saber es si el punto cayo dentro del radio y a que distancia, no el
 * callejero. Evita ademas enviar las coordenadas de un empleado a un tercero
 * solo para pintar un recuadro.
 */
function GeofenceMap({ record }: { record: PunchRecord }) {
  const distance = record.distanceMeters ?? 0;
  const inside = record.isWithinGeofence !== false;
  // El radio se normaliza al 40 % del lienzo; el punto se coloca segun su
  // distancia relativa, con tope para que un fichaje a 5 km siga siendo visible.
  const scale = Math.max(distance * 1.4, 100);
  const radiusPx = (100 / scale) * 70;
  const pointPx = Math.min((distance / scale) * 70, 88);

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-secondary/40">
      <svg viewBox="0 0 200 200" className="h-full w-full" role="img" aria-label="Ubicacion respecto a la geocerca">
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="200" height="200" fill="url(#grid)" />

        <circle
          cx="100"
          cy="100"
          r={radiusPx}
          fill={inside ? "rgb(16 185 129 / 0.12)" : "rgb(244 63 94 / 0.10)"}
          stroke={inside ? "rgb(16 185 129)" : "rgb(244 63 94)"}
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
        {/* Centro de la sucursal */}
        <circle cx="100" cy="100" r="3.5" fill="rgb(20 184 166)" />

        {/* Posicion de la marcacion, desplazada en diagonal */}
        <circle
          cx={100 + pointPx * 0.7}
          cy={100 - pointPx * 0.7}
          r="5"
          fill={inside ? "rgb(16 185 129)" : "rgb(244 63 94)"}
          stroke="white"
          strokeWidth="1.5"
        />
      </svg>

      <div className="absolute bottom-2 left-2 right-2 rounded-lg bg-background/90 px-2.5 py-1.5 text-[11px] backdrop-blur">
        <span className={inside ? "text-state-success" : "text-state-danger"}>
          {inside ? "Dentro del area" : "Fuera del area"}
        </span>
        <span className="text-muted-foreground"> · a {Math.round(distance)} m del centro</span>
      </div>
    </div>
  );
}

function SelfieViewer({ recordId, hasSelfie }: { recordId: string; hasSelfie: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!hasSelfie) {
      setState("error");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // La URL se pide en el momento de abrir el modal y caduca en minutos:
        // la imagen nunca es accesible por un enlace permanente.
        const result = await api<{ url: string }>(`/v1/punch/${recordId}/selfie`);
        if (!cancelled) {
          setUrl(result.url);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recordId, hasSelfie]);

  if (state === "loading") return <Skeleton className="aspect-square w-full" />;

  if (state === "error" || !url) {
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-secondary/40 text-muted-foreground">
        <ImageOff className="h-7 w-7" />
        <p className="px-4 text-center text-xs">
          {hasSelfie
            ? "No pudimos recuperar la foto del almacenamiento"
            : "Esta marcacion se registro sin selfie"}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {/* Imagen firmada de vida corta: `next/image` no aplica porque la URL
          cambia en cada apertura y no puede cachearse. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Selfie de la marcacion" className="aspect-square w-full object-cover" />
    </div>
  );
}

export function PunchInspector({
  record,
  onClose,
}: {
  record: PunchRecord | null;
  onClose: () => void;
}) {
  if (!record) return null;

  return (
    <Dialog open={record !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record.user.fullName}</DialogTitle>
          <DialogDescription>
            {PUNCH_LABELS[record.punchType] ?? record.punchType} · {formatDateTime(record.serverTimestamp)}
          </DialogDescription>
        </DialogHeader>

        {record.isMockLocation && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-state-danger-bg/25 bg-state-danger-bg/10 px-4 py-3"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-state-danger" />
            <div className="text-sm">
              <p className="font-semibold text-state-danger">
                Ubicacion simulada detectada
              </p>
              <p className="mt-0.5 text-muted-foreground">
                El dispositivo declaro una posicion falsa. Revisa esta marcacion antes de darla por
                valida.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <SelfieViewer recordId={record.id} hasSelfie={record.hasSelfie} />
          {record.isWithinGeofence === null ? (
            // Reloj biometrico (o marcacion manual): no hay GPS que dibujar, y
            // pintar el punto en el centro de la geocerca seria inventarlo.
            <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-border bg-secondary/40 p-4 text-center">
              <Fingerprint className="h-7 w-7 text-muted-foreground" />
              <p className="text-sm font-medium">Sin ubicacion GPS</p>
              <p className="text-xs text-muted-foreground">
                {record.source === "BIOMETRIC"
                  ? "Registrada en el reloj de la sucursal"
                  : "La marcacion no incluye coordenadas"}
              </p>
            </div>
          ) : (
            <GeofenceMap record={record} />
          )}
        </div>

        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Colaborador</dt>
            <dd className="mt-0.5 font-medium">
              {record.user.fullName}{" "}
              <span className="text-muted-foreground">· ID {record.user.employeeCode}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Sucursal</dt>
            <dd className="mt-0.5 font-medium">{record.branch.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Reloj del servidor
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatDateTime(record.serverTimestamp)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Reloj del dispositivo
            </dt>
            <dd className="mt-0.5 font-medium tabular-nums">
              {formatDateTime(record.deviceTimestamp)}
              {Math.abs(record.clockSkewSeconds) > 60 && (
                <Badge variant="warning" className="ml-2">
                  {record.clockSkewSeconds > 0 ? "+" : ""}
                  {Math.round(record.clockSkewSeconds / 60)} min
                </Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Origen</dt>
            <dd className="mt-0.5 font-medium">
              {SOURCE_LABELS[record.source] ?? record.source}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Verificacion</dt>
            <dd className="mt-0.5 font-medium">
              {record.verificationStatus}
              {record.faceMatchScore !== null && ` · ${record.faceMatchScore}% facial`}
            </dd>
          </div>
        </dl>

        {record.latitude !== null && record.longitude !== null && (
          <div className="mt-5 flex items-center justify-between rounded-xl border border-border bg-secondary/40 px-4 py-3">
            <span className="flex items-center gap-2 text-sm tabular-nums text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" />
              {record.latitude.toFixed(6)}, {record.longitude.toFixed(6)}
            </span>
            <Button variant="ghost" size="sm" asChild>
              <a
                href={`https://www.openstreetmap.org/?mlat=${record.latitude}&mlon=${record.longitude}#map=18/${record.latitude}/${record.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir en mapa <ExternalLink />
              </a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
