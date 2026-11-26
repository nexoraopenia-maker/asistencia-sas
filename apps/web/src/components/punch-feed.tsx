"use client";

import {
  AlertTriangle,
  Camera,
  Clock,
  LayoutGrid,
  MapPinOff,
  Pause,
  Play,
  Rows3,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, qs } from "../lib/api";
import { formatTime, PUNCH_LABELS } from "../lib/format";
import { useBranch } from "./branch-context";
import { EmptyFeedArt, EmptyState } from "./empty-state";
import { Motion, MotionItem, MotionList } from "./motion";
import { PunchInspector } from "./punch-inspector";
import {
  Badge,
  Button,
  Card,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui";

export interface PunchRecord {
  id: string;
  punchType: string;
  source: string;
  serverTimestamp: string;
  deviceTimestamp: string;
  clockSkewSeconds: number;
  verificationStatus: string;
  isMockLocation: boolean;
  isWithinGeofence: boolean | null;
  distanceMeters: number | null;
  tardinessMinutes: number;
  faceMatchScore: number | null;
  isVoided: boolean;
  hasSelfie: boolean;
  latitude: number | null;
  longitude: number | null;
  user: { id: string; fullName: string; employeeCode: string; jobTitle: string | null };
  branch: { id: string; name: string };
}

/** Cada cuanto se refresca el feed. */
const POLL_MS = 15_000;

/**
 * Estado visual de una marcacion.
 *
 * El orden de las comprobaciones importa: el GPS simulado gana a todo lo demas
 * porque es la senal que exige revision humana; una tardanza en una marcacion
 * falsificada es lo de menos.
 */
function statusOf(record: PunchRecord): { label: string; variant: "success" | "warning" | "danger" | "violet" | "info" } {
  if (record.isMockLocation) return { label: "GPS simulado", variant: "danger" };
  if (record.isWithinGeofence === false) return { label: "Fuera de geocerca", variant: "danger" };
  if (record.punchType === "LUNCH_START" || record.punchType === "LUNCH_END") {
    return { label: "Refrigerio", variant: "violet" };
  }
  if (record.tardinessMinutes > 0) return { label: `Tardanza +${record.tardinessMinutes}m`, variant: "warning" };
  return { label: "Puntual", variant: "success" };
}

function FeedSkeleton({ view }: { view: "table" | "cards" }) {
  return (
    <div className={view === "cards" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2"}>
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className={view === "cards" ? "h-32" : "h-14"} />
      ))}
    </div>
  );
}

