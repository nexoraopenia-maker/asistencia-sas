"use client";

import { AlertTriangle, CalendarCheck, Clock, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { api, qs } from "../lib/api";
import { today } from "../lib/format";
import { useBranch } from "./branch-context";
import { Card, Skeleton } from "./ui";

interface Summary {
  totalEmployees: number;
  punctualityRate: number;
  absenteeismRate: number;
  alertCount: number;
  daily: { date: string; present: number; late: number; absent: number }[];
}

/** Tarjetas de estado del dia en curso, encima del feed. */
export function LiveStats() {
  const { selectedId } = useBranch();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setIsLoading(true);
      try {
        const day = today();
        const result = await api<Summary>(
          `/v1/reports/summary${qs({ from: day, to: day, branchId: selectedId })}`,
        );
        if (!cancelled) setSummary(result);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    );
  }

  const day = summary?.daily[0];
  const cards = [
    {
      label: "Colaboradores",
      value: String(summary?.totalEmployees ?? 0),
      hint: "en la seleccion actual",
      icon: Users,
      tone: "text-foreground",
    },
    {
      label: "Presentes hoy",
      value: String((day?.present ?? 0) + (day?.late ?? 0)),
      hint: `${day?.late ?? 0} con tardanza`,
      icon: CalendarCheck,
      tone: "text-state-success",
    },
    {
      label: "Puntualidad",
      value: `${summary?.punctualityRate ?? 0}%`,
      hint: `${summary?.absenteeismRate ?? 0}% de ausentismo`,
      icon: Clock,
      tone: (summary?.punctualityRate ?? 0) >= 90 ? "text-state-success" : "text-state-warning",
    },
    {
      label: "Alertas",
      value: String(summary?.alertCount ?? 0),
      hint: "GPS simulado o fuera de area",
      icon: AlertTriangle,
      tone: (summary?.alertCount ?? 0) > 0 ? "text-state-danger" : "text-muted-foreground",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ label, value, hint, icon: Icon, tone }) => (
        <Card key={label} className="p-5">
          <div className="flex items-start justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <Icon className={`h-4 w-4 ${tone}`} />
          </div>
          <p className={`mt-2 text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </Card>
      ))}
    </div>
  );
}
