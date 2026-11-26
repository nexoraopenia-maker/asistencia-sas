"use client";

import { periodPresets } from "@scire/shared";
import { today } from "../lib/format";
import { Button } from "./ui";

/** Atajos de cierre: dia, semana, quincenas y mes. */
export function PeriodPresets({
  range,
  onSelect,
}: {
  range: { from: string; to: string };
  onSelect: (range: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Periodos rapidos">
      {periodPresets(today()).map((preset) => {
        const active = preset.from === range.from && preset.to === range.to;
        return (
          <Button
            key={preset.key}
            size="sm"
            variant={active ? "default" : "outline"}
            aria-pressed={active}
            onClick={() => onSelect({ from: preset.from, to: preset.to })}
          >
            {preset.label}
          </Button>
        );
      })}
    </div>
  );
}
