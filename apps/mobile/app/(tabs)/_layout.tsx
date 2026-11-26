import { Redirect, Tabs } from "expo-router";
import { CalendarDays, ChartColumn, Clock, House, Menu } from "lucide-react-native";
import { useAuth } from "../../src/auth/AuthContext";
import { BrandSplash } from "../../src/components/BrandSplash";
import { colors } from "../../src/lib/theme";

/**
 * Navegacion inferior: Inicio · Asistencia · Calendario · Reportes · Mas.
 *
 * Hace ademas de guardia de sesion: si el token se revoca mientras la app esta
 * abierta —RRHH cierra el dispositivo, el empleado causa baja— el
 * AuthContext limpia el usuario y esta redireccion saca de las pantallas
 * privadas al instante.
 */
export default function TabsLayout() {
  const { user, isRestoring } = useAuth();

  if (isRestoring) return <BrandSplash />;
  if (!user) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.teal,
        tabBarInactiveTintColor: colors.slate[500],
        tabBarStyle: {
          backgroundColor: colors.surfaceRaised,
          borderTopColor: "rgba(255,255,255,0.08)",
          borderTopWidth: 1,
          height: 64,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        sceneStyle: { backgroundColor: colors.surface },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Inicio",
          tabBarIcon: ({ color, size }) => <House size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="asistencia"
        options={{
          title: "Asistencia",
          tabBarIcon: ({ color, size }) => <Clock size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="calendario"
        options={{
          title: "Calendario",
          tabBarIcon: ({ color, size }) => <CalendarDays size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="reportes"
        options={{
          title: "Reportes",
          tabBarIcon: ({ color, size }) => <ChartColumn size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="mas"
        options={{
          title: "Mas",
          tabBarIcon: ({ color, size }) => <Menu size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