export function PunchFeed() {
  const { selectedId } = useBranch();
  const [records, setRecords] = useState<PunchRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<"table" | "cards">("table");
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [inspected, setInspected] = useState<PunchRecord | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ref y no estado: el intervalo lee el valor mas reciente sin tener que
  // reprogramarse en cada cambio de filtro.
  const filters = useRef({ selectedId, onlyAlerts });
  filters.current = { selectedId, onlyAlerts };

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setIsLoading(true);
    try {
      const { selectedId: branchId, onlyAlerts: alerts } = filters.current;
      const result = await api<{ items: PunchRecord[] }>(
        `/v1/punch${qs({ pageSize: 50, branchId, onlyAlerts: alerts ? "true" : undefined })}`,
      );
      setRecords(result.items);
      setLastUpdate(new Date());
      setError(null);
    } catch {
      setError("No pudimos actualizar el feed");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load, selectedId, onlyAlerts]);

  useEffect(() => {
    if (!isLive) return;
    // Se refresca sin spinner: un parpadeo cada 15 s en una pantalla que RRHH
    // deja abierta todo el dia es insoportable.
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [isLive, load]);

  const alertCount = records.filter(
    (record) => record.isMockLocation || record.isWithinGeofence === false,
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={isLive ? "secondary" : "outline"}
          size="sm"
          onClick={() => setIsLive((value) => !value)}
          aria-pressed={isLive}
        >
          {isLive ? <Pause /> : <Play />}
          {isLive ? "En vivo" : "Pausado"}
          {isLive && <span className="ml-1 h-2 w-2 animate-pulse rounded-full bg-state-success-bg" />}
        </Button>

        <Button
          variant={onlyAlerts ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyAlerts((value) => !value)}
          aria-pressed={onlyAlerts}
        >
          <AlertTriangle />
          Solo alertas
          {alertCount > 0 && !onlyAlerts && (
            <Badge variant="danger" className="ml-1">
              {alertCount}
            </Badge>
          )}
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {lastUpdate && (
            <span className="text-xs tabular-nums text-muted-foreground">
              Actualizado {formatTime(lastUpdate.toISOString())}
            </span>
          )}
          <div className="flex rounded-xl border border-border p-0.5">
            <Button
              variant={view === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("table")}
              aria-label="Vista de tabla"
              aria-pressed={view === "table"}
            >
              <Rows3 />
            </Button>
            <Button
              variant={view === "cards" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setView("cards")}
              aria-label="Vista de tarjetas"
              aria-pressed={view === "cards"}
            >
              <LayoutGrid />
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-state-warning-bg/25 bg-state-warning-bg/10 px-4 py-3 text-sm text-state-warning">
          {error}
        </div>
      )}

      {isLoading ? (
        <FeedSkeleton view={view} />
      ) : records.length === 0 ? (
        <Motion>
          <Card>
            <EmptyState
              art={<EmptyFeedArt />}
              title={onlyAlerts ? "Ninguna marcacion con alertas" : "Todavia no hay marcaciones"}
              description={
                onlyAlerts
                  ? "Todas las marcaciones del periodo se registraron dentro del area autorizada y sin senales de GPS simulado."
                  : "Las marcaciones apareceran aqui en cuanto tus colaboradores fichen desde la app movil."
              }
            />
          </Card>
        </Motion>
      ) : view === "cards" ? (
        <MotionList className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {records.map((record) => {
            const status = statusOf(record);
            return (
              <MotionItem key={record.id}>
              <Card
                role="button"
                tabIndex={0}
                onClick={() => setInspected(record)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setInspected(record);
                  }
                }}
                className={`cursor-pointer p-4 transition-colors hover:border-primary/40 ${
                  record.isMockLocation ? "border-rose-500/40 bg-rose-500/[0.04]" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{record.user.fullName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {record.user.jobTitle ?? `ID ${record.user.employeeCode}`}
                    </p>
                  </div>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </div>

                <div className="mt-3 flex items-end justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {PUNCH_LABELS[record.punchType] ?? record.punchType}
                    </p>
                    <p className="text-xl font-bold tabular-nums">
                      {formatTime(record.serverTimestamp)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    {record.hasSelfie && <Camera className="h-3.5 w-3.5" />}
                    {record.isWithinGeofence === false && (
                      <MapPinOff className="h-3.5 w-3.5 text-state-danger" />
                    )}
                    <span className="text-xs">{record.branch.name}</span>
                  </div>
                </div>
              </Card>
              </MotionItem>
            );
          })}
        </MotionList>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Colaborador</TableHead>
                <TableHead>Marcacion</TableHead>
                <TableHead>Hora</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Sucursal</TableHead>
                <TableHead>GPS</TableHead>
                <TableHead className="text-right">Foto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => {
                const status = statusOf(record);
                return (
                  <TableRow
                    key={record.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setInspected(record)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setInspected(record);
                    }}
                    className={`cursor-pointer ${
                      record.isMockLocation ? "bg-rose-500/[0.06] hover:bg-rose-500/10" : ""
                    }`}
                  >
                    <TableCell>
                      <p className="font-medium">{record.user.fullName}</p>
                      <p className="text-xs text-muted-foreground">ID {record.user.employeeCode}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {PUNCH_LABELS[record.punchType] ?? record.punchType}
                    </TableCell>
                    <TableCell className="font-semibold tabular-nums">
                      {formatTime(record.serverTimestamp)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{record.branch.name}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {record.distanceMeters !== null ? `${Math.round(record.distanceMeters)} m` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {record.hasSelfie ? (
                        <Camera className="ml-auto h-4 w-4 text-muted-foreground" />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <PunchInspector record={inspected} onClose={() => setInspected(null)} />
    </div>
  );
}
