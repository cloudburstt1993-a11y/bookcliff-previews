// Where a preview's real details come from, in order of trust:
//   1. Google Places API (New), only with GOOGLE_PLACES_API_KEY (or --places-fixture for tests).
//      The official, terms-compliant way to read a Google Business Profile. Google Maps and Search
//      are never scraped. Photos are hotlinked by photoUri, never downloaded.
//   2. The business's own website: one HTML fetch (robots.txt "Disallow: /" is respected).
//      Facebook and Instagram pages are never fetched (their terms forbid it); they are only linked.
// Everything returned here is untrusted text or URLs; build-preview.js escapes all of it.
'use strict';

const fs = require('node:fs');
const { fetchCapped, httpUrl, SourceError, attempt } = require('./net');
const { parseColor } = require('./colors');

const PLACES_FIELDS = [
  'places.id', 'places.displayName', 'places.primaryTypeDisplayName', 'places.nationalPhoneNumber',
  'places.websiteUri', 'places.regularOpeningHours.weekdayDescriptions', 'places.editorialSummary',
  'places.businessStatus', 'places.photos.name', 'places.photos.authorAttributions', 'places.photos.widthPx',
  'places.photos.heightPx', 'places.googleMapsUri', 'places.pureServiceAreaBusiness',
].join(',');
// If Google ever rejects the sub-field paths, retry once with whole objects (same data, same SKUs).
const PLACES_FIELDS_COARSE = PLACES_FIELDS.replace('places.regularOpeningHours.weekdayDescriptions', 'places.regularOpeningHours')
  .replace(/places\.photos\.(name|authorAttributions|widthPx|heightPx)(,|$)/g, (m, f, sep) => (f === 'name' ? `places.photos${sep}` : ''))
  .replace(/,$/, '');

// ---------- text helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s, max = 400) => decodeEntities(String(s ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function normName(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&|\+/g, ' and ')
    .replace(/\b(l\.?l\.?c|inc|incorporated|corp|corporation|co|ltd|pllc|company)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const GENERIC_WORDS = new Set(['the', 'and', 'of', 'services', 'service', 'group', 'enterprises', 'bar', 'grill', 'restaurant', 'kitchen', 'cafe', 'shop', 'studio', 'salon', 'llc', 'gj', 'colorado', 'co']);

// "Clearly matches": same words once legal suffixes and punctuation are gone, or one name is the
// other plus only generic words ("Smith Plumbing" vs "Smith Plumbing Services").
function namesMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  const ta = new Set(x.split(' ')), tb = new Set(y.split(' '));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const meaningful = [...small].filter((t) => !GENERIC_WORDS.has(t));
  if (meaningful.length === 0) return false;
  return [...small].every((t) => big.has(t)) && [...big].filter((t) => !small.has(t)).every((t) => GENERIC_WORDS.has(t));
}

