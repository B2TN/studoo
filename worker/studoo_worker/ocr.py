"""Lecture des copies / feuilles photographiées avec Qwen3-VL (vision-langage, Apache 2.0).

Choisi après comparaison (docs/OCR.md) : le meilleur compromis testé entre écriture
manuscrite française et formules mathématiques (rendues en LaTeX).
"""
import base64
from functools import lru_cache
from io import BytesIO

from . import settings
from .storage import make_room

PROMPT = ("Recopie fidèlement tout le texte de cette page (manuscrit ou imprimé), dans l'ordre, en Markdown. "
          "Écris les formules mathématiques en LaTeX entre $…$. Si un mot est barré, ignore-le. "
          "Décris un schéma en une ligne entre crochets. N'ajoute rien qui n'est pas écrit.")


@lru_cache(maxsize=1)
def _model():
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor
    torch.set_num_threads(settings.THREADS)
    make_room(5.5, keep="hf")
    cache = str(settings.MODELS_DIR / "hf")
    processor = AutoProcessor.from_pretrained(settings.OCR_MODEL, cache_dir=cache)
    model = AutoModelForImageTextToText.from_pretrained(settings.OCR_MODEL, dtype=torch.bfloat16,
                                                        device_map="cpu", cache_dir=cache)
    return processor, model


def read_page(image_b64: str) -> str:
    import torch
    from PIL import Image
    processor, model = _model()
    image = Image.open(BytesIO(base64.b64decode(image_b64))).convert("RGB")
    image.thumbnail((1280, 1280))  # assez pour lire, sans exploser le temps de calcul
    messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": PROMPT}]}]
    inputs = processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
                                           return_dict=True, return_tensors="pt")
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=1500, do_sample=False)
    return processor.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip()
