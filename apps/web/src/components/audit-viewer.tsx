"use client";

import { ArrowRight, Lock, LogIn, ScrollText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "../lib/api";
import { ROLE_LABELS, formatDateTime } from "../lib/format";
import { EmptyRecordsArt, EmptyState } from "./empty-state";
import { Motion, MotionItem, MotionList } from "./motion";
import {
  Badge,
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "./ui";

interface AuditEntry {
  id: string;
  entityType: string;
  recordId: string;
  action: string;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  ipAddress: string | null;
  timestamp: string;
  modifiedBy: { id: string; fullName: string; employeeCode: string; role: string } | null;
}

const ACTION_LABELS: Record<string, string> = {
  CREATE: "Creacion",
  UPDATE: "Modificacion",
  DELETE: "Eliminacion",
  VOID: "Anulacion",
  APPROVE: "Aprobacion",
  REJECT: "Rechazo",
  LOGIN: "Inicio de sesion",
  LOGOUT: "Cierre de sesion",
  EXPORT: "Exportacion",
  PERMISSION_CHANGE: "Cambio de permisos",
};

const ACTION_VARIANT: Record<string, "danger" | "warning" | "info" | "success" | "default"> = {
  VOID: "danger",
  DELETE: "danger",
  UPDATE: "warning",
  PERMISSION_CHANGE: "warning",
  APPROVE: "success",
  LOGIN: "default",
};

const ENTITY_LABELS: Record<string, string> = {
  AttendanceRecord: "Marcacion",
  Shift: "Turno",
  Absence: "Ausencia",
  User: "Colaborador",
  Session: "Sesion",
};

const FIELD_LABELS: Record<string, string> = {
  verificationStatus: "Estado de verificacion",
  serverTimestamp: "Hora registrada",
  punchType: "Tipo de marcacion",
  tardinessMinutes: "Minutos de tardanza",
  isVoided: "Anulada",
  status: "Estado",
  role: "Rol",
  startTime: "Hora de inicio",
  endTime: "Hora de fin",
};

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Si" : "No";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
  return String(value);
}

/**
 * Comparacion lado a lado del valor previo y el nuevo.
 *
 * Solo se muestran los campos que cambiaron, porque es lo unico que guarda el
 * registro: almacenar la fila entera duplicaria datos personales sin aportar
 * nada al rastro.
 */
function DiffView({ entry }: { entry: AuditEntry }) {
  const fields = [
    ...new Set([...Object.keys(entry.previousValue ?? {}), ...Object.keys(entry.newValue ?? {})]),
  ];

  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin cambios de campos registrados.</p>;
  }

  return (
    <div className="space-y-1.5">
      {fields.map((field) => (
        <div key={field} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
          <div className="min-w-0 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {FIELD_LABELS[field] ?? field}
            </p>
            <p className="truncate font-medium text-state-danger">
              {renderValue(entry.previousValue?.[field])}
            </p>
          </div>

          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="cambia a" />

          <div className="min-w-0 rounded-lg border border-emerald-500/20 bg-state-success-bg/5 px-2.5 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {FIELD_LABELS[field] ?? field}
            </p>
            <p className="truncate font-medium text-emerald-600 dark:text-state-success">
              {renderValue(entry.newValue?.[field])}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AuditViewer() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  // Por defecto se ocultan los accesos: este modulo existe para inspeccionar
  // modificaciones sobre datos laborales, no el trafico de inicios de sesion.
  const [includeAccess, setIncludeAccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await api<{ items: AuditEntry[]; total: number; totalPages: number }>(
        `/v1/audit${qs({ page, pageSize: 25, entityType, action, scope: includeAccess ? "all" : "changes" })}`,
      );
      setEntries(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch {
      toast.error("No pudimos cargar el rastro de auditoria");
    } finally {
      setIsLoading(false);
    }
  }, [page, entityType, action, includeAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={entityType || "ALL"}
          onValueChange={(value) => {
            setEntityType(value === "ALL" ? "" : value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todas las entidades</SelectItem>
            {Object.entries(ENTITY_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={action || "ALL"}
          onValueChange={(value) => {
            setAction(value === "ALL" ? "" : value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todas las acciones</SelectItem>
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={includeAccess ? "secondary" : "outline"}
          size="sm"
          aria-pressed={includeAccess}
          onClick={() => {
            setIncludeAccess((value) => !value);
            setPage(1);
          }}
        >
          <LogIn />
          {includeAccess ? "Accesos incluidos" : "Incluir accesos"}
        </Button>

        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          Registro de solo lectura
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-32" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <Motion>
          <Card>
            <EmptyState
              art={<EmptyRecordsArt />}
              title="Sin movimientos registrados"
              description='Cada edicion o anulacion de una marcacion aparecera aqui con su autor, motivo y el detalle exacto de lo que cambio. Los inicios de sesion se ocultan por defecto: activalos con "Incluir accesos".'
            />
          </Card>
        </Motion>
      ) : (
        <>
          <MotionList className="space-y-3">
            {entries.map((entry) => (
              <MotionItem key={entry.id}>
              <Card className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={ACTION_VARIANT[entry.action] ?? "default"}>
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </Badge>
                      <span className="text-sm font-semibold">
                        {ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                      </span>
                      <code className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {entry.recordId.slice(-8)}
                      </code>
                    </div>

                    <p className="mt-2 text-sm text-muted-foreground">
                      {entry.modifiedBy ? (
                        <>
                          <span className="font-medium text-foreground">
                            {entry.modifiedBy.fullName}
                          </span>{" "}
                          · {ROLE_LABELS[entry.modifiedBy.role] ?? entry.modifiedBy.role}
                        </>
                      ) : (
                        <span className="italic">Proceso automatico del sistema</span>
                      )}
                    </p>
                  </div>

                  <div className="text-right text-xs text-muted-foreground">
                    <p className="tabular-nums">{formatDateTime(entry.timestamp)}</p>
                    {entry.ipAddress && <p className="mt-0.5 tabular-nums">{entry.ipAddress}</p>}
                  </div>
                </div>

                {entry.reason && (
                  <p className="mt-3 rounded-xl border-l-2 border-primary bg-secondary/50 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Motivo: </span>
                    {entry.reason}
                  </p>
                )}

                {(entry.previousValue || entry.newValue) && (
                  <div className="mt-4">
                    <DiffView entry={entry} />
                  </div>
                )}
              </Card>
              </MotionItem>
            ))}
          </MotionList>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="tabular-nums">{total} movimientos registrados</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Anterior
                </Button>
                <span className="tabular-nums">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Siguiente
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
