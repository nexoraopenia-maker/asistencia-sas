import type { BatchPunchResponse, CreatePunchInput } from "@scire/shared";
import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "../lib/errors";
import { runSync, type QueuedPunch, type RejectedPunch, type SyncDeps } from "./syncCore";

const queued = (id: string, at: string, photoUri: string | null = null): QueuedPunch => ({
  clientPunchId: id,
  payload: {
    clientPunchId: id,
    punchType: "IN",
    branchId: "b1",
    deviceTimestamp: at,
    source: "MOBILE_OFFLINE",
    location: { latitude: 0, longitude: 0, isMockLocation: false },
  },
  photoUri,
  createdAt: 0,
  attempts: 0,
  lastError: null,
});

const respond = (
  punches: CreatePunchInput[],
  status: (id: string) => BatchPunchResponse["results"][number]["status"],
  code = "OUTSIDE_GEOFENCE",
): BatchPunchResponse => {
  const results = punches.map((p) => ({
    clientPunchId: p.clientPunchId,
    status: status(p.clientPunchId),
    ...(status(p.clientPunchId) === "rejected" ? { error: { code, message: code } } : {}),
  }));
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return { results, created: count("created"), duplicates: count("duplicate"), rejected: count("rejected") };
};

function harness(items: QueuedPunch[], overrides: Partial<SyncDeps> = {}) {
  const queue = new Map(items.map((i) => [i.clientPunchId, i]));
  const rejections: RejectedPunch[] = [];
  const sent: CreatePunchInput[][] = [];
  const deps: SyncDeps = {
    listPending: async () => [...queue.values()],
    uploadSelfie: async (uri) => `key:${uri}`,
    attachSelfieKey: async () => {},
    sendBatch: async (punches) => {
      sent.push(punches);
      return respond(punches, () => "created");
    },
    settle: async (settled) => settled.forEach((i) => queue.delete(i.clientPunchId)),
    recordRejection: async (r) => void rejections.push(r),
    markAttempt: async () => {},
    ...overrides,
  };
  return { deps, queue, rejections, sent };
}

describe("runSync", () => {
  it("envia en orden cronologico conservando la hora real y vacia la cola", async () => {
    const h = harness([queued("b", "2026-03-03T02:00:00Z"), queued("a", "2026-03-02T20:00:00Z", "file://a")]);
    const result = await runSync(h.deps);
    expect(h.sent[0]!.map((p) => p.clientPunchId)).toEqual(["a", "b"]);
    expect(h.sent[0]![0]).toMatchObject({
      deviceTimestamp: "2026-03-02T20:00:00Z",
      selfieObjectKey: "key:file://a",
      source: "MOBILE_OFFLINE",
    });
    expect(result).toMatchObject({ synced: 2, deferred: 0 });
    expect(h.queue.size).toBe(0);
  });

  it("un duplicado cuenta como enviado", async () => {
    const h = harness([queued("a", "2026-03-02T20:00:00Z")], {
      sendBatch: async (p) => respond(p, () => "duplicate"),
    });
    expect(await runSync(h.deps)).toMatchObject({ duplicates: 1, deferred: 0 });
    expect(h.queue.size).toBe(0);
  });

  it.each([
    new NetworkError(),
    new ApiError(500, "INTERNAL_ERROR", "caido"),
    new ApiError(402, "FEATURE_NOT_IN_PLAN", "plan"),
  ])("si el lote falla (%s) no se pierde nada", async (error) => {
    const h = harness([queued("a", "2026-03-02T20:00:00Z")], {
      sendBatch: async () => {
        throw error;
      },
    });
    const result = await runSync(h.deps);
    expect(result.deferred).toBe(1);
    expect(result.blockedReason).toBe(error.message);
    expect(h.queue.size).toBe(1);
  });

  it("si una foto no sube por la red, las posteriores no se adelantan", async () => {
    const h = harness(
      [queued("a", "2026-03-02T20:00:00Z", "file://a"), queued("b", "2026-03-03T02:00:00Z")],
      {
        uploadSelfie: async () => {
          throw new ApiError(429, "RATE_LIMITED", "espera");
        },
      },
    );
    expect(await runSync(h.deps)).toMatchObject({ deferred: 2 });
    expect(h.sent).toHaveLength(0);
  });

  it("un rechazo definitivo sale de la cola y queda visible", async () => {
    const h = harness([queued("a", "2026-03-02T20:00:00Z")], {
      sendBatch: async (p) => respond(p, () => "rejected"),
    });
    expect(await runSync(h.deps)).toMatchObject({ rejected: 1, deferred: 0 });
    expect(h.rejections[0]).toMatchObject({ errorCode: "OUTSIDE_GEOFENCE" });
  });

  it("un error interno por elemento retiene esa y las siguientes", async () => {
    const h = harness([queued("a", "2026-03-02T20:00:00Z"), queued("b", "2026-03-03T02:00:00Z")], {
      sendBatch: async (p) => respond(p, () => "rejected", "INTERNAL_ERROR"),
    });
    expect(await runSync(h.deps)).toMatchObject({ rejected: 0, deferred: 2 });
    expect(h.queue.size).toBe(2);
  });

  it("trocea colas largas en lotes de 100", async () => {
    const items = Array.from({ length: 150 }, (_, i) =>
      queued(`p${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    const h = harness(items);
    await runSync(h.deps);
    expect(h.sent.map((batch) => batch.length)).toEqual([100, 50]);
  });
});
