#!/usr/bin/env bash
# Contrôle avant mise en ligne (itération 7, L4) — « Ignored Build Step » de Vercel :
#   exit 1 → Vercel construit et met en ligne ; exit 0 → Vercel annule ce déploiement (l'ancienne version reste).
# En production, on attend le résultat du workflow « Tests » de GitHub Actions pour CE commit (dépôt public : API
# sans jeton). Tests en échec → pas de mise en ligne. GitHub injoignable ou trop lent → on construit quand même
# (avec un avertissement dans le journal de Vercel), pour qu'une panne de GitHub ne bloque pas le site.
REPO="B2TN/studoo"
SHA="${VERCEL_GIT_COMMIT_SHA:-}"
if [ "${VERCEL_ENV:-}" != "production" ] || [ -z "$SHA" ]; then
  echo "Aperçu ou déploiement manuel : construit sans attendre les tests."
  exit 1
fi
for i in $(seq 1 48); do
  STATE=$(curl -fsS -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/actions/runs?head_sha=$SHA&per_page=30" 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const run = (JSON.parse(s).workflow_runs || []).find((r) => r.name === "Tests");
          console.log(!run ? "pending" : run.status !== "completed" ? "pending" : run.conclusion);
        } catch { console.log("unknown"); }
      });')
  case "$STATE" in
    success) echo "Tests GitHub réussis pour $SHA : mise en ligne."; exit 1 ;;
    failure|cancelled|timed_out|action_required|startup_failure)
      echo "Tests GitHub en échec ($STATE) pour $SHA : déploiement annulé, l'ancienne version reste en ligne."; exit 0 ;;
    pending) echo "Tests GitHub en cours… ($i)"; sleep 15 ;;
    *) echo "Réponse GitHub illisible ($i)"; sleep 15 ;;
  esac
done
echo "AVERTISSEMENT : résultat des tests GitHub inconnu après 12 min : construit quand même."
exit 1
