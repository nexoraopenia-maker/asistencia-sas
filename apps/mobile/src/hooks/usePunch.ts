import { PunchSource, type CreatePunchInput, type PunchResult, type PunchType } from "@scire/shared";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { NetworkError } from "../api/client";
import { punchApi } from "../api/endpoints";
import { uploadSelfie } from "../api/upload";
import { useOffline } from "../offline/OfflineContext";
import { useGeolocation, type PunchLocation } from "./useGeolocation";

export { punchErrorMessage } from "../lib/punchFlow";

/**
 * Orquestador de la marcacion.
 *
 * Une los cuatro pasos —posicion, selfie, envio y confirmacion haptica— y
 * decide en cada fallo si toca encolar o avisar al empleado. Esa decision es
 * la parte delicada: encolar un rechazo por geocerca solo aplazaria el mismo
 * error, y mostrar un error por falta de cobertura perderia un fichaje real.
 */

export type PunchOutcome =
  | { kind: "submitted"; result: PunchResult }
  | { kind: "queued"; reason: "offline" | "network" };

interface SubmitInput {
  punchType: PunchType;
  branchId: string;
  /** URI local de la selfie. Null si la empresa no la exige. */
  photoUri: string | null;
}

export function usePunch() {
  const { getLocation, isLocating } = useGeolocation();
  const { isOnline, queuePunch } = useOffline();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const buildPayload = useCallback(
    (
      input: SubmitInput,
      location: PunchLocation,
      selfieObjectKey: string | undefined,
      source: PunchSource,
    ): CreatePunchInput => ({
      punchType: input.punchType,
      branchId: input.branchId,
      location,
      deviceTimestamp: new Date().toISOString(),
      clientPunchId: Crypto.randomUUID(),
      source,
      ...(selfieObjectKey ? { selfieObjectKey } : {}),
    }),
    [],
  );

  const submit = useCallback(
    async (input: SubmitInput): Promise<PunchOutcome> => {
      setIsSubmitting(true);
      try {
        const location = await getLocation();

        // Sin cobertura ni se intenta: se encola con la foto en disco, que se
        // subira al bucket durante la sincronizacion.
        if (!isOnline) {
          const payload = buildPayload(input, location, undefined, PunchSource.MOBILE_OFFLINE);
          await queuePunch(payload, input.photoUri);
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return { kind: "queued", reason: "offline" };
        }

        try {
          const selfieObjectKey = input.photoUri
            ? await uploadSelfie(input.photoUri, input.punchType)
            : undefined;

          const payload = buildPayload(input, location, selfieObjectKey, PunchSource.MOBILE);
          const result = await punchApi.create(payload);

          // Vibracion de exito: la confirmacion fisica importa cuando se ficha
          // con guantes, con el movil a media luz o sin mirar la pantalla.
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return { kind: "submitted", result };
        } catch (error) {
          if (error instanceof NetworkError) {
            // Se cayo la red a mitad del envio. Puede que el servidor la haya
            // recibido igualmente: se encola con el MISMO clientPunchId, asi
            // que si llego, la sincronizacion la vera como duplicado y no
            // creara una segunda marcacion.
            const payload = buildPayload(input, location, undefined, PunchSource.MOBILE_OFFLINE);
            await queuePunch(payload, input.photoUri);
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            return { kind: "queued", reason: "network" };
          }

          // Rechazo del servidor (fuera de geocerca, secuencia invalida, GPS
          // falso): reintentarlo daria lo mismo. Sube tal cual a la pantalla,
          // que ya sabe traducir `error.code` a un mensaje util.
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          throw error;
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [buildPayload, getLocation, isOnline, queuePunch],
  );

  return { submit, isSubmitting, isLocating, isBusy: isSubmitting || isLocating };
}

