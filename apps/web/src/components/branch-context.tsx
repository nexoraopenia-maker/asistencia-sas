"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";

/**
 * Sucursal seleccionada globalmente.
 *
 * Filtra el feed, los reportes y la nomina desde una sola decision del usuario,
 * en vez de repetir un selector en cada pantalla. La eleccion se recuerda en
 * `localStorage`: quien gestiona una sola sede no deberia volver a elegirla en
 * cada visita.
 */

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
  employeeCount: number;
}

interface BranchContextValue {
  branches: Branch[];
  /** `undefined` = todas las sucursales. */
  selectedId: string | undefined;
  selected: Branch | undefined;
  setSelectedId: (id: string | undefined) => void;
  isLoading: boolean;
  reload: () => Promise<void>;
}

const BranchContext = createContext<BranchContextValue | null>(null);
const STORAGE_KEY = "scire.branch";

export function BranchProvider({ children }: { children: ReactNode }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedId, setSelected] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setBranches(await api<Branch[]>("/v1/company/branches"));
    } catch {
      // Un fallo al cargar sucursales no puede tumbar el panel: se degrada a
      // "todas las sucursales", que es el comportamiento por defecto util.
      setBranches([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setSelected(stored);
    void reload();
  }, [reload]);

  const setSelectedId = useCallback((id: string | undefined) => {
    setSelected(id);
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  const value = useMemo(
    () => ({
      branches,
      selectedId,
      selected: branches.find((branch) => branch.id === selectedId),
      setSelectedId,
      isLoading,
      reload,
    }),
    [branches, selectedId, setSelectedId, isLoading, reload],
  );

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch(): BranchContextValue {
  const context = useContext(BranchContext);
  if (!context) throw new Error("useBranch debe usarse dentro de BranchProvider");
  return context;
}