// Sentences that make claims a preview must not repeat (ratings, reviews, awards, licenses, prices,
// guarantees, superlatives about rank) are dropped from any outside description.
const CLAIM = /(\b\d(\.\d)?\s*(stars?|★)|★|\brated\b|\breviews?\b|\baward|\blicen[cs]|\binsured\b|\bbonded\b|\bcertified\b|\bbest\b|#\s*1\b|\bnumber one\b|\bguarantee|\$\s*\d|\bprices?\b|\bcheapest\b|\bfree\b|\btop[- ]rated\b|\bfive[- ]star\b|\byears? (of )?experience\b|\b\d+\+?\s*(years|yrs)\b|\bdecades?\b|\bsince (19|20)\d\d\b|\bvoted\b|\bwinner\b|\bfavorite\b|\bpremier\b|\bleading\b)/i;
function claimFree(text, max = 420) {
  const sentences = clean(text, 2000).split(/(?<=[.!?])\s+/);
  let out = '';
  for (const s of sentences) {
    if (!s || CLAIM.test(s)) continue;
    if ((out + ' ' + s).trim().length > max) break;
    out = (out + ' ' + s).trim();
  }
  return out.length >= 20 ? out : '';
}

const phoneDigits = (s) => {
  const d = String(s).replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null;
};
const formatPhone = (ten) => `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;

// ---------- HTML scanning (regex over size-capped HTML; patterns are linear) ----------

function parseAttrs(tag) {
  const attrs = new Map();
  const body = tag.replace(/^<[a-z0-9-]+/i, '').replace(/\/?>$/, '');
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const k = m[1].toLowerCase();
    if (!attrs.has(k)) attrs.set(k, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

function scanTags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) out.push({ index: m.index, attrs: parseAttrs(m[0]) });
  return out;
}

function largestFromSrcset(srcset) {
  let best = null, bestW = -1;
  for (const part of String(srcset).split(/,\s+/)) {
    const [u, d] = part.trim().split(/\s+/);
    const w = d && /^\d+w$/.test(d) ? parseInt(d, 10) : d && /^[\d.]+x$/.test(d) ? parseFloat(d) * 1000 : 0;
    if (u && w > bestW) { best = u; bestW = w; }
  }
  return best;
}

// JSON-LD nodes (including @graph) that describe the business.
function jsonLdNodes(blocks) {
  const nodes = [];
  const visit = (v, depth) => {
    if (depth > 6 || nodes.length > 200 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, depth + 1)); return; }
    nodes.push(v);
    if (v['@graph']) visit(v['@graph'], depth + 1);
  };
  for (const b of blocks) {
    try { visit(JSON.parse(b), 0); } catch { /* malformed JSON-LD is common; skip that block */ }
  }
  return nodes.filter((n) => {
    const t = [].concat(n['@type'] || []).join(' ');
    return /Organization|LocalBusiness|Restaurant|Store|Service|Contractor|Business|Bar|Cafe|Bakery|Salon|Clinic|Physician|Dentist|Plumber|Electrician|Roofing|HVAC|Automotive|Brewery|Winery|FoodEstablishment/i.test(t) && !/WebSite|WebPage/i.test(t);
  });
}

function socialLink(u) {
  const url = httpUrl(u);
  if (!url) return null;
  const host = url.hostname.replace(/^(www|m|web)\./, '');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg.length === 0 || seg.length > 2) return null;
  if (host === 'facebook.com' && !/^(sharer|share|dialog|plugins|tr|login|home\.php|groups)/i.test(seg[0])) {
    if (seg[0] === 'profile.php') return null;
    return { kind: 'facebook', url: `https://www.facebook.com/${seg.join('/')}` };
  }
  if (host === 'instagram.com' && seg.length === 1 && !/^(p|reel|explore|accounts|stories)$/i.test(seg[0])) {
    return { kind: 'instagram', url: `https://www.instagram.com/${seg[0]}/` };
  }
  return null;
}

