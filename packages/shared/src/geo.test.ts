import { describe, expect, it } from "vitest";
import { checkGeofence, haversineDistanceMeters } from "./geo.js";

// Sucursal central de la empresa demo (Lima, Peru).
const BRANCH = { latitude: -12.046374, longitude: -77.042793 };

describe("haversineDistanceMeters", () => {
  it("devuelve 0 para el mismo punto", () => {
    expect(haversineDistanceMeters(BRANCH, BRANCH)).toBe(0);
  });

  it("mide un grado de latitud como ~111 km", () => {
    const d = haversineDistanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("es simetrica", () => {
    const a = { latitude: -12.05, longitude: -77.05 };
    expect(haversineDistanceMeters(BRANCH, a)).toBeCloseTo(haversineDistanceMeters(a, BRANCH), 6);
  });
});

describe("checkGeofence", () => {
  it("acepta un punto dentro del radio", () => {
    const result = checkGeofence({
      point: { latitude: -12.046474, longitude: -77.042793 }, // ~11 m al sur
      center: BRANCH,
      radiusMeters: 100,
    });
    expect(result.isInside).toBe(true);
    expect(result.overshootMeters).toBe(0);
  });

  it("rechaza un punto claramente fuera e informa cuanto se pasa", () => {
    const result = checkGeofence({
      point: { latitude: -12.06, longitude: -77.06 },
      center: BRANCH,
      radiusMeters: 100,
    });
    expect(result.isInside).toBe(false);
    expect(result.overshootMeters).toBeGreaterThan(0);
  });

  it("suma la precision del GPS al radio efectivo", () => {
    const point = { latitude: -12.047374, longitude: -77.042793 }; // ~111 m al sur
    expect(checkGeofence({ point, center: BRANCH, radiusMeters: 100 }).isInside).toBe(false);
    expect(
      checkGeofence({ point, center: BRANCH, radiusMeters: 100, accuracyMeters: 50 }).isInside,
    ).toBe(true);
  });

  it("topa la precision para que un GPS falsamente impreciso no anule la geocerca", () => {
    const result = checkGeofence({
      point: { latitude: -12.5, longitude: -77.5 }, // ~70 km
      center: BRANCH,
      radiusMeters: 100,
      accuracyMeters: 100_000,
      maxAccuracyAllowanceMeters: 100,
    });
    expect(result.isInside).toBe(false);
    expect(result.effectiveRadiusMeters).toBe(200);
  });
});
