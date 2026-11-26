import type { PunchType } from "@scire/shared";
import { LinearGradient } from "expo-linear-gradient";
import { CloudOff, MapPin, X } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { punchErrorMessage, usePunch, type PunchOutcome } from "../hooks/usePunch";
import { useOffline } from "../offline/OfflineContext";
import { colors, CTA_GRADIENT } from "../lib/theme";
import { SelfieCapture } from "./SelfieCapture";

const PUNCH_LABELS: Record<PunchType, string> = {
  IN: "Marcar entrada",
  LUNCH_START: "Iniciar refrigerio",
  LUNCH_END: "Terminar refrigerio",
  OUT: "Marcar salida",
};

/**
 * Hoja de marcacion: selfie, ubicacion y confirmacion.
 *
 * El boton de confirmar solo se habilita cuando hay foto, y sin cobertura el
 * texto cambia a "Guardar sin conexion". Prometer un envio que va a acabar en
 * la cola local seria mentirle al empleado sobre algo que le importa.
 */
export function PunchSheet({
  visible,
  punchType,
  branchId,
  requireSelfie = true,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  punchType: PunchType;
  branchId: string;
  requireSelfie?: boolean;
  onClose: () => void;
  onSuccess: (outcome: PunchOutcome) => void;
}) {
  const { submit, isBusy, isLocating } = usePunch();
  const { isOnline } = useOffline();
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPhotoUri(null);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    try {
      const outcome = await submit({ punchType, branchId, photoUri });
      reset();
      onSuccess(outcome);
    } catch (cause) {
      setError(punchErrorMessage(cause));
    }
  };

  const canSubmit = (!requireSelfie || photoUri !== null) && !isBusy;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View className="flex-1 justify-end bg-black/60">
        <View className="max-h-[92%] rounded-t-3xl border-t border-white/10 bg-surface-raised">
          <View className="items-center pt-3">
            <View className="h-1 w-10 rounded-full bg-white/20" />
          </View>

          <View className="flex-row items-center px-6 pb-2 pt-4">
            <Text className="flex-1 text-xl font-bold text-white">{PUNCH_LABELS[punchType]}</Text>
            <Pressable
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Cerrar"
              hitSlop={12}
              className="h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5"
            >
              <X size={18} color={colors.slate[300]} />
            </Pressable>
          </View>

          <ScrollView contentContainerClassName="gap-4 px-6 pb-8 pt-2">
            {!isOnline && (
              <View className="flex-row items-center rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                <CloudOff size={16} color={colors.amber} />
                <Text className="ml-2 flex-1 text-sm text-amber-300">
                  Sin conexion. Tu marcacion se guardara y se enviara sola al recuperar red.
                </Text>
              </View>
            )}

            {requireSelfie && (
              <SelfieCapture
                photoUri={photoUri}
                onCaptured={setPhotoUri}
                onRetake={() => setPhotoUri(null)}
              />
            )}

            <View className="flex-row items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <MapPin size={16} color={isLocating ? colors.amber : colors.teal} />
              <Text className="ml-2 flex-1 text-sm text-slate-300">
                {isLocating
                  ? "Obteniendo tu ubicacion..."
                  : "Validaremos que estas dentro del area de tu sucursal"}
              </Text>
            </View>

            {error && (
              <View className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3">
                <Text className="text-sm text-rose-300">{error}</Text>
              </View>
            )}

            <Pressable
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit }}
              className={canSubmit ? "" : "opacity-40"}
            >
              <LinearGradient
                colors={[...CTA_GRADIENT]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ borderRadius: 16, paddingVertical: 16, alignItems: "center" }}
              >
                {isBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text className="text-base font-bold text-white">
                    {isOnline ? "Confirmar marcacion" : "Guardar sin conexion"}
                  </Text>
                )}
              </LinearGradient>
            </Pressable>

            {requireSelfie && !photoUri && (
              <Text className="text-center text-xs text-slate-500">
                Toma tu selfie para habilitar la confirmacion
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
