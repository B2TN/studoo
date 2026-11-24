"""Serveur de tâches Studoo."""
import os
import secrets

# Le worker réutilise la configuration du site (studoo.config), qui refuse de démarrer en ligne sans
# SESSION_SECRET. Cette clé ne sert qu'aux cookies de connexion du site : le worker ne l'utilise jamais,
# on lui en donne donc une aléatoire plutôt que de recopier la vraie sur un serveur de plus.
os.environ.setdefault("SESSION_SECRET", secrets.token_urlsafe(48))
