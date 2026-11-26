import { describe, expect, it } from "vitest";
import {
  clockSkewSeconds,
  durationSeconds,
  formatDuration,
  isValidTimeString,
  secondsToTime,
  tardinessMinutes,
  timeToSeconds,
  toZonedDateString,
  toZonedTimeString,
  toZonedWeekday,
  weekDaysFrom,
  zonedLocalToUtc,
} from "./time.js";

describe("validacion de HH:mm:ss", () => {
  it("acepta horas validas", () => {
    expect(isValidTimeString("09:00:00")).toBe(true);
    expect(isValidTimeString("23:59:59")).toBe(true);
  });

  it("rechaza formatos invalidos", () => {
    expect(isValidTimeString("24:00:00")).toBe(false);
    expect(isValidTimeString("9:00:00")).toBe(false);
    expect(isValidTimeString("09:00")).toBe(false);
  });
});

describe("conversion de horas", () => {
  it("va y vuelve sin perdida", () => {
    expect(secondsToTime(timeToSeconds("13:00:00"))).toBe("13:00:00");
    expect(timeToSeconds("01:01:01")).toBe(3661);
  });

  it("lanza si el formato es invalido", () => {
    expect(() => timeToSeconds("banana")).toThrow(RangeError);
  });
});

describe("durationSeconds", () => {
  it("calcula la jornada de trabajo de la empresa demo", () => {
    expect(durationSeconds("09:00:00", "18:00:00")).toBe(9 * 3600);
  });

  it("calcula el refrigerio", () => {
    expect(durationSeconds("13:00:00", "14:00:00")).toBe(3600);
  });

  it("asume cruce de medianoche cuando el fin es menor que el inicio", () => {
    expect(durationSeconds("22:00:00", "06:00:00")).toBe(8 * 3600);
  });
});

describe("formatDuration", () => {
  it("formatea horas y minutos", () => {
    expect(formatDuration(8 * 3600)).toBe("8h 0m");
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(-15 * 60)).toBe("-15m");
  });
});

describe("tardinessMinutes", () => {
  it("no cuenta tardanza si llega puntual o antes", () => {
    expect(tardinessMinutes("09:00:00", "08:55:00")).toBe(0);
    expect(tardinessMinutes("09:00:00", "09:00:00")).toBe(0);
  });

  it("cuenta los minutos de retraso", () => {
    expect(tardinessMinutes("09:00:00", "09:12:00")).toBe(12);
  });

  it("descuenta la tolerancia configurada por la empresa", () => {
    expect(tardinessMinutes("09:00:00", "09:08:00", 10)).toBe(0);
    expect(tardinessMinutes("09:00:00", "09:15:00", 10)).toBe(5);
  });
});

describe("clockSkewSeconds", () => {
  it("es positivo cuando el dispositivo va adelantado", () => {
    const server = new Date("2026-09-07T14:00:00Z");
    const device = new Date("2026-09-07T14:00:30Z");
    expect(clockSkewSeconds(device, server)).toBe(30);
  });

  it("es negativo cuando el dispositivo va atrasado (marcacion offline encolada)", () => {
    const server = new Date("2026-09-07T18:00:00Z");
    const device = new Date("2026-09-07T14:00:00Z");
    expect(clockSkewSeconds(device, server)).toBe(-14_400);
  });
});

describe("conversiones a la zona de la empresa", () => {
  it("agrupa una salida nocturna en Lima en el dia local, no en el UTC", () => {
    // 2026-09-08T01:30:00Z = 2026-09-07 20:30 en Lima (UTC-5).
    const instant = new Date("2026-09-08T01:30:00Z");
    expect(toZonedDateString(instant, "America/Lima")).toBe("2026-09-07");
    expect(toZonedTimeString(instant, "America/Lima")).toBe("20:30:00");
  });

  it("usa medianoche como 00:00:00 y no como 24:00:00", () => {
    const instant = new Date("2026-09-07T05:00:00Z"); // 00:00 en Lima
    expect(toZonedTimeString(instant, "America/Lima")).toBe("00:00:00");
  });

  it("calcula el dia de la semana en la zona local", () => {
    // Lunes 20:30 en Lima, aunque en UTC ya sea martes.
    expect(toZonedWeekday(new Date("2026-09-08T01:30:00Z"), "America/Lima")).toBe(1);
  });

  it("weekDaysFrom devuelve de domingo a sabado", () => {
    const days = weekDaysFrom("2026-09-09"); // miercoles
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-09-06"); // domingo
    expect(days[6]).toBe("2026-09-12"); // sabado
  });
});

describe("zonedLocalToUtc", () => {
  it("convierte la hora de pared de Lima (UTC-5) a UTC", () => {
    expect(zonedLocalToUtc("2026-03-02", "08:01:33", "America/Lima").toISOString()).toBe(
      "2026-03-02T13:01:33.000Z",
    );
  });

  it("cruza al dia siguiente en UTC", () => {
    expect(zonedLocalToUtc("2026-03-02", "21:30:00", "America/Lima").toISOString()).toBe(
      "2026-03-03T02:30:00.000Z",
    );
  });

  it("respeta el horario de verano", () => {
    // Madrid: UTC+1 en invierno, UTC+2 en verano.
    expect(zonedLocalToUtc("2026-01-15", "09:00:00", "Europe/Madrid").toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
    expect(zonedLocalToUtc("2026-07-15", "09:00:00", "Europe/Madrid").toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
  });

  it("es la inversa de las conversiones a la zona", () => {
    const instant = zonedLocalToUtc("2026-11-25", "00:00:05", "America/Bogota");
    expect(toZonedDateString(instant, "America/Bogota")).toBe("2026-11-25");
    expect(toZonedTimeString(instant, "America/Bogota")).toBe("00:00:05");
  });
});
