import { describe, expect, it } from "vitest";
import {
  computeJornada,
  DEFAULT_LABOR_RULES,
  payReference,
  weeklyExcess,
  type JornadaPunch,
  type LaborRules,
} from "./labor.js";
import { zonedLocalToUtc } from "./time.js";
import {
  buildSessions,
  nightMinutes,
  resolveOperationalDate,
  resolvePunchState,
  splitOvertime,
  type ShiftSlot,
} from "./workday.js";

const TZ = "America/Lima";
const rules: LaborRules = { ...DEFAULT_LABOR_RULES, timezone: TZ };
const at = (local: string) => {
  const [date, time] = local.split(" ");
  return zonedLocalToUtc(date!, `${time}:00`, TZ);
};
const punch = (punchType: string, local: string): JornadaPunch => ({
  id: `${punchType}@${local}`,
  punchType,
  at: at(local),
  tardinessMinutes: 0,
  isMockLocation: false,
  isWithinGeofence: null,
});
const shift = (date: string, startTime: string, endTime: string, type = "WORK"): ShiftSlot => ({
  date,
  startTime: `${startTime}:00`,
  endTime: `${endTime}:00`,
  type,
});

function sessionsOf(punches: JornadaPunch[], shifts: ShiftSlot[] = [], now = at("2026-03-10 12:00")) {
  return buildSessions(punches, {
    maxShiftHours: 16,
    now,
    operationalDateFor: (instant) => resolveOperationalDate(instant, TZ, shifts).date,
  });
}

describe("jornadas que cruzan medianoche", () => {
  it("una sesion 20:00 -> 04:00 es UNA jornada en la fecha de inicio", () => {
    const sessions = sessionsOf([
      punch("IN", "2026-03-02 20:00"),
      punch("LUNCH_START", "2026-03-03 00:00"),
      punch("LUNCH_END", "2026-03-03 00:30"),
      punch("OUT", "2026-03-03 04:00"),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ operationalDate: "2026-03-02", status: "CLOSED" });
  });

  it("llegar pasada la medianoche cuenta para el turno de la noche anterior", () => {
    const result = resolveOperationalDate(at("2026-03-03 00:10"), TZ, [
      shift("2026-03-02", "23:00", "07:00"),
    ]);
    expect(result.date).toBe("2026-03-02");
  });

  it("una entrada de la tarde pertenece al turno de hoy, no al de anoche", () => {
    const result = resolveOperationalDate(at("2026-03-03 19:40"), TZ, [
      shift("2026-03-02", "20:00", "04:00"),
      shift("2026-03-03", "20:00", "04:00"),
    ]);
    expect(result.date).toBe("2026-03-03");
  });

  it("sin salida dentro del plazo sigue abierta; vencido es incidencia", () => {
    const entry = [punch("IN", "2026-03-02 20:00")];
    expect(sessionsOf(entry, [], at("2026-03-03 03:00"))[0]!.status).toBe("OPEN");
    expect(sessionsOf(entry, [], at("2026-03-03 13:00"))[0]!.status).toBe("MISSING_OUT");
  });

  it("una salida fuera de plazo queda huerfana y no inventa horas", () => {
    const sessions = sessionsOf([punch("IN", "2026-03-02 08:00"), punch("OUT", "2026-03-03 09:00")]);
    expect(sessions.map((s) => s.status)).toEqual(["MISSING_OUT", "ORPHAN"]);
  });
});

describe("secuencia", () => {
  const closed = sessionsOf([punch("IN", "2026-03-02 08:00"), punch("OUT", "2026-03-02 12:00")]);
  const base = { sessions: closed, newSessionDate: "2026-03-02" };

  it("con la jornada cerrada no admite mas, salvo turno partido", () => {
    expect(resolvePunchState({ ...base, workShiftsOnNewDate: 1, allowSplitShifts: false }).allowed).toEqual([]);
    expect(resolvePunchState({ ...base, workShiftsOnNewDate: 2, allowSplitShifts: false }).allowed).toEqual(["IN"]);
    expect(resolvePunchState({ ...base, workShiftsOnNewDate: 0, allowSplitShifts: true }).allowed).toEqual(["IN"]);
  });

  it("una sesion abierta de ayer admite su salida", () => {
    const open = sessionsOf([punch("IN", "2026-03-02 20:00")], [], at("2026-03-03 01:00"));
    const state = resolvePunchState({
      sessions: open,
      newSessionDate: "2026-03-03",
      workShiftsOnNewDate: 0,
      allowSplitShifts: false,
    });
    expect(state.operationalDate).toBe("2026-03-02");
    expect(state.allowed).toContain("OUT");
  });
});

describe("horario nocturno y sobretiempo", () => {
  it("cuenta solo el tramo 22:00-06:00 local", () => {
    const interval = { start: at("2026-03-02 18:00"), end: at("2026-03-03 07:00") };
    expect(nightMinutes([interval], TZ)).toBe(480);
  });

  it("reparte 2 h al primer tramo y el resto al segundo", () => {
    expect(splitOvertime(690, 480, { thresholdMinutes: 0, tier1Minutes: 120 })).toEqual({
      overtimeMinutes: 210,
      tier1Minutes: 120,
      tier2Minutes: 90,
    });
  });

  it("desglosa una jornada nocturna con sobretiempo", () => {
    const shifts = [shift("2026-03-02", "20:00", "04:00"), shift("2026-03-02", "00:00", "00:30", "LUNCH")];
    const day = computeJornada({
      date: "2026-03-02",
      shifts,
      sessions: sessionsOf(
        [
          punch("IN", "2026-03-02 20:00"),
          punch("LUNCH_START", "2026-03-03 00:00"),
          punch("LUNCH_END", "2026-03-03 00:30"),
          punch("OUT", "2026-03-03 06:30"),
        ],
        shifts,
      ),
      rules,
      approvedOvertimeMinutes: null,
      hasApprovedAbsence: false,
      today: "2026-03-10",
    });
    expect(day).toMatchObject({
      scheduledMinutes: 450,
      workedMinutes: 600,
      ordinaryMinutes: 450,
      overtimeMinutes: 150,
      overtimeTier1Minutes: 120,
      overtimeTier2Minutes: 30,
      // 22:00-06:00 menos 30 min de refrigerio.
      nightMinutes: 450,
      isNightShift: true,
      crossesMidnight: true,
      earlyLeaveMinutes: 0,
    });
    expect(day.incidents.map((i) => i.code)).toContain("OVERTIME_NOT_AUTHORIZED");
  });

  it("senala el exceso semanal no cubierto por el sobretiempo diario", () => {
    const week = ["02", "03", "04", "05", "06", "07", "08"].map((d) => ({
      date: `2026-03-${d}`,
      ordinaryMinutes: 480,
    }));
    expect(weeklyExcess(week, 2880)[0]!.excessMinutes).toBe(480);
  });

  it("calcula las referencias sobre la RMV configurada", () => {
    expect(payReference({ ...rules, minimumWage: 1000 })).toMatchObject({
      nightMinimumMonthly: 1350,
      minimumWageHourly: 4.17,
      overtimeTier1Factor: 1.25,
    });
    expect(payReference({ ...rules, minimumWage: null }).nightMinimumMonthly).toBeNull();
    // RMV por defecto: 1 230 x 1.35.
    expect(payReference(rules).nightMinimumMonthly).toBe(1660.5);
  });
});
