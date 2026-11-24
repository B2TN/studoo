"""Fabrication des fichiers audio (MP3) et vidéo (MP4) avec ffmpeg.

Vidéo : au lieu de dessiner 15 images par seconde, on ne dessine qu'une image à
chaque changement (nouvelle puce, nouveau sous-titre) et ffmpeg la garde affichée
le temps voulu. C'est beaucoup plus rapide sur un petit processeur.
"""
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import settings
from .tts import RATE, to_wav_bytes

FONTS = {
    "title": ("GochiHand-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/gochihand/GochiHand-Regular.ttf"),
    "text": ("PatrickHand-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/patrickhand/PatrickHand-Regular.ttf"),
}
PAPER, GRID, GRID2, MARGIN, INK = (251, 246, 233), (215, 225, 243), (185, 201, 234), (232, 132, 140), (22, 41, 110)
COLORS = [(247, 239, 90), (255, 156, 203), (139, 234, 159), (159, 211, 255), (255, 194, 122), (205, 184, 255)]
FORMATS = {"short": (720, 1280), "medium": (1280, 720), "long": (1280, 720)}


def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def font(kind: str, size: int):
    name, url = FONTS[kind]
    path = settings.MODELS_DIR / name
    if not path.exists():
        settings.MODELS_DIR.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, path)
    return ImageFont.truetype(str(path), size)


def mp3(audio) -> bytes:
    """Son (float32 24 kHz) → MP3 64 kbit/s."""
    with tempfile.TemporaryDirectory() as tmp:  # dossier temporaire supprimé automatiquement
        wav, out = Path(tmp) / "in.wav", Path(tmp) / "out.mp3"
        wav.write_bytes(to_wav_bytes(audio))
        subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(wav), "-codec:a", "libmp3lame", "-b:a", "64k", str(out)], check=True)
        return out.read_bytes()


def _wrap(draw, text, fnt, width):
    lines, line = [], ""
    for word in str(text).split():
        test = f"{line} {word}".strip()
        if draw.textlength(test, font=fnt) > width and line:
            lines.append(line)
            line = word
        else:
            line = test
    if line:
        lines.append(line)
    return lines


def _paper(W, H):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    for x in range(0, W, 24):
        d.line([(x, 0), (x, H)], fill=GRID2 if x % 96 == 0 else GRID)
    for y in range(0, H, 24):
        d.line([(0, y), (W, y)], fill=GRID2 if y % 96 == 0 else GRID)
    d.line([(56, 0), (56, H)], fill=MARGIN, width=3)
    return img


def draw_slide(W, H, slide, index, total, shown_bullets, caption, progress):
    vertical = H > W
    pad = 80 if vertical else 110
    img = _paper(W, H)
    d = ImageDraw.Draw(img)
    f_title, f_text, f_cap = font("title", 60), font("text", 40 if vertical else 36), font("text", 34 if vertical else 30)
    y = 170 if vertical else 130
    for line in _wrap(d, slide["title"], f_title, W - 2 * pad):
        w = d.textlength(line, font=f_title)
        d.rectangle([pad - 10, y - 52, pad + w + 10, y + 14], fill=COLORS[index % len(COLORS)])
        d.text((pad, y - 60), line, font=f_title, fill=INK)
        y += 78
    y += 30
    for b in slide.get("bullets", [])[:shown_bullets]:
        d.ellipse([pad + 4, y + 16, pad + 20, y + 32], fill=INK)
        for line in _wrap(d, b, f_text, W - 2 * pad - 40):
            d.text((pad + 40, y), line, font=f_text, fill=INK)
            y += 52 if vertical else 46
        y += 12
    if caption:
        lines = _wrap(d, caption, f_cap, W - 2 * pad - 40)[:3]
        lh = 44 if vertical else 38
        box_h = len(lines) * lh + 28
        top = H - box_h - (120 if vertical else 40)
        d.rounded_rectangle([pad - 20, top, W - pad + 20, top + box_h], radius=14, fill=(255, 253, 246), outline=INK, width=3)
        for i, line in enumerate(lines):
            d.text((pad, top + 12 + i * lh), line, font=f_cap, fill=INK)
    d.rectangle([0, H - 10, W, H], fill=(220, 225, 238))
    d.rectangle([0, H - 10, int(W * progress), H], fill=COLORS[1])
    d.text((W - 140, 20), "Studoo", font=font("title", 30), fill=INK)
    return img


def _captions(text, per=12):
    words = str(text).split()
    return [" ".join(words[i:i + per]) for i in range(0, len(words), per)] or [""]


def mp4(slides, audios, fmt="medium", on_progress=None) -> bytes:
    """Diapos + voix (une piste par diapo) → MP4 H.264/AAC."""
    import numpy as np
    W, H = FORMATS.get(fmt, FORMATS["medium"])
    total = len(slides)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        lines = []
        n = 0
        for i, (slide, audio) in enumerate(zip(slides, audios)):
            dur = max(3.0, len(audio) / RATE)
            caps = _captions(slide.get("narration", ""))
            bullets = slide.get("bullets", [])
            # moments où l'image change : chaque puce (sur 60 % de la durée) et chaque sous-titre
            marks = sorted({0.0, *[(k + 1) / (len(bullets) + 1) * 0.6 for k in range(len(bullets))],
                            *[k / len(caps) for k in range(len(caps))]})
            for j, start in enumerate(marks):
                end = marks[j + 1] if j + 1 < len(marks) else 1.0
                shown = sum(1 for k in range(len(bullets)) if (k + 1) / (len(bullets) + 1) * 0.6 <= start + 1e-9)
                cap = caps[min(len(caps) - 1, int(start * len(caps) + 1e-9))]
                frame = tmp / f"f{n:05d}.jpg"
                draw_slide(W, H, slide, i, total, shown, cap, (i + start) / total).save(frame, quality=88)
                lines.append(f"file '{frame.name}'\nduration {max(0.05, (end - start) * dur):.3f}\n")
                n += 1
            on_progress and on_progress((i + 1) / total)
        lines.append(f"file '{frame.name}'\n")  # ffmpeg demande de répéter la dernière image
        (tmp / "list.txt").write_text("".join(lines), encoding="utf-8")
        (tmp / "voice.wav").write_bytes(to_wav_bytes(np.concatenate([np.asarray(a, dtype=np.float32) for a in audios])))
        out = tmp / "out.mp4"
        subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt"),
                        "-i", str(tmp / "voice.wav"), "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
                        "-r", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest",
                        "-movflags", "+faststart", str(out)], check=True, cwd=tmp)
        return out.read_bytes()
