# App móvil — Scire 360 Chronos

Expo SDK 54 · React Native 0.81 · expo-router · NativeWind 4

---

## Estructura

```
apps/mobile/
├── app/                          Rutas (expo-router)
│   ├── _layout.tsx               Providers + fuentes
│   ├── index.tsx                 Redirección según sesión
│   ├── login.tsx                 Acceso con correo o biometría
│   └── (tabs)/                   Inicio · Asistencia · Calendario · Reportes · Más
└── src/
    ├── api/       client (refresco single-flight) · endpoints · upload
    ├── auth/      AuthContext: sesión, biometría, cierre
    ├── offline/   queue (SQLite) · syncCore · sync · OfflineContext
    ├── hooks/     useGeolocation · usePunch · useWeeklySchedule
    ├── components/EmployeeHeader · CalendarStrip · ShiftDetailModal · SelfieCapture · PunchSheet · SyncIndicator
    └── lib/       theme · storage · errors · punchFlow
```

---

## Configuración

```bash
# apps/mobile/.env.local  (o EXPO_PUBLIC_API_URL en el entorno)
EXPO_PUBLIC_API_URL=http://localhost:4000
```

> **En un dispositivo físico `localhost` es el propio teléfono.** Apunta a la IP de tu máquina en la red local (`http://192.168.1.x:4000`) o a un túnel. En el simulador de iOS `localhost` sí funciona; en el emulador de Android usa `http://10.0.2.2:4000`.

```bash
pnpm --filter @scire/mobile dev      # Metro
pnpm --filter @scire/mobile ios      # simulador iOS
pnpm --filter @scire/mobile android  # emulador Android
pnpm --filter @scire/mobile build    # bundles Hermes iOS + Android
```

---

## Sesión y biometría

Los tokens van a **`expo-secure-store`** —Keychain en iOS, KeyStore cifrado en Android—, nunca a AsyncStorage: en un dispositivo con root o en una copia de seguridad sin cifrar, AsyncStorage es texto plano.

**El refresco es single-flight.** No es una optimización: el backend detecta la reutilización de refresh tokens y responde revocando *todas* las sesiones del usuario. Si la pantalla de inicio lanza tres peticiones en paralelo y las tres caducan a la vez, tres refrescos con el mismo token se leerían como un robo de credenciales y echarían al empleado de la aplicación. `src/api/client.ts` comparte una única promesa de refresco entre todas ellas.

**La biometría no viaja.** La huella o Face ID se validan en el dispositivo y lo único que hacen es autorizar el uso del refresh token guardado en el keychain; a partir de ahí el flujo es un refresco normal contra `/auth/biometric`. El servidor no recibe ni almacena plantillas biométricas.

---

## Marcación

```
1. Selfie en vivo (cámara frontal, sin galería)
2. Ubicación fresca — nunca la última conocida
3. Presigned URL → PUT directo al bucket
4. POST /punch → vibración de confirmación
```

Detalles que importan:

- **Cámara frontal fija y sin acceso a galería.** Permitir elegir del carrete convertiría la verificación en un trámite decorativo.
- **Siempre una lectura de GPS fresca.** Una posición cacheada de hace una hora podría situar al empleado dentro de la geocerca desde su casa.
- **La foto se sube con `uploadAsync`, no con `fetch` + blob.** Convertir una imagen de varios MB a blob la carga entera en memoria JS; `uploadAsync` la transmite desde disco.
- **El botón de acción usa `VALID_PUNCH_TRANSITIONS` de `@scire/shared`** — la misma tabla que valida el servidor. La app nunca ofrece una marcación que el backend vaya a rechazar.
- **Feedback háptico diferenciado**: éxito al registrar, aviso al encolar, error al rechazar. Importa cuando se ficha con guantes o sin mirar la pantalla.

---

## Modo sin conexión

Cola en **SQLite** (`src/offline/queue.ts`). La lógica de envío está en `syncCore.ts` (sin dependencias nativas, con pruebas); `sync.ts` la conecta con el dispositivo.