// Site builders that put a tiny, pre-blurred placeholder in the HTML and swap the real photo in with JavaScript.
// Wix: static.wixstatic.com/media/<file>/v1/fill/w_113,h_75,...,blur_2/<file> -> the original
// static.wixstatic.com/media/<file> (the preview asks for sized copies, see build-preview.js responsive()).
function fullSizeImage(u) {
  const wix = /^(https:\/\/static\.wixstatic\.com\/media\/[^/?#]+)\/v1\//i.exec(u || '');
  if (wix) return wix[1];
  return u;
}

// The colors a site's own styles use, weighted by how often: CSS custom properties are resolved where used
// (including Wix's palette, --color_N: "r,g,b"), plus literal background, text, border, fill and stroke colors.
// Grays, near-black and near-white are left for pickPalette to drop.
function colorOf(v) {
  const s = String(v).trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(s);
  if (m) return parseColor('#' + m[1]);
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)/i.exec(s);
  if (m && !(m[4] !== undefined && parseFloat(m[4]) < 0.5)) return { r: Math.min(255, +m[1]), g: Math.min(255, +m[2]), b: Math.min(255, +m[3]) };
  m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(s);
  if (m) return { r: Math.min(255, +m[1]), g: Math.min(255, +m[2]), b: Math.min(255, +m[3]) };
  return null;
}
function cssText(html) {
  const parts = [];
  html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (m, body) => { if (parts.length < 120) parts.push(body.slice(0, 500000)); return ''; });
  html.replace(/\sstyle\s*=\s*"([^"]{1,2000})"/gi, (m, st) => { if (parts.length < 800) parts.push(st); return ''; });
  return parts.join('\n').slice(0, 4000000);
}
function cssColorEntries(css) {
  const vars = new Map();
  let m;
  const varRe = /--([\w-]{1,60})\s*:\s*([^;}{]{1,80})/g;
  while ((m = varRe.exec(css)) !== null) { const c = colorOf(m[2]); if (c) vars.set(m[1], c); }
  const weights = new Map();
  const add = (c, w) => { const k = `${c.r},${c.g},${c.b}`; weights.set(k, (weights.get(k) || 0) + w); };
  const useRe = /var\(\s*--([\w-]{1,60})\s*[,)]/g;
  while ((m = useRe.exec(css)) !== null) { const c = vars.get(m[1]); if (c) add(c, 1); }
  const litRe = /(?:^|[;{\s])(?:background(?:-color)?|color|border(?:-[a-z]+)?-color|fill|stroke)\s*:\s*([^;}{]{3,60})/gi;
  while ((m = litRe.exec(css)) !== null) { const c = colorOf(m[1]); if (c) add(c, 1); }
  return [...weights].map(([k, w]) => { const [r, g, b] = k.split(',').map(Number); return { r, g, b, w }; });
}

// The site's fonts as Google Fonts the preview can load: a Google Fonts family the site uses, or the closest free
// match for a common paid one (Futura, Avenir, DIN, Brandon, Proxima, Gotham, ...). Heading first, then body.
const GOOGLE_FONTS = ['Montserrat', 'Poppins', 'Lato', 'Raleway', 'Oswald', 'Roboto', 'Open Sans', 'Nunito', 'Nunito Sans', 'Merriweather', 'Playfair Display',
  'Source Sans 3', 'Work Sans', 'Inter', 'DM Sans', 'Barlow', 'Barlow Condensed', 'Josefin Sans', 'Jost', 'Rubik', 'Quicksand', 'Cabin', 'Archivo', 'Karla',
  'Libre Baskerville', 'Lora', 'PT Sans', 'PT Serif', 'Bitter', 'Zilla Slab', 'Roboto Slab', 'Bebas Neue', 'Anton', 'Fjalla One', 'Teko', 'Abril Fatface',
  'Outfit', 'Manrope', 'Mulish', 'Urbanist', 'Sora', 'Lexend', 'Figtree', 'Plus Jakarta Sans', 'Libre Franklin', 'Cormorant Garamond', 'EB Garamond', 'Arvo',
  'Oxygen', 'Hind', 'Ubuntu', 'Exo 2', 'Kanit', 'Titillium Web', 'Questrial', 'Alegreya', 'Crimson Text', 'Spectral', 'Archivo Black', 'Russo One', 'Righteous'];
const FONT_MATCH = [[/futura/, 'Jost'], [/avenir/, 'Nunito Sans'], [/\bdin\b|din[- ]?next|din[- ]?pro/, 'Barlow'], [/brandon/, 'Josefin Sans'],
  [/proxima/, 'Montserrat'], [/gotham/, 'Montserrat'], [/century gothic/, 'Questrial'], [/impact/, 'Oswald'], [/helvetica neue|neue haas/, 'Inter'],
  [/gill sans/, 'Lato'], [/trade gothic|franklin gothic/, 'Libre Franklin'], [/garamond/, 'EB Garamond'], [/baskerville/, 'Libre Baskerville'],
  [/museo/, 'Nunito'], [/sofia pro/, 'Figtree'], [/circular/, 'DM Sans'], [/bebas/, 'Bebas Neue'], [/league gothic|knockout/, 'Oswald'], [/didot|bodoni/, 'Playfair Display']];
const DISPLAY = new Set(['Oswald', 'Bebas Neue', 'Anton', 'Fjalla One', 'Teko', 'Abril Fatface', 'Archivo Black', 'Russo One', 'Righteous', 'Barlow Condensed', 'Playfair Display']);
function siteFonts(html, css) {
  const counts = new Map();
  const add = (fam, w) => { if (fam) counts.set(fam, (counts.get(fam) || 0) + w); };
  const toGoogle = (raw) => {
    const n = String(raw).replace(/["']/g, '').trim().toLowerCase();
    if (!n || /^(inherit|initial|serif|sans-serif|monospace|system-ui|-apple-system|arial|helvetica|times|georgia|verdana|tahoma)$/.test(n)) return null;
    const exact = GOOGLE_FONTS.find((g) => g.toLowerCase() === n.replace(/-/g, ' ') || g.toLowerCase() === n);
    if (exact) return exact;
    const hit = FONT_MATCH.find(([re]) => re.test(n.replace(/-/g, ' ')));
    return hit ? hit[1] : null;
  };
  let m;
  const linkRe = /fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi;
  while ((m = linkRe.exec(html)) !== null) {
    for (const fam of decodeURIComponent(m[1].replace(/&amp;/g, '&')).split('&').filter((p) => /^family=/.test(p)).flatMap((p) => p.slice(7).split('|'))) {
      add(toGoogle(fam.split(':')[0].replace(/\+/g, ' ')), 5);
    }
  }
  const famRe = /font-family\s*:\s*([^;}{"]{1,200})/gi;
  while ((m = famRe.exec(css)) !== null) add(toGoogle(m[1].split(',')[0]), 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([f]) => f).filter((f) => /^[A-Za-z0-9 ]{2,40}$/.test(f));
  if (!ranked.length) return null;
  const heading = ranked.find((f) => DISPLAY.has(f)) || ranked[0];
  const body = ranked.find((f) => f !== heading && !DISPLAY.has(f)) || null;
  return { heading, body };
}

const BAD_PHOTO = /(^|[^a-z])(logos?|icons?|sprites?|badges?|avatars?|placeholders?|maps?|buttons?|arrows?|social|payments?|awards?|reviews?|ratings?|stars?|seals?|certified|certification|licen[cs]e[a-z]*|bbb|yelp|angi|homeadvisor|google|facebook|instagram|wordmark|favicon|banners?|qr|menus?|flyers?|coupons?|signature|pixel|spacer|blank|loading)([^a-z]|$)/i;

// Pull brand details out of a fetched homepage. businessName helps recognise the logo image.
function extractSite(html, pageUrl, businessName) {
  const jsonBlocks = [];
  html.replace(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi, (m, body) => { if (jsonBlocks.length < 20) jsonBlocks.push(body); return ''; });
  const bare = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  const baseTag = scanTags(bare, 'base')[0];
  const base = (baseTag && httpUrl(baseTag.attrs.get('href') || '', pageUrl)) || new URL(pageUrl);
  const abs = (u) => { const x = u && !/^data:/i.test(u) ? httpUrl(u, base) : null; return x ? x.href : null; };

  const meta = new Map();
  for (const t of scanTags(bare, 'meta')) {
    const key = (t.attrs.get('property') || t.attrs.get('name') || t.attrs.get('itemprop') || '').toLowerCase();
    if (!key || meta.has(key)) continue;
    if (key === 'theme-color' && /dark/.test(t.attrs.get('media') || '')) continue;
    meta.set(key, t.attrs.get('content') || '');
  }
  const siteName = clean(meta.get('og:site_name') || '', 120);
  const nodes = jsonLdNodes(jsonBlocks);

  // Logo candidates, best first: schema.org logo, a logo <img> (header, SVG/PNG preferred),
  // apple-touch-icon, then og:image as the last resort.
  const logos = [];
  for (const n of nodes) {
    const l = n.logo;
    const u = abs(typeof l === 'string' ? l : l && typeof l === 'object' ? (l.url || l.contentUrl) : null);
    if (u) logos.push({ url: u, from: 'schema.org logo' });
  }
  const headers = [];
  bare.replace(/<header\b[^>]*>|<\/header\s*>/gi, (m, i) => { headers.push({ open: m[1] !== '/', i }); return m; });
  const ranges = [];
  for (let k = 0; k < headers.length; k++) if (headers[k].open) { const close = headers.slice(k + 1).find((h) => !h.open); if (close) ranges.push([headers[k].i, close.i]); }
  const inHeader = (i) => ranges.some(([a, b]) => i > a && i < b);
  const nameKeys = [businessName, siteName].filter(Boolean);

  const imgs = scanTags(bare, 'img').map((t) => {
    const a = t.attrs;
    const raw = [a.get('src'), a.get('data-src'), a.get('data-image'), a.get('data-lazy-src'), largestFromSrcset(a.get('srcset') || a.get('data-srcset') || '')].find((u) => u && !/^data:/i.test(u));
    const url = fullSizeImage(abs(raw));
    // A builder's thumbnail traded for its original: the tag's width and height are the thumbnail's, so unknown.
    const swapped = url !== abs(raw);
    const dims = /^(\d+)x(\d+)$/.exec(a.get('data-image-dimensions') || '');
    const width = swapped ? 0 : dims ? +dims[1] : parseInt(a.get('width') || '', 10) || 0;
    const height = swapped ? 0 : dims ? +dims[2] : parseInt(a.get('height') || '', 10) || 0;
    const alt = clean(a.get('alt') || '', 160);
    return { url, width, height, alt, urlAlt: `${url} ${alt}`.toLowerCase(), text: `${raw || ''} ${alt} ${a.get('class') || ''} ${a.get('id') || ''}`.toLowerCase(), header: inHeader(t.index) };
  }).filter((x) => x.url);

  const logoImgs = imgs.map((x) => {
    let score = 0;
    if (/logo/.test(x.text)) score += 4;
    if (/wordmark|brandmark/.test(x.text)) score += 3;
    if (x.header) score += 3;
    if (x.alt && nameKeys.some((n) => namesMatch(n, x.alt))) score += 3;
    if (/\.(svg|png)(\?|$)/i.test(x.url)) score += 1;
    return { ...x, score };
  }).filter((x) => x.score >= 4).sort((p, q) => q.score - p.score);
  for (const x of logoImgs.slice(0, 2)) logos.push({ url: x.url, from: 'logo image' });
  for (const t of scanTags(bare, 'link')) {
    const rel = (t.attrs.get('rel') || '').toLowerCase();
    if (/apple-touch-icon/.test(rel)) { const u = abs(t.attrs.get('href')); if (u) logos.push({ url: u, from: 'apple-touch-icon' }); }
  }
  const ogImage = abs(meta.get('og:image') || meta.get('og:image:url') || meta.get('twitter:image') || '');
  if (ogImage) logos.push({ url: ogImage, from: 'og:image', rejectPhotos: true });

  // Photos (hotlinked later): og:image when it does not look like a logo, then large content images.
  const photos = [];
  const seen = new Set(logoImgs.map((x) => x.url.split('?')[0]));
  const ogW = parseInt(meta.get('og:image:width') || '', 10) || 0, ogH = parseInt(meta.get('og:image:height') || '', 10) || 0;
  if (ogImage && !BAD_PHOTO.test(ogImage) && !(ogW && ogH && (ogW / ogH > 2.6 || ogW / ogH < 0.5))) {
    photos.push({ url: ogImage, width: ogW, height: ogH, alt: '' });
    seen.add(ogImage.split('?')[0]);
  }
  for (const x of imgs) {
    const key = x.url.split('?')[0];
    if (seen.has(key) || photos.length >= 12) continue;
    seen.add(key);
    if (BAD_PHOTO.test(x.urlAlt) || x.header) continue;
    if (!/\.(jpe?g|webp|avif)(\?|$)/i.test(new URL(x.url).pathname)) continue;
    if (x.width && x.height && (Math.min(x.width, x.height) < 300 || x.width / x.height > 3 || x.width / x.height < 0.4)) continue;
    photos.push({ url: x.url, width: x.width, height: x.height, alt: /\.(jpe?g|png|webp|avif)$/i.test(x.alt) || /^(img|image|photo|dsc|untitled)[\s_-]?\d*$/i.test(x.alt) ? '' : x.alt });
  }

  // Visible text, for the phone and "family owned".
  const text = clean(bare.replace(/<[^>]+>/g, ' '), 400000);
  let phone = null;
  for (const n of nodes) { const d = phoneDigits(n.telephone || ''); if (d) { phone = d; break; } }
  if (!phone) {
    const tels = new Map();
    for (const t of scanTags(bare, 'a')) { const h = t.attrs.get('href') || ''; if (/^tel:/i.test(h)) { const d = phoneDigits(h.slice(4)); if (d) tels.set(d, (tels.get(d) || 0) + 1); } }
    phone = [...tels].sort((p, q) => q[1] - p[1])[0]?.[0] || null;
  }
  if (!phone) {
    const counts = new Map();
    const re = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-](\d{4})\b/g;
    let m;
    while ((m = re.exec(text)) !== null) { const d = m[1] + m[2] + m[3]; counts.set(d, (counts.get(d) || 0) + 1); }
    const ranked = [...counts].sort((p, q) => q[1] - p[1]);
    // Free text often lists several numbers; accept one only when it clearly dominates.
    if (ranked.length === 1 || (ranked[0] && ranked[0][1] >= 3 && ranked[0][1] >= 2 * ranked[1][1])) phone = ranked[0][0];
  }

  const socials = new Map();
  const links = scanTags(bare, 'a').map((t) => t.attrs.get('href') || '');
  for (const n of nodes) links.push(...[].concat(n.sameAs || []).filter((s) => typeof s === 'string'));
  for (const h of links) { const s = socialLink(h); if (s && !socials.has(s.kind)) socials.set(s.kind, s.url); }

  const themeColor = parseColor(meta.get('theme-color') || '');
  const css = cssText(html);
  const description = claimFree(meta.get('description') || meta.get('og:description') || nodes.find((n) => typeof n.description === 'string')?.description || '');
  const types = nodes.flatMap((n) => [].concat(n['@type'] || [])).filter((t) => typeof t === 'string').join(' ');

  return {
    url: pageUrl,
    siteName,
    description,
    themeColor,
    cssColors: cssColorEntries(css),
    fonts: siteFonts(html, css),
    logos,
    photos,
    phone: phone ? formatPhone(phone) : null,
    familyOwned: /\bfamily[- ]owned\b/i.test(text),
    socials: Object.fromEntries(socials),
    tradeHints: [types, siteName, description].filter(Boolean),
  };
}

// RFC 9309: a group for our product token wins over "*"; we only honour the obvious "Disallow: /".
function robotsBlocksAll(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ key, path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a && a !== '*' && 'bookcliffpreview'.includes(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = applicable.flatMap((g) => g.rules);
  return rules.some((r) => r.key === 'disallow' && (r.path === '/' || r.path === '/*')) && !rules.some((r) => r.key === 'allow' && (r.path === '/' || r.path === '/$'));
}

function socialFromUrl(u) {
  const url = httpUrl(u);
  if (!url) return null;
  const host = url.hostname.replace(/^(www|m|web)\./, '');
  if (host === 'facebook.com' || host === 'fb.com') return { kind: 'facebook', url: url.href };
  if (host === 'instagram.com') return { kind: 'instagram', url: url.href };
  return null;
}

async function readSite(siteUrl, { budget, businessName }) {
  const url = httpUrl(siteUrl);
  if (!url) throw new SourceError('not an http(s) URL');
  const robots = await attempt('robots.txt', () => fetchCapped(new URL('/robots.txt', url).href, { budget, maxBytes: 512 * 1024, okOnly: false }), { status: 599 });
  if (robots.status >= 500) throw new SourceError('robots.txt unreachable, so the site is treated as off limits');
  if (robots.status < 300 && robotsBlocksAll(robots.buffer.toString('utf8'))) throw new SourceError('robots.txt disallows /');
  const page = await fetchCapped(url.href, { budget, maxBytes: 2 * 1024 * 1024, accept: /^(text\/html|application\/xhtml\+xml)/, headers: { accept: 'text/html,application/xhtml+xml' } });
  return extractSite(page.buffer.toString('utf8'), page.url, businessName);
}

// ---------- Google Places API (New) ----------

function placesFromResponse(json, name) {
  const top = Array.isArray(json?.places) ? json.places[0] : null;
  if (!top) throw new SourceError('no Places result');
  const found = clean(top.displayName?.text || '', 160);
  if (!namesMatch(name, found)) throw new SourceError(`top Places result "${found.slice(0, 60)}" does not match the business name`);
  const hours = Array.isArray(top.regularOpeningHours?.weekdayDescriptions) ? top.regularOpeningHours.weekdayDescriptions.slice(0, 7).map((s) => clean(s, 120)).filter(Boolean) : [];
  const phone = phoneDigits(top.nationalPhoneNumber || '');
  return {
    id: clean(top.id || '', 300),
    name: found,
    category: clean(top.primaryTypeDisplayName?.text || '', 60),
    phone: phone ? formatPhone(phone) : null,
    website: httpUrl(top.websiteUri || '')?.href || null,
    hours,
    summary: claimFree(top.editorialSummary?.text || ''),
    status: clean(top.businessStatus || '', 40),
    mapsUri: httpUrl(top.googleMapsUri || '')?.href || null,
    serviceArea: top.pureServiceAreaBusiness === true,
    photoRefs: (Array.isArray(top.photos) ? top.photos : []).slice(0, 6).map((p) => ({
      name: typeof p.name === 'string' && /^places\/[\w-]+\/photos\/[\w-]+$/.test(p.name) ? p.name : null,
      width: Number.isFinite(p.widthPx) ? p.widthPx : 0,
      height: Number.isFinite(p.heightPx) ? p.heightPx : 0,
      authors: (Array.isArray(p.authorAttributions) ? p.authorAttributions : []).slice(0, 3)
        .map((a) => ({ name: clean(a.displayName || '', 80), uri: httpUrl(a.uri || '')?.href || null })).filter((a) => a.name),
    })).filter((p) => p.name),
  };
}

// fixture: { "searchText": <places:searchText response>, "media": { "<photo name>": { "photoUri": "..." } } }
async function readPlaces({ name, town, key, fixturePath, budget }) {
  let search, media;
  if (fixturePath) {
    const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    search = async () => fx.searchText;
    media = async (photoName) => fx.media?.[photoName] ?? null;
  } else {
    const post = (mask) => fetchCapped('https://places.googleapis.com/v1/places:searchText', {
      budget, method: 'POST', maxBytes: 1024 * 1024, accept: /json/, okOnly: false,
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
      body: JSON.stringify({ textQuery: `${name} ${town}, CO`, pageSize: 1, languageCode: 'en', regionCode: 'us' }),
    });
    search = async () => {
      let res = await post(PLACES_FIELDS);
      if (res.status === 400) res = await post(PLACES_FIELDS_COARSE);
      if (res.status !== 200) throw new SourceError(`Places search returned HTTP ${res.status}`);
      return JSON.parse(res.buffer.toString('utf8'));
    };
    media = async (photoName) => {
      const u = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1600&skipHttpRedirect=true&key=${encodeURIComponent(key)}`;
      const res = await fetchCapped(u, { budget, maxBytes: 64 * 1024, accept: /json/ });
      return JSON.parse(res.buffer.toString('utf8'));
    };
  }
  const place = placesFromResponse(await search(), name);
  const photos = await Promise.all(place.photoRefs.map((p) => attempt('Places photo', async () => {
    const m = await media(p.name);
    const uri = httpUrl(m?.photoUri || '');
    if (!uri || uri.protocol !== 'https:') return null;
    return { url: uri.href, width: p.width, height: p.height, authors: p.authors, source: 'google' };
  })));
  delete place.photoRefs;
  return { ...place, photos: photos.filter(Boolean) };
}

module.exports = { readPlaces, readSite, extractSite, robotsBlocksAll, namesMatch, claimFree, socialFromUrl, placesFromResponse, decodeEntities, PLACES_FIELDS, PLACES_FIELDS_COARSE };
