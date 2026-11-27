// Suivi des erreurs du site (Sentry), facultatif : actif seulement si le serveur donne une adresse « DSN ».
//
// Léger : la bibliothèque Sentry n'est téléchargée qu'au PREMIER vrai bug (aucun poids sur le chargement normal).
// Rien de personnel n'est envoyé : pas d'identité, pas d'adresse IP (réglage du projet Sentry), pas de saisie,
// pas de contenu de cours ; les identifiants dans les adresses (fichiers Drive…) sont masqués.
/* global __BUILD_ID__ */
import { getConfig } from "./api.js";
import { isStaleChunkError } from "./stale.js";

let loading = null;

const scrubUrl = (url) => String(url || "").split("?")[0].split("#")[0].replace(/\/[A-Za-z0-9_-]{20,}/g, "/:id");

function sentry() {
  loading ||= (async () => {
    const { sentryDsn } = await getConfig();
    if (!sentryDsn) return null;
    const Sentry = await import("@sentry/browser");
    Sentry.init({
      dsn: sentryDsn,
      release: typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev",
      sendDefaultPii: false,
      defaultIntegrations: false, // pas d'enregistrement des clics, des saisies ni de la console
      integrations: [Sentry.dedupeIntegration(), Sentry.linkedErrorsIntegration()],
      beforeSend(event) {
        delete event.user;
        if (event.request) event.request = { url: scrubUrl(event.request.url) };
        delete event.breadcrumbs;
        return event;
      },
    });
    return Sentry;
  })().catch(() => null);
  return loading;
}

/** Envoie une erreur INATTENDUE (pas les erreurs normales : hors ligne, quota, mot de passe refusé…). */
export async function reportError(err) {
  if (!err || isStaleChunkError(err)) return;
  if (typeof err.status === "number" && err.status < 500) return; // réponse normale du serveur (4xx) ou hors ligne (0)
  const S = await sentry();
  S?.captureException(err instanceof Error ? err : new Error(String(err)));
}

export function installErrorReporting() {
  addEventListener("error", (e) => reportError(e.error || e.message));
  addEventListener("unhandledrejection", (e) => reportError(e.reason));
}
