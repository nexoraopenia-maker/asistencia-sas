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
    ├── offline/   queue (SQLite) · sync (lotes) · OfflineContext
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

## Motor offline-first

Cola en **SQLite** (`src/offline/queue.ts`), no AsyncStorage: una marcación perdida es una hora de trabajo que el empleado no cobra. SQLite da escrituras atómicas y una clave primaria que impide duplicar; AsyncStorage obligaría a leer‑modificar‑escribir un JSON entero, con una ventana de corrupción en cada guardado.

**Qué se encola y qué no.** Solo un `NetworkError` manda una marcación a la cola. Un 422 por geocerca también "falla", pero encolarlo únicamente aplazaría el mismo rechazo: sube a la pantalla con un mensaje accionable (*"estás a 340 m de tu sucursal"*).

**Corte a mitad de envío.** Si la red cae después de enviar pero antes de recibir la respuesta, la marcación se encola **con el mismo `clientPunchId`**. Si el servidor sí la recibió, la sincronización la verá como duplicado y no creará una segunda.

**Selfies pendientes.** Una marcación tomada sin cobertura no pudo pedir su URL firmada: la foto queda en disco y se sube justo antes de enviar el lote. Si la subida falla por algo que no es la red, la marcación se envía igualmente sin foto — que decida el servidor según la política de la empresa, en vez de descartar en silencio un fichaje real.

**Sincronización.** Se dispara en la *transición* de sin red a con red, no en cada evento de NetInfo (que emite con frecuencia: cambio de wifi a datos, variación de intensidad). Un solo lote en vuelo a la vez.

**Rechazos visibles.** Una marcación que el servidor rechaza sale de la cola y pasa a una tabla aparte que la pestaña *Más* muestra. Desaparecer en silencio sería lo peor que podría hacer la app con un fichaje.

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

`pnpm --filter @scire/mobile test` cubre la lógica pura (`src/lib/punchFlow.ts`): la máquina de estados de la jornada y la traducción de errores a mensajes accionables.

Los hooks y componentes importan `expo-camera`, `expo-haptics` y `expo-location` en el nivel de módulo y no se pueden cargar fuera de un dispositivo. Probarlos aquí exigiría una capa de mocks que verificaría los mocks, no la app; su cobertura real es el bundle de `expo export` y la prueba en dispositivo.
