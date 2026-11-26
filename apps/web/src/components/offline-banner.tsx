"use client";

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * El panel web necesita conexion: no guarda cambios en cola. Se dice claramente
 * para que nadie crea que algo quedo registrado.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-border bg-secondary px-6 py-3 text-sm font-medium text-state-warning"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      Sin conexion. Los datos pueden estar desactualizados y los cambios no se guardaran.
    </div>
  );
}
