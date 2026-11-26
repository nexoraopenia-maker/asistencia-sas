import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Camera, Check, RotateCcw } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { colors } from "../lib/theme";

/**
 * Badge de "Foto lista" con animacion de confirmacion.
 *
 * El check entra con un muelle y una insinuacion de rebote —no un rebote
 * completo, que se leeria como juguetón en una herramienta de fichaje— y el
 * texto le sigue con un retardo corto. Esa secuencia es lo que hace que la
 * confirmacion se perciba como "hecho" y no como un elemento que simplemente
 * aparece.
 *
 * Toda la animacion vive en el hilo de UI (escala y opacidad): la captura de
 * la camara deja el hilo de JS ocupado un instante, y una animacion basada en
 * estado de React se veria a saltos justo aqui.
 */
function ConfirmationBadge() {
  const scale = useSharedValue(0.6);
  const opacity = useSharedValue(0);
  const labelOpacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 140 });
    scale.value = withSequence(
      withSpring(1.12, { damping: 12, stiffness: 260, mass: 0.5 }),
      withSpring(1, { damping: 16, stiffness: 240 }),
    );
    labelOpacity.value = withDelay(120, withTiming(1, { duration: 180 }));
  }, [opacity, scale, labelOpacity]);

  const checkStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  const labelStyle = useAnimatedStyle(() => ({ opacity: labelOpacity.value }));

  return (
    <View
      className="flex-row items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5"
      accessibilityRole="text"
      accessibilityLabel="Foto lista"
    >
      <Animated.View
        style={checkStyle}
        className="h-5 w-5 items-center justify-center rounded-full bg-emerald-500"
      >
        <Check size={12} color="#052e2b" strokeWidth={3} />
      </Animated.View>
      <Animated.Text style={labelStyle} className="ml-2 text-sm font-semibold text-emerald-400">
        Foto lista
      </Animated.Text>
    </View>
  );
}

/**
 * Captura de la selfie de verificacion.
 *
 * Camara frontal fija y sin galeria: el objetivo es una foto EN VIVO del
 * empleado en el momento de marcar. Permitir elegir del carrete convertiria la
 * verificacion en un tramite decorativo.
 *
 * La foto se comprime al 60 %: suficiente para que el face-match de la FASE 7
 * funcione, y lo bastante ligera para subirse con cobertura mala.
 */
export function SelfieCapture({
  photoUri,
  onCaptured,
  onRetake,
}: {
  photoUri: string | null;
  onCaptured: (uri: string) => void;
  onRetake: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [isCapturing, setIsCapturing] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  const takePicture = async () => {
    if (!cameraRef.current || isCapturing) return;
    setIsCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.6,
        // Sin post-procesado: acelera bastante la captura en gama media y la
        // foto no necesita correccion de color para verificar una identidad.
        skipProcessing: true,
      });
      if (photo?.uri) {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onCaptured(photo.uri);
      }
    } finally {
      setIsCapturing(false);
    }
  };

  if (!permission) {
    return (
      <View className="h-64 items-center justify-center rounded-3xl border border-white/10 bg-white/5">
        <ActivityIndicator color={colors.teal} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View className="items-center rounded-3xl border border-white/10 bg-white/5 px-6 py-8">
        <Camera size={28} color={colors.slate[400]} />
        <Text className="mt-3 text-center text-sm text-slate-300">
          Necesitamos la camara para tomar la selfie que verifica tu marcacion
        </Text>
        <Pressable
          onPress={() => void requestPermission()}
          accessibilityRole="button"
          className="mt-4 rounded-2xl bg-brand-600 px-5 py-2.5"
        >
          <Text className="text-sm font-semibold text-white">Permitir camara</Text>
        </Pressable>
      </View>
    );
  }

  // --- Vista previa con el badge de confirmacion ---------------------------
  if (photoUri) {
    return (
      <View>
        <View className="overflow-hidden rounded-3xl border border-emerald-500/30">
          <Image
            source={{ uri: photoUri }}
            style={{ width: "100%", height: 260 }}
            resizeMode="cover"
            accessibilityLabel="Selfie capturada para la marcacion"
          />
        </View>

        <View className="mt-3 flex-row items-center justify-between">
          <ConfirmationBadge />

          <Pressable
            onPress={onRetake}
            accessibilityRole="button"
            accessibilityLabel="Repetir la foto"
            hitSlop={8}
            className="flex-row items-center rounded-full border border-white/10 bg-white/5 px-3 py-1.5"
          >
            <RotateCcw size={14} color={colors.slate[300]} />
            <Text className="ml-1.5 text-sm text-slate-300">Repetir</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // --- Camara en vivo ------------------------------------------------------
  return (
    <View>
      <View className="overflow-hidden rounded-3xl border border-white/10">
        <CameraView ref={cameraRef} facing="front" style={{ width: "100%", height: 260 }} />
      </View>

      <Pressable
        onPress={() => void takePicture()}
        disabled={isCapturing}
        accessibilityRole="button"
        accessibilityLabel="Tomar selfie"
        className="mt-3 flex-row items-center justify-center rounded-2xl border border-teal/30 bg-teal/10 py-3"
      >
        {isCapturing ? (
          <ActivityIndicator size="small" color={colors.teal} />
        ) : (
          <>
            <Camera size={18} color={colors.teal} />
            <Text className="ml-2 text-sm font-semibold text-teal">Tomar selfie</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}
