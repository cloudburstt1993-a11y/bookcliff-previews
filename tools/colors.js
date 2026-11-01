// Color math for preview palettes: parsing, WCAG 2.2 contrast, palette picking from weighted colors
// (logo pixels, SVG fills, photo pixels), and the page's light and dark tokens. Every text and button
// pair the page uses is pushed to WCAG 2.2 AA here (4.5:1 text, 3:1 large text and UI) by moving
// lightness only, so the brand's hue survives. Pure functions, no I/O.
'use strict';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
const toHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const WHITE = { r: 255, g: 255, b: 255 };
const NEAR_BLACK = { r: 17, g: 20, b: 24 };
const NAMED = { white: WHITE, black: { r: 0, g: 0, b: 0 }, red: { r: 255, g: 0, b: 0 }, navy: { r: 0, g: 0, b: 128 }, green: { r: 0, g: 128, b: 0 }, blue: { r: 0, g: 0, b: 255 }, orange: { r: 255, g: 165, b: 0 }, maroon: { r: 128, g: 0, b: 0 }, teal: { r: 0, g: 128, b: 128 }, purple: { r: 128, g: 0, b: 128 } };

// Accepts #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and a few names. Anything else -> null.
function parseColor(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s.length > 64) return null;
  let m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return { r: clamp(+m[1], 0, 255), g: clamp(+m[2], 0, 255), b: clamp(+m[3], 0, 255) };
  }
  return NAMED[s] ? { ...NAMED[s] } : null;
}

function toHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl({ h, s, l }) {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: Math.round(f(hh + 1 / 3) * 255), g: Math.round(f(hh) * 255), b: Math.round(f(hh - 1 / 3) * 255) };
}

const hsl = (h, s, l) => fromHsl({ h, s: clamp(s, 0, 1), l: clamp(l, 0, 1) });

