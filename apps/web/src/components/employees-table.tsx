"use client";

import { Search, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, qs } from "../lib/api";
import { ROLE_LABELS, STATUS_LABELS, formatDate } from "../lib/format";
import { useBranch } from "./branch-context";
import { EmptySearchArt, EmptyState } from "./empty-state";
import { Motion } from "./motion";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui";

interface Employee {
  id: string;
  email: string;
  fullName: string;
  employeeCode: string;
  jobTitle: string | null;
  role: string;
  status: string;
  hiredAt: string | null;
  lastLoginAt: string | null;
  branch: { id: string; name: string } | null;
}

interface EmployeeList {
  items: Employee[];
  total: number;
  totalPages: number;
  page: number;
  seatsUsed: number;
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "danger" | "default"> = {
  ACTIVE: "success",
  INVITED: "warning",
  SUSPENDED: "warning",
  TERMINATED: "danger",
};

function NewEmployeeDialog({ onCreated }: { onCreated: () => void }) {
  const { branches } = useBranch();
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    employeeCode: "",
    jobTitle: "",
    role: "EMPLOYEE",
    branchId: "",
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      // Se da de alta como invitacion: genera el token de activacion y la
      // persona fija su propia contrasena. RRHH nunca conoce credenciales
      // ajenas, que es lo que hace creible el rastro de auditoria.
      const result = await api<{ invited: number; skipped: { email: string; reason: string }[] }>(
        "/v1/users/invite",
        {
          method: "POST",
          body: {
            invitations: [
              {
                email: form.email.trim(),
                fullName: form.fullName.trim(),
                employeeCode: form.employeeCode.trim(),
                role: form.role,
                ...(form.jobTitle ? { jobTitle: form.jobTitle } : {}),
                ...(form.branchId ? { branchId: form.branchId } : {}),
              },
            ],
          },
        },
      );

      if (result.invited === 0) {
        toast.error(result.skipped[0]?.reason ?? "No se pudo crear el colaborador");
        return;
      }

      toast.success(`${form.fullName} ha sido invitado`, {
        description: "Recibira un enlace para activar su cuenta y fijar su contrasena.",
      });
      setOpen(false);
      setForm({ fullName: "", email: "", employeeCode: "", jobTitle: "", role: "EMPLOYEE", branchId: "" });
      onCreated();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "No se pudo crear el colaborador",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <UserPlus />
        Invitar colaborador
      </Button>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invitar colaborador</DialogTitle>
          <DialogDescription>
            Se enviara un enlace de activacion para que fije su propia contrasena.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="fullName">Nombre completo</Label>
              <Input
                id="fullName"
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="employeeCode">Documento o codigo</Label>
              <Input
                id="employeeCode"
                required
                value={form.employeeCode}
                onChange={(e) => setForm({ ...form, employeeCode: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Correo</Label>
            <Input
              id="email"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="role">Rol</Label>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role })}>
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EMPLOYEE">Colaborador</SelectItem>
                  <SelectItem value="SUPERVISOR">Supervisor</SelectItem>
                  <SelectItem value="HR_ADMIN">Recursos Humanos</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch">Sucursal</Label>
              <Select
                value={form.branchId}
                onValueChange={(branchId) => setForm({ ...form, branchId })}
              >
                <SelectTrigger id="branch">
                  <SelectValue placeholder="Selecciona" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Enviando..." : "Enviar invitacion"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EmployeesTable() {
  const { selectedId } = useBranch();
  const [data, setData] = useState<EmployeeList | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setData(
        await api<EmployeeList>(
          `/v1/users${qs({ page, pageSize: 25, search, branchId: selectedId, status })}`,
        ),
      );
    } catch {
      toast.error("No pudimos cargar los colaboradores");
    } finally {
      setIsLoading(false);
    }
  }, [page, search, selectedId, status]);

  // Debounce de la busqueda: sin el, cada tecla dispararia una consulta.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);

  const changeStatus = async (employee: Employee, newStatus: string) => {
    try {
      await api(`/v1/users/${employee.id}`, { method: "PATCH", body: { status: newStatus } });
      toast.success(`${employee.fullName}: ${STATUS_LABELS[newStatus]}`, {
        description:
          newStatus === "TERMINATED" || newStatus === "SUSPENDED"
            ? "Sus sesiones se cerraron al instante y el cambio quedo en auditoria."
            : "El cambio quedo registrado en auditoria.",
      });
      void load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "No se pudo actualizar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nombre, codigo o correo"
            className="pl-9"
            aria-label="Buscar colaborador"
          />
        </div>

        <Select
          value={status || "ALL"}
          onValueChange={(value) => {
            setStatus(value === "ALL" ? "" : value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos los estados</SelectItem>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <NewEmployeeDialog onCreated={load} />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <Motion>
          <Card>
            <EmptyState
              art={<EmptySearchArt />}
              title={
                search || status
                  ? "Ningun colaborador coincide con la busqueda"
                  : "Todavia no hay colaboradores"
              }
              description={
                search || status
                  ? "Prueba con otro nombre, codigo o correo, o quita los filtros activos."
                  : "Invita a tu primer colaborador para empezar a registrar asistencia."
              }
            />
          </Card>
        </Motion>
      ) : (
        <>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Colaborador</TableHead>
                  <TableHead>Cargo</TableHead>
                  <TableHead>Sucursal</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Ingreso</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell>
                      <p className="font-medium">{employee.fullName}</p>
                      <p className="text-xs text-muted-foreground">
                        ID {employee.employeeCode} · {employee.email}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {employee.jobTitle ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {employee.branch?.name ?? "Sin asignar"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ROLE_LABELS[employee.role] ?? employee.role}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[employee.status] ?? "default"}>
                        {STATUS_LABELS[employee.status] ?? employee.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {employee.hiredAt ? formatDate(employee.hiredAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {employee.status === "ACTIVE" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void changeStatus(employee, "SUSPENDED")}
                        >
                          Suspender
                        </Button>
                      ) : employee.status === "SUSPENDED" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void changeStatus(employee, "ACTIVE")}
                        >
                          Reactivar
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {data.total} colaborador{data.total === 1 ? "" : "es"} · {data.seatsUsed} asientos en uso
            </span>
            {data.totalPages > 1 && (
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
                  {data.page} / {data.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
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
