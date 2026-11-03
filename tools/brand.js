// Logo and photo handling for previews. The business's own logo is downloaded, trimmed, resized and
// re-encoded as PNG (SVGs are rasterized, so no script in an SVG ever lands on the previews site).
// Photos are never stored: a site photo may be read into memory once to sample its colors, then dropped.
// sharp is optional at runtime: without it there is no logo and no image-derived palette, and the
// build still succeeds with the template look.
'use strict';

const { fetchCapped, SourceError } = require('./net');
const { svgColorEntries, toHsl } = require('./colors');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false);
} catch {
  console.error('[preview] sharp is not installed (run npm ci in ops/previews): logos and image colors are skipped');
}

const IMAGE_BYTES = 8 * 1024 * 1024;
const PIXEL_LIMIT = 50_000_000;
const IMAGE_TYPE = /^(image\/|application\/octet-stream|binary\/octet-stream)/;

const looksSvg = (buf, type) => /svg/.test(type) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]{0,2000}?-->\s*)*(<!doctype[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'));

// Count 5-bit-per-channel color buckets in raw RGBA pixels.
function analysePixels(data, channels) {
  const buckets = new Map();
  let opaque = 0, light = 0, total = 0;
  for (let i = 0; i < data.length; i += channels) {
    total++;
    const a = channels === 4 ? data[i + 3] : 255;
    if (a < 128) continue;
    opaque++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.75) light++;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const k = buckets.get(key);
    if (k) { k.r += r; k.g += g; k.b += b; k.w++; } else buckets.set(key, { r, g, b, w: 1 });
  }
  const entries = [...buckets.values()].map((k) => ({ r: Math.round(k.r / k.w), g: Math.round(k.g / k.w), b: Math.round(k.b / k.w), w: k.w })).sort((a, b) => b.w - a.w);
  let covered = 0, distinct80 = 0;
  for (const e of entries) { if (covered >= opaque * 0.8) break; covered += e.w; distinct80++; }
  return { entries, opaqueShare: total ? opaque / total : 0, lightShare: opaque ? light / opaque : 0, distinct80 };
}

async function samplePixels(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: PIXEL_LIMIT }).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return analysePixels(data, info.channels);
}

// Download and normalize one logo candidate.
// Returns { png, width, height, tone: 'light'|'dark'|'opaque', entries, mode, url } or null.
// rejectPhotos: refuse candidates that look like photographs (used for the og:image fallback).
async function loadLogo(url, { budget, rejectPhotos = false }) {
  if (!sharp) return null;
  const res = await fetchCapped(url, { budget, maxBytes: IMAGE_BYTES, accept: IMAGE_TYPE });
  const svg = looksSvg(res.buffer, res.contentType);
  let input;
  let svgEntries = [];
  if (svg) {
    svgEntries = svgColorEntries(res.buffer.toString('utf8'));
    const meta = await sharp(res.buffer, { limitInputPixels: PIXEL_LIMIT }).metadata();
    const density = Math.round(Math.min(1200, Math.max(72, (72 * 480) / Math.max(1, meta.height || 1))));
    input = sharp(res.buffer, { density, limitInputPixels: PIXEL_LIMIT });
  } else {
    input = sharp(res.buffer, { limitInputPixels: PIXEL_LIMIT, animated: false }).rotate();
  }
  let flat = await input.png().toBuffer();
  try {
    flat = await sharp(flat).trim({ threshold: 12 }).png().toBuffer();
  } catch {
    // A flat, single-color image cannot be trimmed; keep it as it is.
  }
  const out = await sharp(flat).resize({ width: 720, height: 240, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, effort: 8 }).toBuffer({ resolveWithObject: true });
  if (out.info.width < 16 || out.info.height < 16) throw new SourceError('logo too small');
  const stats = await samplePixels(out.data);
  if (rejectPhotos && !svg && stats.distinct80 > 60) throw new SourceError('looks like a photo, not a logo');
  const transparent = 1 - stats.opaqueShare >= 0.08;
  const tone = !transparent ? 'opaque' : stats.lightShare >= 0.6 ? 'light' : 'dark';
  const useSvg = svgEntries.some((e) => toHsl(e).s > 0.15);
  return { png: out.data, width: out.info.width, height: out.info.height, tone, entries: useSvg ? svgEntries : stats.entries, mode: useSvg ? 'svg' : 'logo', url: res.url };
}

// Read a photo into memory only to sample its colors. Nothing is written to disk.
async function photoColorEntries(url, { budget }) {
  if (!sharp) return null;
  const res = await fetchCapped(url, { budget, maxBytes: IMAGE_BYTES, accept: /^image\// });
  if (looksSvg(res.buffer, res.contentType)) return null;
  return (await samplePixels(res.buffer)).entries;
}

// A photo's real size (D-061): pages often show a big photo as a small thumbnail, or a tiny blurred placeholder,
// so the HTML's width and height can't be trusted.
async function imageSize(url, { budget }) {
  if (!sharp) return null;
  const res = await fetchCapped(url, { budget, maxBytes: IMAGE_BYTES, accept: /^image\// });
  if (looksSvg(res.buffer, res.contentType)) return null;
  const meta = await sharp(res.buffer, { limitInputPixels: PIXEL_LIMIT }).metadata();
  return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
}

module.exports = { loadLogo, photoColorEntries, imageSize, hasSharp: () => Boolean(sharp) };
