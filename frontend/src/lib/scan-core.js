// Traitement d'image « scanner de documents », écrit à la main en JavaScript
// (pas de grosse bibliothèque : tout tient en ~200 lignes et reste lisible).
//
// Étapes :
// 1. detectCorners : trouve la feuille (zone claire la plus grande) et ses 4 coins.
// 2. warp         : « déplie » la feuille en rectangle (transformation homographique).
// 3. enhance      : enlève les ombres (normalisation de l'éclairage) et renforce le contraste.

/** Niveaux de gris (0-255) à partir de pixels RGBA. */
export function toGray(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  return g;
}

/** Seuil d'Otsu : le niveau de gris qui sépare le mieux « clair » et « foncé ». */
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Trouve les 4 coins de la feuille dans une petite image (≈ 300 px de large).
 * Renvoie des coordonnées normalisées (0 → 1) : [hautGauche, hautDroite, basDroite, basGauche].
 */
export function detectCorners(data, w, h) {
  const gray = toGray(data, w, h);
  const t = otsu(gray);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > t ? 1 : 0;

  // Plus grande zone claire connexe (parcours en largeur)
  const label = new Int32Array(w * h);
  let bestId = 0, bestSize = 0, id = 0;
  const queue = new Int32Array(w * h);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    id++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; queue[tail++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; queue[tail++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; queue[tail++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; queue[tail++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
  }
  const fallback = [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]];
  if (bestSize < w * h * 0.15 || bestSize > w * h * 0.985) return fallback;

  // Coins = points extrêmes selon les diagonales
  let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== bestId) continue;
    const x = p % w, y = (p / w) | 0;
    const s = x + y, d = x - y;
    if (s < tl[2]) tl = [x, y, s];
    if (s > br[2]) br = [x, y, s];
    if (d > tr[2]) tr = [x, y, d];
    if (d < bl[2]) bl = [x, y, d];
  }
  return [tl, tr, br, bl].map(([x, y]) => [x / (w - 1), y / (h - 1)]);
}

/** Résout un système linéaire 8×8 (élimination de Gauss). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error("Coins alignés : impossible de redresser.");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homographie qui envoie les 4 points `from` sur les 4 points `to`. */
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Taille de sortie : proportions de la feuille détectée, largeur fixe. */
export function outputSize(cornersPx, width = 1654) {
  const [tl, tr, br, bl] = cornersPx;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  const ratio = Math.min(2, Math.max(0.5, h / Math.max(1, w)));
  return { width, height: Math.round(width * ratio) };
}

/** Redresse la zone délimitée par `cornersPx` (pixels de l'image source) en rectangle W×H. */
export function warp(src, sw, sh, cornersPx, W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  const Hm = homography([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], cornersPx);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [sx, sy] = applyH(Hm, x, y);
      const x0 = Math.max(0, Math.min(sw - 2, sx | 0)), y0 = Math.max(0, Math.min(sh - 2, sy | 0));
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Fond estimé : image découpée en cases, couleur du papier par case, lissée. */
function background(gray, w, h, cell = 24) {
  const bw = Math.ceil(w / cell), bh = Math.ceil(h / cell);
  const small = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // le 90e centile de la case ≈ couleur du papier (l'encre est plus foncée)
      const vals = [];
      for (let y = by * cell; y < Math.min(h, (by + 1) * cell); y += 3) {
        for (let x = bx * cell; x < Math.min(w, (bx + 1) * cell); x += 3) vals.push(gray[y * w + x]);
      }
      vals.sort((a, b) => a - b);
      small[by * bw + bx] = vals[Math.floor(vals.length * 0.9)] || 255;
    }
  }
  const smooth = new Float32Array(small.length);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) { s += small[yy * bw + xx]; n++; }
        }
      }
      smooth[y * bw + x] = s / n;
    }
  }
  return (x, y) => {
    const gx = Math.min(bw - 1, Math.max(0, x / cell - 0.5)), gy = Math.min(bh - 1, Math.max(0, y / cell - 0.5));
    const x0 = gx | 0, y0 = gy | 0, x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const a = smooth[y0 * bw + x0] * (1 - fx) + smooth[y0 * bw + x1] * fx;
    const b = smooth[y1 * bw + x0] * (1 - fx) + smooth[y1 * bw + x1] * fx;
    return a * (1 - fy) + b * fy;
  };
}

/**
 * Embellit la page : supprime ombres et teinte du papier, renforce l'encre.
 * mode : "color" (garde les couleurs), "gray" (niveaux de gris), "bw" (noir et blanc net).
 */
export function enhance(rgba, w, h, mode = "color") {
  const gray = toGray(rgba, w, h);
  const bg = background(gray, w, h);
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const b = Math.max(40, bg(x, y));
      const norm = Math.min(1, gray[i] / b); // 1 = papier, 0 = encre
      const k = norm > 0.86 ? 1 : Math.pow(norm / 0.86, 1.8); // papier → blanc pur, encre → plus foncée
      if (mode === "bw") {
        const v = k > 0.6 ? 255 : 0;
        out[o] = out[o + 1] = out[o + 2] = v;
      } else if (mode === "gray") {
        out[o] = out[o + 1] = out[o + 2] = k * 255;
      } else {
        for (let c = 0; c < 3; c++) {
          const col = Math.min(255, (rgba[o + c] / b) * 255);
          out[o + c] = k >= 1 ? 255 : Math.min(255, col * k * 0.9 + 255 * k * 0.1);
        }
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
