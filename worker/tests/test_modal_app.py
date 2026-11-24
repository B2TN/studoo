"""L'adresse « kick » de Modal et l'API doivent calculer le même jeton."""
import pytest

modal_app = pytest.importorskip("modal_app")  # nécessite le paquet « modal » (installé pour déployer)


def test_kick_token_matches_api():
    from studoo.jobcrypto import kick_token
    secret = "s" * 48
    assert modal_app.kick_token(secret) == kick_token(secret)
    assert modal_app.kick_token(secret) != kick_token("t" * 48)