| Situación | Comportamiento |
|---|---|
| Marcar sin red | Se guarda con su hora real y la selfie se copia a documentos (la caché puede borrarse) |
| Corte a mitad de envío, 5xx o 429 | Se encola con **el mismo `clientPunchId` y la misma hora**; si ya había llegado, vuelve como duplicado |
| Rechazo definitivo (p. ej. geocerca) | Sale de la cola y queda visible en *Más* |
| Fallo transitorio al sincronizar | Nada se borra; se respeta el orden |
| Cierre de sesión o sesión caducada | La cola se conserva, ligada a su dueño |
| Abrir la app sin red | Usa el perfil y el calendario guardados (hay que haber iniciado sesión antes) |

La sincronización se dispara al iniciar sesión, al volver a primer plano, al recuperar red y cada 60 s mientras queden pendientes. La pantalla muestra *pendiente*, *sincronizando* y *sincronizadas*.

Límites:

- El lote offline requiere un plan que lo incluya; si no, las marcaciones quedan en cola y se muestra el motivo.
- El servidor rechaza marcaciones con más de `MAX_OFFLINE_AGE_HOURS` (72 h). RRHH puede regularizarlas.
- Los rechazos solo se ven en el teléfono; RRHH no recibe aviso.
- La hora offline es la del teléfono. El servidor conserva la hora de recepción para auditarla.
- Desinstalar la app borra la cola.

---

## Distribución (APK / tiendas)

La compilación se hace con **EAS Build** (servicio de Expo, requiere una cuenta). La configuración está en `apps/mobile/eas.json`. El hook `eas-build-post-install` compila `@scire/shared` en el servidor de Expo.

```bash
cd apps/mobile
npx eas-cli@latest login
npx eas-cli@latest init          # una vez: vincula el proyecto (añade projectId a app.json)

# URL pública HTTPS de la API: obligatoria, no uses localhost
npx eas-cli@latest env:create --environment preview \
  --name EXPO_PUBLIC_API_URL --value https://api.tu-dominio.com --visibility plaintext

npx eas-cli@latest build --platform android --profile preview      # APK instalable
npx eas-cli@latest build --platform android --profile production   # AAB para Google Play
```

Para producción, repite `env:create` con `--environment production`. Para iOS se necesita una cuenta de Apple Developer (`--platform ios`) y distribuir por TestFlight.

### Publicar el enlace de descarga

1. Descarga el APK desde el enlace que entrega EAS (los enlaces internos caducan).
2. Súbelo a un alojamiento HTTPS estable (por ejemplo, un *Release* de GitHub).
3. Define `MOBILE_APK_URL` en las variables del proyecto web y vuelve a desplegar.

Empleados y administradores lo descargan desde `/descargar`.

---

## Interfaz

| Pantalla | Contenido |
|---|---|
| **Inicio** | Ficha del empleado (avatar, nombre, cargo, ID, campana) · tira semanal `Dom`→`Sáb` con estado por día · acción de marcar · card "Detalle del turno" · resumen semanal |
| **Asistencia** | Historial de marcaciones con alertas de geocerca y GPS simulado |
| **Calendario** | Navegación por semanas con turnos y horas trabajadas |
| **Reportes** | Totales, cumplimiento y horas por día |
| **Más** | Biometría, estado de la cola, rechazos, cierre de sesión |

El **avatar es un monograma**, no una imagen remota: la foto de perfil es un dato biométrico —es el patrón contra el que compara el face‑match— y no tiene por qué estar cacheada en cada dispositivo solo para decorar una cabecera.

Las horas se muestran en `HH:mm:ss` completo y con cifras tabulares: en un sistema con valor legal el segundo importa, y la anchura fija evita que los dígitos bailen al actualizarse.

El estado de asistencia se comunica con **color + etiqueta**, nunca solo con color.

---

## Tests

`pnpm --filter @scire/mobile test` cubre la lógica pura: la máquina de estados de la jornada y los errores (`src/lib/punchFlow.ts`) y la sincronización de la cola (`src/offline/syncCore.ts`).

Los hooks y componentes importan `expo-camera`, `expo-haptics` y `expo-location` en el nivel de módulo y no se pueden cargar fuera de un dispositivo. Probarlos aquí exigiría una capa de mocks que verificaría los mocks, no la app; su cobertura real es el bundle de `expo export` y la prueba en dispositivo.
