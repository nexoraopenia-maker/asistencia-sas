import type { DaySchedule } from "@scire/shared";
import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "./errors";
import { nextPunchType, punchErrorMessage } from "./punchFlow";

function dayWith(types: DaySchedule["punches"][number]["punchType"][]): DaySchedule {
  return {
    date: "2026-09-09",
    weekdayLabel: "Mie",
    dayOfMonth: 9,
    isToday: true,
    work: null,
    lunch: null,
    extraBlocks: [],
    punches: types.map((punchType, index) => ({
      id: `p${index}`,
      punchType,
      time: "09:00:00",
      serverTimestamp: "2026-09-09T14:00:00.000Z",
      isVerified: true,
      hasAlert: false,
    })),
    status: "PRESENT",
    workedMinutes: 0,
    lunchMinutes: 0,
    tardinessMinutes: 0,
  };
}

describe("nextPunchType", () => {
  it("propone la entrada cuando aun no se ha marcado nada", () => {
    expect(nextPunchType(undefined)).toBe("IN");
    expect(nextPunchType(dayWith([]))).toBe("IN");
  });

  it("recorre la jornada en el orden que acepta el servidor", () => {
    expect(nextPunchType(dayWith(["IN"]))).toBe("LUNCH_START");
    expect(nextPunchType(dayWith(["IN", "LUNCH_START"]))).toBe("LUNCH_END");
    expect(nextPunchType(dayWith(["IN", "LUNCH_START", "LUNCH_END"]))).toBe("OUT");
  });

  it("sin red tiene en cuenta lo que quedo en cola", () => {
    const now = Date.parse("2026-09-09T03:00:00Z");
    const pending = [{ punchType: "IN" as const, at: now - 5 * 3_600_000 }];
    expect(nextPunchType(dayWith([]), undefined, { pending, now })).toBe("LUNCH_START");
    expect(nextPunchType(dayWith([]), undefined, { pending, now: now + 24 * 3_600_000 })).toBe("IN");
  });

  it("una copia antigua del calendario no bloquea la entrada del dia siguiente", () => {
    const now = Date.parse("2026-09-10T14:00:00Z");
    const closed = { date: "2026-09-09", isOpen: false, allowedPunches: [] };
    expect(nextPunchType(undefined, closed, { staleSince: now - 24 * 3_600_000, now })).toBe("IN");
  });

  it("en turno noche manda la jornada abierta que informa el servidor", () => {
    const current = { date: "2026-09-08", isOpen: true, allowedPunches: ["OUT" as const] };
    expect(nextPunchType(dayWith([]), current)).toBe("OUT");
  });

  it("no ofrece ninguna accion con la jornada cerrada", () => {
    expect(nextPunchType(dayWith(["IN", "LUNCH_START", "LUNCH_END", "OUT"]))).toBeNull();
  });
});

describe("punchErrorMessage", () => {
  it("dice cuantos metros faltan cuando el servidor los informa", () => {
    const error = new ApiError(422, "OUTSIDE_GEOFENCE", "Fuera del area", {
      distanceMeters: 341.7,
    });
    expect(punchErrorMessage(error)).toContain("342 m");
  });

  it("cae al mensaje del servidor si no vino la distancia", () => {
    const error = new ApiError(422, "OUTSIDE_GEOFENCE", "Estas fuera del area autorizada");
    expect(punchErrorMessage(error)).toBe("Estas fuera del area autorizada");
  });

  it("conserva el mensaje del servidor en una secuencia invalida", () => {
    // El backend explica cual fue la ultima marcacion: mas util que un texto fijo.
    const message = 'No puedes registrar "IN" ahora. Tu ultima marcacion fue "OUT".';
    expect(punchErrorMessage(new ApiError(409, "INVALID_PUNCH_SEQUENCE", message))).toBe(message);
  });

  it("traduce el GPS simulado a una instruccion accionable", () => {
    const result = punchErrorMessage(new ApiError(422, "MOCK_LOCATION_DETECTED", "mock"));
    expect(result).toContain("ubicacion falsa");
  });

  it("un fallo de red avisa de que la marcacion quedo en cola", () => {
    expect(punchErrorMessage(new NetworkError())).toContain("cola");
  });

  it("un fallo del almacenamiento no culpa al empleado", () => {
    const result = punchErrorMessage(new ApiError(502, "STORAGE_ERROR", "S3 no disponible"));
    expect(result).toContain("Recursos Humanos");
    expect(result).not.toContain("Vuelve a tomarla");
  });

  it("nunca devuelve vacio ante un error desconocido", () => {
    expect(punchErrorMessage({ raro: true })).toBeTruthy();
  });
});