function luminance({ r, g, b }) {
  const f = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Weighted mix: t = share of b.
const mix = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
const chroma = ({ r, g, b }) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
const hueDistance = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Move fg's lightness until it reaches `ratio` against every background. prefer: 'darker' | 'lighter'.
function ensureContrast(fg, backgrounds, ratio, prefer) {
  const ok = (c) => backgrounds.every((bg) => contrast(c, bg) >= ratio);
  if (ok(fg)) return fg;
  const { h, s, l } = toHsl(fg);
  const walk = (dir) => {
    for (let i = 1; i <= 100; i++) {
      const nl = l + dir * i * 0.01;
      if (nl < 0 || nl > 1) break;
      const c = fromHsl({ h, s, l: nl });
      if (ok(c)) return { c, i };
    }
    return null;
  };
  const down = walk(-1), up = walk(1);
  let pick = null;
  if (prefer === 'darker') pick = down || up;
  else if (prefer === 'lighter') pick = up || down;
  else pick = down && up ? (down.i <= up.i ? down : up) : down || up;
  if (pick) return pick.c;
  const black = { r: 0, g: 0, b: 0 };
  return backgrounds.reduce((m, bg) => Math.min(m, contrast(WHITE, bg)), 99) >= backgrounds.reduce((m, bg) => Math.min(m, contrast(black, bg)), 99) ? { ...WHITE } : black;
}

// Group weighted colors by hue and lightness, then choose primary, accent and dark.
// entries: [{ r, g, b, w }]; mode 'photo' favours vivid colors over merely common ones.
function pickPalette(entries, mode = 'logo') {
  const total = entries.reduce((n, e) => n + e.w, 0) || 1;
  const clusters = [];
  for (const e of entries) {
    const c = { r: e.r, g: e.g, b: e.b };
    const { h, l } = toHsl(c);
    const ch = chroma(c);
    if (ch < 0.16 || l < 0.1 || l > 0.9) continue;
    const near = clusters.find((k) => hueDistance(k.h, h) <= 18 && Math.abs(k.l - l) <= 0.22);
    if (near) {
      const w = near.w + e.w;
      near.sum.r += c.r * e.w; near.sum.g += c.g * e.w; near.sum.b += c.b * e.w;
      near.w = w;
    } else {
      clusters.push({ h, l, w: e.w, sum: { r: c.r * e.w, g: c.g * e.w, b: c.b * e.w } });
    }
  }
  const colored = clusters.map((k) => {
    const c = { r: Math.round(k.sum.r / k.w), g: Math.round(k.sum.g / k.w), b: Math.round(k.sum.b / k.w) };
    const ch = chroma(c);
    return { c, w: k.w, h: toHsl(c).h, score: k.w * (mode === 'photo' ? ch ** 1.5 : 0.5 + ch) };
  }).filter((k) => k.w / total >= (mode === 'svg' ? 0 : 0.015)).sort((a, b) => b.score - a.score || b.w - a.w);

  const darkEntries = entries.filter((e) => toHsl(e).l < 0.22);
  const darkW = darkEntries.reduce((n, e) => n + e.w, 0);
  const dark = darkW / total >= 0.05
    ? { r: Math.round(darkEntries.reduce((n, e) => n + e.r * e.w, 0) / darkW), g: Math.round(darkEntries.reduce((n, e) => n + e.g * e.w, 0) / darkW), b: Math.round(darkEntries.reduce((n, e) => n + e.b * e.w, 0) / darkW) }
    : null;

  const primary = colored[0]?.c || null;
  let accent = null;
  if (primary) {
    const a = colored.slice(1).find((k) => hueDistance(k.h, colored[0].h) >= 35 && k.w >= colored[0].w * 0.08);
    accent = a ? a.c : null;
  }
  if (primary && mode === 'photo') {
    // Photo colors are muted; lift saturation and settle lightness so they read as a brand color.
    const p = toHsl(primary);
    return { primary: hsl(p.h, Math.max(p.s, 0.5), clamp(p.l, 0.32, 0.48)), accent: null, dark };
  }
  return { primary, accent, dark };
}

// Colors written in an SVG's fill, stroke and stop-color, counted by use.
function svgColorEntries(svgText) {
  const counts = new Map();
  const re = /(?:fill|stroke|stop-color)\s*(?:=\s*["']|:\s*)\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,40}\)|[a-zA-Z]{3,12})/g;
  let m;
  while ((m = re.exec(svgText)) !== null) {
    const c = parseColor(m[1]);
    if (!c) continue;
    const key = toHex(c);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([hex, w]) => ({ ...parseColor(hex), w }));
}

const rgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${a.toFixed(2)})`;

// Smallest overlay opacity of `color` that keeps white text at `ratio` even over a pure white pixel.
function overlayAlpha(color, ratio) {
  for (let a = 0.3; a <= 0.96; a += 0.01) {
    if (contrast(WHITE, mix(WHITE, color, a)) >= ratio) return Math.min(0.96, a);
  }
  return 0.96;
}

// Build the page tokens for light and dark color schemes from a brand palette.
function buildTokens({ primary, accent, dark }) {
  const P = primary;
  const p = toHsl(P);
  const A = accent || P;
  const dSeed = dark || hsl(p.h, Math.min(p.s, 0.45), 0.16);
  const ds = toHsl(dSeed);
  const D = ensureContrast(hsl(ds.h, Math.min(ds.s, 0.5), Math.min(ds.l, 0.17)), [WHITE], 12, 'darker');
  const dh = toHsl(D).h, dsat = Math.min(toHsl(D).s, 0.35);

  const btnInk = contrast(WHITE, P) >= contrast(NEAR_BLACK, P) ? WHITE : NEAR_BLACK;
  const btn = ensureContrast(P, [btnInk], 4.5, btnInk === WHITE ? 'darker' : 'lighter');
  const btnHover = ensureContrast(hsl(toHsl(btn).h, toHsl(btn).s, toHsl(btn).l + (btnInk === WHITE ? -0.07 : 0.07)), [btnInk], 4.5, btnInk === WHITE ? 'darker' : 'lighter');
  const overlay = hsl(dh, dsat, 0.08);
  const heroGlow = ensureContrast(mix(D, P, 0.55), [WHITE], 4.5, 'darker');

  const lightBg = WHITE;
  const lightTint = hsl(p.h, Math.min(p.s, 0.45), 0.965);
  const lightInk = ensureContrast(hsl(dh, dsat, 0.13), [lightBg, lightTint], 12, 'darker');
  const lightMuted = ensureContrast(hsl(dh, 0.12, 0.4), [lightBg, lightTint], 4.5, 'darker');
  const lightLink = ensureContrast(P, [lightBg, lightTint], 4.5, 'darker');
  const lightAccent = ensureContrast(A, [lightBg, lightTint], 4.5, 'darker');
  const lightField = ensureContrast(hsl(dh, 0.1, 0.62), [lightBg], 3, 'darker');
  const band = hsl(dh, dsat, 0.11);
  const onBandMuted = ensureContrast(hsl(dh, 0.15, 0.78), [band], 4.5, 'lighter');
  const bandLink = ensureContrast(P, [band], 4.5, 'lighter');

  const darkBg = hsl(dh, Math.min(dsat, 0.3), 0.075);
  const darkSurface = hsl(dh, Math.min(dsat, 0.3), 0.115);
  const darkTint = hsl(dh, Math.min(dsat, 0.3), 0.145);
  const darkInk = ensureContrast(hsl(dh, 0.15, 0.94), [darkBg, darkSurface, darkTint], 12, 'lighter');
  const darkMuted = ensureContrast(hsl(dh, 0.12, 0.72), [darkBg, darkSurface, darkTint], 4.5, 'lighter');
  const darkLink = ensureContrast(P, [darkBg, darkSurface, darkTint], 4.5, 'lighter');
  const darkAccent = ensureContrast(A, [darkBg, darkSurface, darkTint], 4.5, 'lighter');
  const darkField = ensureContrast(hsl(dh, 0.1, 0.45), [darkSurface], 3, 'lighter');
  const darkBand = hsl(dh, Math.min(dsat, 0.3), 0.05);
  const darkBandMuted = ensureContrast(hsl(dh, 0.15, 0.78), [darkBand], 4.5, 'lighter');
  const darkBandLink = ensureContrast(P, [darkBand], 4.5, 'lighter');

  const light = {
    bg: lightBg, surface: WHITE, tint: lightTint, ink: lightInk, muted: lightMuted, line: hsl(dh, 0.12, 0.9),
    field: lightField, link: lightLink, accent: lightAccent, btn, 'btn-ink': btnInk, 'btn-hover': btnHover,
    band, 'on-band': WHITE, 'on-band-muted': onBandMuted, 'band-link': bandLink, focus: lightLink,
    'tag-bg': { r: 255, g: 243, b: 230 }, 'tag-ink': { r: 140, g: 64, b: 8 },
  };
  const darkScheme = {
    bg: darkBg, surface: darkSurface, tint: darkTint, ink: darkInk, muted: darkMuted, line: hsl(dh, 0.12, 0.2),
    field: darkField, link: darkLink, accent: darkAccent, btn, 'btn-ink': btnInk, 'btn-hover': btnHover,
    band: darkBand, 'on-band': WHITE, 'on-band-muted': darkBandMuted, 'band-link': darkBandLink, focus: darkLink,
    'tag-bg': { r: 74, g: 42, b: 14 }, 'tag-ink': { r: 255, g: 216, b: 176 },
  };
  const alpha = overlayAlpha(overlay, 5);
  return { light, dark: darkScheme, overlay, overlayAlpha: alpha, heroGlow, brand: { primary: P, accent: A, dark: D } };
}

// Every pair the page renders, so tests and the build log can prove AA.
function contrastPairs(t) {
  const pairs = [];
  for (const [scheme, s] of [['light', t.light], ['dark', t.dark]]) {
    const add = (name, fg, bg, min) => pairs.push({ scheme, name, ratio: contrast(fg, bg), min });
    for (const bg of ['bg', 'surface', 'tint']) {
      add(`ink/${bg}`, s.ink, s[bg], 4.5); add(`muted/${bg}`, s.muted, s[bg], 4.5);
      add(`link/${bg}`, s.link, s[bg], 4.5); add(`accent/${bg}`, s.accent, s[bg], 4.5);
      add(`focus/${bg}`, s.focus, s[bg], 3);
    }
    add('field/surface', s.field, s.surface, 3);
    add('btn-ink/btn', s['btn-ink'], s.btn, 4.5); add('btn-ink/btn-hover', s['btn-ink'], s['btn-hover'], 4.5);
    add('on-band/band', s['on-band'], s.band, 4.5); add('on-band-muted/band', s['on-band-muted'], s.band, 4.5);
    add('band-link/band', s['band-link'], s.band, 4.5); add('tag', s['tag-ink'], s['tag-bg'], 4.5);
  }
  pairs.push({ scheme: 'both', name: 'white/hero-overlay-over-white', ratio: contrast(WHITE, mix(WHITE, t.overlay, t.overlayAlpha)), min: 4.5 });
  pairs.push({ scheme: 'both', name: 'white/hero-glow', ratio: contrast(WHITE, t.heroGlow), min: 4.5 });
  return pairs;
}

module.exports = { parseColor, toHex, toHsl, fromHsl, contrast, chroma, mix, ensureContrast, pickPalette, svgColorEntries, buildTokens, contrastPairs, rgba, WHITE };
