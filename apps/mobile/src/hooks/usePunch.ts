import { PunchSource, type CreatePunchInput, type PunchResult, type PunchType } from "@scire/shared";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { useCallback, useState } from "react";
import { punchApi } from "../api/endpoints";
import { uploadSelfie } from "../api/upload";
import { useOffline } from "../offline/OfflineContext";
import { isTransient } from "../offline/syncCore";
import { useGeolocation } from "./useGeolocation";

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
  const { isOnline, pendingCount, queuePunch, sync } = useOffline();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = useCallback(
    async (input: SubmitInput): Promise<PunchOutcome> => {
      setIsSubmitting(true);
      try {
        // Id y hora se fijan UNA vez, en el momento de marcar: todos los
        // reintentos reutilizan los mismos, asi que no se puede duplicar ni
        // desplazar la hora real.
        const clientPunchId = Crypto.randomUUID();
        const deviceTimestamp = new Date().toISOString();
        const location = await getLocation();
        const base = {
          punchType: input.punchType,
          branchId: input.branchId,
          location,
          deviceTimestamp,
          clientPunchId,
        };

        const queue = async (
          reason: "offline" | "network",
          selfieObjectKey?: string,
        ): Promise<PunchOutcome> => {
          await queuePunch(
            {
              ...base,
              source: PunchSource.MOBILE_OFFLINE,
              ...(selfieObjectKey ? { selfieObjectKey } : {}),
            },
            // La foto en disco se subira al sincronizar si aun no se subio.
            selfieObjectKey ? null : input.photoUri,
          );
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return { kind: "queued", reason };
        };

        // Sin cobertura ni se intenta.
        if (!isOnline) return await queue("offline");
        // Lo pendiente va primero, o el servidor veria la secuencia al reves.
        if (pendingCount > 0) await sync();

        let selfieObjectKey: string | undefined;
        try {
          selfieObjectKey = input.photoUri
            ? await uploadSelfie(input.photoUri, input.punchType)
            : undefined;
          const result = await punchApi.create({
            ...base,
            source: PunchSource.MOBILE,
            ...(selfieObjectKey ? { selfieObjectKey } : {}),
          });
          // Vibracion de exito: la confirmacion fisica importa cuando se ficha
          // con guantes o sin mirar la pantalla.
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return { kind: "submitted", result };
        } catch (error) {
          // Red caida o servidor temporalmente indisponible. Puede que la haya
          // recibido: con el mismo clientPunchId se resolvera como duplicado.
          if (isTransient(error)) return await queue("network", selfieObjectKey);
          // Rechazo definitivo: reintentarlo daria lo mismo.
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          throw error;
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [getLocation, isOnline, pendingCount, queuePunch, sync],
  );

  return { submit, isSubmitting, isLocating, isBusy: isSubmitting || isLocating };
}

