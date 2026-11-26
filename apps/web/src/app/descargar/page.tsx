import { Download, Smartphone } from "lucide-react";
import Link from "next/link";

export const metadata = { title: "App movil" };
// La URL se lee en cada peticion: se puede cambiar sin recompilar.
export const dynamic = "force-dynamic";

/** Solo enlaces https: evita publicar por error una ruta local o `javascript:`. */
function downloadUrl(): string | null {
  const url = process.env.MOBILE_APK_URL?.trim();
  return url?.startsWith("https://") ? url : null;
}

const STEPS = [
  "Abre esta pagina desde tu telefono Android y toca «Descargar APK».",
  "Si Android lo pide, permite instalar apps desde tu navegador.",
  "Abre el archivo descargado y confirma la instalacion.",
  "Inicia sesion con tu correo y acepta los permisos de camara y ubicacion.",
  "La primera vez necesitas internet. Despues puedes marcar sin conexion.",
];

export default function DescargarPage() {
  const url = downloadUrl();

  return (
    <main className="mx-auto max-w-xl space-y-6 px-4 py-12">
      <div className="space-y-2">
        <Smartphone className="h-8 w-8 text-accent" />
        <h1 className="text-2xl font-bold">App movil de asistencia</h1>
        <p className="text-muted-foreground">
          Marca entrada, refrigerio y salida desde tu telefono, tambien sin cobertura.
        </p>
      </div>

      {url ? (
        <a
          href={url}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground"
        >
          <Download className="h-4 w-4" />
          Descargar APK (Android)
        </a>
      ) : (
        <p className="rounded-xl border border-border bg-secondary/50 p-4 text-sm">
          Tu empresa todavia no ha publicado el instalador. Pide el enlace a Recursos Humanos.
        </p>
      )}

      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">
        En iPhone la app se distribuye por TestFlight o la App Store; solicita la invitacion a
        Recursos Humanos.
      </p>
      <Link href="/login" className="text-sm font-medium text-primary underline">
        Ir al panel web
      </Link>
    </main>
  );
}
