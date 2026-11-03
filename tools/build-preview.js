// Preview-site generator (D-035). Builds a one-page, phone-first website for a prospect so the owners
// can show "this is what yours could look like", dressed in the business's own brand: its logo, photos,
// colors and details, with a working sample form, tap-to-call and a booking flow. Deterministic: no AI
// calls. Network sources are best-effort; when any of them fails, the page falls back to the trade
// template look, and the build itself never fails because a source did.
//
// Usage:
//   node ops/previews/build-preview.js --name "Naturally Spotless Cleaning LLC" --town Clifton \
//        [--trade cleaning] [--phone "(970) 555-0100"] [--days 14] [--out ../bookcliff-previews] \
//        [--lead-url https://...] [--request <portal id>] \
//        [--site https://their-site.com | https://facebook.com/page | https://instagram.com/name] \
//        [--logo https://.../logo.png] [--photos "url1,url2" (or one per line, at most 6)] \
//        [--places-fixture saved-places.json] [--social "facebook/instagram URL (one per line)"] [--details JSON]
//   Env: GOOGLE_PLACES_API_KEY (optional), PREVIEW_LEAD_URL (default for --lead-url).
//   Setup: `npm ci` in ops/previews installs sharp (pinned in package-lock.json). Without it the build
//   still runs, minus the logo and image-derived colors.
//
// Sources, most trusted first (sources.js); an explicit flag always beats a discovered value:
//   1. Google Places API (New), only when GOOGLE_PLACES_API_KEY is set (or --places-fixture, a saved
//      { searchText, media } response pair for tests). Name, category, phone, hours, website, editorial
//      summary and up to 6 photos. Photos are hotlinked by photoUri (Google's terms forbid storing them),
//      with each author credited and a "Google Maps" attribution. Ratings and reviews are never requested.
//      The street address is never shown. Google Maps and Search are never scraped.
//   2. Their own website (--site, else Places websiteUri): one HTML fetch, robots.txt "Disallow: /"
//      respected. Logo (schema.org logo, a logo <img>, apple-touch-icon, then og:image), photos (og:image
//      and large content images, hotlinked), theme-color, meta description, phone, Facebook and Instagram
//      links, and "family owned" only when the site says it. Facebook and Instagram URLs are never
//      fetched, only linked ("Find us on Facebook").
//   3. Owner-supplied --logo and --photos.
//   The logo is downloaded, trimmed and re-encoded as <slug>/logo.png (SVGs are rasterized). Photos are
//   never stored; the hero photo from their own site may be read into memory once to sample colors.
//   Network limits (net.js): 8 s per request, HTML 2 MB, images 8 MB, content-type checks, http(s) only,
//   no private addresses, and 45 s for all fetching together.
//
// Colors (colors.js): primary, accent and dark from the logo (SVG fill and stroke colors for SVGs), else
// the site's theme-color, else their own hero photo, else the trade's palette (trades.js). Every text
// and button pair is adjusted to WCAG 2.2 AA in both light and dark color schemes.
//
// What it writes into --out (default ./previews-out):
//   <slug>-<code>/index.html   the preview (unguessable folder name), plus logo.png when a logo was found
//   previews.json              active previews: slug, business, built, expires (read by n8n's preview
//                              reply to decide which business name it may use; expired ones are refused)
//   robots.txt                 disallow everything
// Stdout: one JSON line (slug, business, trade, town, expires, file, sources).
//
// --sample (D-050): a sample design for a MADE-UP business, for our own Work section. It takes no outside
// source at all (no --site, --logo, --photos, Places or lead URL: refused), never expires, writes to
// <out>/<slug>/ with no random code, skips previews.json and robots.txt, and says on every screen that the
// business is made up. Check the name against Colorado's business and trade-name records first.
//   --sample-photos manifest.json (samples only, D-058): free-licensed photos we downloaded and checked by hand,
//   copied next to the page as img/<file> (never hotlinked). Each needs alt text and a CC0, public-domain, CC BY
//   or CC BY-SA licence; CC BY and BY-SA also need the creator, the source page and the licence link. Every photo
//   is credited in the footer, the gallery says the photos stand in for the business's own, and
//   "slides": true turns the hero photos into a slow, faded black-and-white slideshow (still for reduced motion).
//
// Rules it enforces: "Preview by Bookcliff Web. Not <business>'s official site" banner on every screen
// with the expiry date, noindex, services labelled as samples, no reviews, ratings, review counts,
// prices, licenses, awards or claims (claim sentences are dropped from outside descriptions), the phone
// is a marked sample unless given or found, everything from outside sources is escaped and only http(s)
// URLs are used. The page ships no external JS and a hash-based Content-Security-Policy.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TRADES = require('./trades');
const { createBudget, httpUrl, fetchCapped, attempt } = require('./net');
const { readPlaces, readSite, readPages, socialFromUrl, claimFree } = require('./sources');
const { loadLogo, photoColorEntries, imageSize, hasSharp } = require('./brand');
const C = require('./colors');
const ART = require('./art');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };

const BOOKCLIFF_CAL = 'https://cal.com/cloudburstt/15min';
const FETCH_BUDGET_MS = 45000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const findTrade = (text) => Object.keys(TRADES).find((k) => k !== 'general' && TRADES[k].match.test(String(text || '')));
const telHref = (phone) => { const d = phone.replace(/[^\d+]/g, ''); return `tel:${d.startsWith('+') ? d : '+1' + d}`; };

// Squarespace's image CDN resizes by query string, so their photos get a srcset instead of 2 MB originals.
function responsive(url, widths) {
  const u = new URL(url);
  // Wix (D-061): the original is static.wixstatic.com/media/<file>; sized copies are /v1/fit/w_W,h_W,.../<file>.
  const wix = /^https:\/\/static\.wixstatic\.com\/media\/([^/?#]+)$/i.exec(u.href);
  if (wix) {
    const at = (w) => `${u.href}/v1/fit/w_${w},h_${w},q_85,enc_auto/${wix[1]}`;
    return { src: at(widths[widths.length - 1]), srcset: widths.map((w) => `${at(w)} ${w}w`).join(', ') };
  }
  if (/(^|\.)squarespace-cdn\.com$|(^|\.)squarespace\.com$/.test(u.hostname)) {
    const at = (w) => { const v = new URL(u.href); v.searchParams.set('format', `${w}w`); return v.href; };
    return { src: at(widths[widths.length - 1]), srcset: widths.map((w) => `${at(w)} ${w}w`).join(', ') };
  }
  return { src: u.href, srcset: '' };
}

const ICON = {
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/>',
  facebook: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
  instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
};
const icon = (n, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">${ICON[n]}</svg>`;

async function validatePhoto(p, budget) {
  // Hotlinked photos must be live images; an http URL is upgraded to https or dropped (mixed content).
  const u = httpUrl(p.url);
  if (!u) return null;
  if (u.protocol === 'http:') u.protocol = 'https:';
  // Check the copy the page will show (a CDN's sized copy where there is one), not a many-megabyte original.
  const shown = responsive(u.href, [1600]).src;
  const res = await fetchCapped(shown, { budget, headersOnly: true, maxBytes: 8 * 1024 * 1024, accept: /^image\/(jpeg|png|webp|avif|gif)/ });
  return { ...p, url: shown === u.href ? res.url : u.href };
}

// Free-licensed photos for a sample (D-058). Throws on anything unsafe or unlicensed; returns the photos with
// the fields the page needs, and the files to copy into <slug>/img/.
const LICENSES = { cc0: 'CC0 1.0', pdm: 'Public Domain Mark', by: 'CC BY', 'by-sa': 'CC BY-SA' };
function readSamplePhotos(manifestPath) {
  const dir = path.dirname(path.resolve(manifestPath));
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const list = Array.isArray(m.photos) ? m.photos : [];
  const https = (u) => { try { return new URL(u).protocol === 'https:' ? new URL(u).href : null; } catch { return null; } };
  const photos = list.map((p, i) => {
    const where = `--sample-photos photo ${i + 1}`;
    const okFile = (f) => typeof f === 'string' && /^[a-z0-9][a-z0-9-]{0,60}\.(webp|jpg|jpeg|avif)$/.test(f) && fs.existsSync(path.join(dir, f));
    if (!okFile(p.file)) throw new Error(`${where}: "file" must be a plain image name next to the manifest`);
    if (p.small !== undefined && !okFile(p.small)) throw new Error(`${where}: "small" must be a plain image name next to the manifest`);
    if (!['hero', 'gallery', 'about'].includes(p.role)) throw new Error(`${where}: "role" must be hero, gallery or about`);
    if (!p.alt || String(p.alt).length > 200) throw new Error(`${where}: alt text is required`);
    if (!LICENSES[p.license]) throw new Error(`${where}: licence must be one of ${Object.keys(LICENSES).join(', ')}`);
    const source = https(p.source), licenseUrl = https(p.licenseUrl), creatorUrl = p.creatorUrl ? https(p.creatorUrl) : null;
    if (/^by/.test(p.license) && (!p.creator || !source || !licenseUrl)) throw new Error(`${where}: CC BY and BY-SA need the creator, the source page and the licence link`);
    if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 600 || p.height < 400) throw new Error(`${where}: width and height (pixels) are required`);
    return { url: `img/${p.file}`, srcset: p.small ? `img/${p.small} 800w, img/${p.file} ${p.width}w` : '', width: p.width, height: p.height, alt: String(p.alt),
      role: p.role, source: 'sample', local: true, files: [p.file, ...(p.small ? [p.small] : [])].map((f) => path.join(dir, f)),
      lic: { name: `${LICENSES[p.license]}${p.licenseVersion && /^by/.test(p.license) ? ` ${p.licenseVersion}` : ''}`, url: licenseUrl, creator: p.creator ? String(p.creator) : '', creatorUrl,
        title: p.title ? String(p.title) : '', source, changes: p.changes ? String(p.changes) : '' } };
  });
  const heroes = photos.filter((p) => p.role === 'hero');
  if (heroes.length > 6 || photos.filter((p) => p.role === 'gallery').length > 6 || photos.filter((p) => p.role === 'about').length > 1) throw new Error('--sample-photos: at most 6 hero, 6 gallery and 1 about photo');
  return { photos, slides: m.slides === true && heroes.length >= 2 };
}

async function main() {
  const rawName = opt('--name');
  if (!rawName) { console.error('Usage: --name "Business LLC" --town Town [--trade key] [--phone ...] [--days 14] [--out dir] [--site url] [--logo url] [--photos urls] [--places-fixture file]'); process.exit(1); }
  const town = opt('--town', 'Grand Junction');
  const SAMPLE = args.includes('--sample');
  if (SAMPLE) {
    const outside = ['--site', '--logo', '--photos', '--places-fixture', '--lead-url', '--phone', '--request', '--social', '--details'].filter((k) => args.includes(k));
    if (outside.length) { console.error(`--sample is for made-up businesses and takes no outside source: drop ${outside.join(', ')}`); process.exit(1); }
  }
  if (args.includes('--sample-photos') && !SAMPLE) { console.error('--sample-photos is for --sample builds only'); process.exit(1); }
  let samplePhotos = { photos: [], slides: false };
  if (SAMPLE && args.includes('--sample-photos')) {
    try { samplePhotos = readSamplePhotos(opt('--sample-photos', '')); } catch (e) { console.error(e.message); process.exit(1); }
  }
  const phoneArg = opt('--phone', '');
  const days = parseInt(opt('--days', '14'), 10) || 14;
  const outDir = path.resolve(opt('--out', 'previews-out'));
  // The live lead-reply endpoint for previews; empty until the n8n preview reply is deployed (OQ-050).
  const leadUrl = SAMPLE ? null : httpUrl(opt('--lead-url', process.env.PREVIEW_LEAD_URL || ''));
  const LEAD_URL = leadUrl && leadUrl.protocol === 'https:' ? leadUrl.href : '';
  const tradeFlag = opt('--trade');
  if (tradeFlag && !TRADES[tradeFlag]) { console.error(`Unknown trade "${tradeFlag}". Use one of: ${Object.keys(TRADES).join(', ')}`); process.exit(1); }

  const name = rawName.replace(/,?\s*\b(L\.?L\.?C|Inc\.?|Incorporated|Corp\.?|Co\.)\s*$/i, '').replace(/\s+/g, ' ').trim();
  const slugBase = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const code = crypto.randomBytes(3).toString('hex');
  const slug = SAMPLE ? slugBase : `${slugBase}-${code}`;
  // Sample photos get full paths: bookcliffweb.com serves samples at /samples/<slug> with no trailing slash, where a
  // relative "img/x.webp" would point at /samples/img/x.webp and fail (D-058). --img-base for anywhere else.
  const imgBase = String(opt('--img-base', `/samples/${slug}/img/`));
  if (!/^(\/[a-z0-9-]+)*\/img\/$|^img\/$/.test(imgBase)) { console.error('--img-base must look like /path/img/ or img/'); process.exit(1); }
  for (const p of samplePhotos.photos) {
    p.url = p.url.replace(/^img\//, imgBase);
    p.srcset = p.srcset.replace(/(^|, )img\//g, `$1${imgBase}`);
  }
  const today = new Date();
  const expires = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
  const built = today.toISOString().slice(0, 10);

  // ---------- gather (best-effort, bounded) ----------
  const budget = createBudget(FETCH_BUDGET_MS);
  const key = SAMPLE ? '' : process.env.GOOGLE_PLACES_API_KEY || '';
  const fixture = opt('--places-fixture', '');
  const places = key || fixture ? await attempt('Google Places', () => readPlaces({ name: rawName, town, key, fixturePath: fixture, budget })) : null;
  if (places?.status && places.status !== 'OPERATIONAL') console.error(`[preview] Google Places says this business is ${places.status}`);
  // Google's Places terms let us keep only the place ID: its hours, phone, summary and photos can't be baked into a
  // saved page, even for 14 days (HQ D-044). So Places only finds their website and trade, and links to the listing.
  if (places) Object.assign(places, { photos: [], phone: '', hours: [], summary: '' });

  const siteArg = opt('--site', '') || places?.website || '';
  const socials = {};
  let site = null;
  const socialSite = socialFromUrl(siteArg);
  if (socialSite) socials[socialSite.kind] = socialSite.url;
  else if (siteArg) site = await attempt('website', () => readSite(siteArg, { budget, businessName: name }));
  for (const [k, v] of Object.entries(site?.socials || {})) if (!socials[k]) socials[k] = v;
  // --social: their Facebook page or Instagram profile, one per line, found by the portal's lookup (D-060).
  // Linked only ("Find us on Facebook"), never fetched; their own website's links win.
  // --details: what the portal's lookup read about them (D-060), as JSON: { social: [urls], services: [names],
  // about: "..." }. Their own website's words win; claim sentences and claim-like service names are dropped.
  const details = (() => {
    try {
      const d = JSON.parse(String(opt('--details', '') || '{}'));
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  })();
  const strList = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim());
  for (const line of [...String(opt('--social', '')).split(/\r?\n/), ...strList(details.social, 4)].slice(0, 6)) {
    const s = socialFromUrl(line.trim());
    if (s && !socials[s.kind]) socials[s.kind] = s.url;
  }
  const CLAIMISH = /\$|\d\s*(stars?|%)|\b(best|free|cheap|#\s*1|rated|award|licen[cs]|certified|insured|guarantee|top)\b/i;
  const theirServices = strList(details.services, 6).filter((s) => s.length >= 3 && s.length <= 60 && !CLAIMISH.test(s));
  const lookedUpAbout = claimFree(String(details.about ?? '').slice(0, 600), 360);

  const logoCandidates = [];
  const ownerLogo = httpUrl(opt('--logo', ''));
  if (ownerLogo) logoCandidates.push({ url: ownerLogo.href, from: '--logo' });
  for (const c of site?.logos || []) if (!logoCandidates.some((x) => x.url === c.url)) logoCandidates.push(c);
  let logo = null;
  for (const c of logoCandidates.slice(0, 5)) {
    logo = await attempt(`logo from ${c.from}`, () => loadLogo(c.url, { budget, rejectPhotos: Boolean(c.rejectPhotos) }));
    if (logo) { logo.from = c.from; break; }
  }

  const photosArg = String(opt('--photos', ''));
  const ownerPhotos = photosArg.split(/\r?\n/).flatMap((line) => line.split(/,\s*(?=[a-z][a-z0-9+.-]*:)/i))
    .map((s) => s.trim()).filter(Boolean).slice(0, 6).map((url) => ({ url, width: 0, height: 0, alt: '', source: 'owner' }));
  const toCheck = [...ownerPhotos, ...(site?.photos || []).map((p) => ({ ...p, source: 'site' }))].slice(0, 12);
  const checked = await Promise.all(toCheck.map((p) => attempt(`photo from ${p.source}`, () => validatePhoto(p, budget))));
  const seenPhoto = new Set();
  let photos = [...checked.filter((p) => p && p.source === 'owner'), ...(places?.photos || []), ...checked.filter((p) => p && p.source === 'site')]
    .filter((p) => { const k = p.url.split('?')[0]; if (seenPhoto.has(k) || (logo && logo.url.split('?')[0] === k)) return false; seenPhoto.add(k); return true; })
    .slice(0, 8);
  // Each photo is measured (D-061): the page's own width and height are display sizes or placeholders. Photos
  // under 480 px on their short side are dropped, so nothing on the preview is stretched or blurry.
  if (hasSharp() && photos.length) {
    await Promise.all(photos.map(async (p) => {
      const size = await attempt('photo size', () => imageSize(responsive(p.url, [1600]).src, { budget }));
      if (size) Object.assign(p, size, { measured: true });
    }));
    photos = photos.filter((p) => !p.measured || Math.min(p.width, p.height) >= 480);
  }
  photos = photos.slice(0, 7);
  const heroIndex = Math.max(0, photos.findIndex((p) => !p.width || (p.width >= 800 && p.width / p.height >= 1.15 && p.width / p.height <= 2.4)));
  const sp = samplePhotos.photos;
  // A prospect with 4 or more photos of their own gets a rotating hero of 2 or 3 of them, in colour (D-058); the
  // rest fill the gallery. Fewer photos: one hero photo with a slow zoom, as before.
  // Their photos' own labels (D-061): a photo whose alt names a service becomes that service's card; one of the
  // owners or team goes in About. Only their own words, from their own page.
  const ABOUT_ALT = /\b(owners?|team|founders?|family|crew|staff|meet)\b/i;
  const labelled = (p) => p.alt && p.alt.length <= 48 && !/\.(jpe?g|png|webp|avif)$/i.test(p.alt) && /[a-z]{3}/i.test(p.alt);
  const servicePhotos = sp.length ? [] : photos.filter((p) => labelled(p) && !ABOUT_ALT.test(p.alt));
  const photoServices = servicePhotos.length >= 3 ? servicePhotos.slice(0, 6) : [];
  const teamPhoto = sp.length ? null : photos.find((p) => labelled(p) && ABOUT_ALT.test(p.alt)) || null;
  const free = photos.filter((p) => !photoServices.includes(p) && p !== teamPhoto);
  // Three hero styles, picked by the business's name so previews don't all look alike (D-061, D-062):
  //   full:  a sharp, wide photo (1100 px or more) across the hero, slowly zooming; 2+ of those with 4+ photos rotate;
  //   split: the photo framed beside the headline on a band of their brand color (also any photo too small for full);
  //   faded: their photos as a soft, faded background washed in their brand color, rotating when there are 2 or 3.
  //          Fading hides softness, so photos from 700 px qualify.
  const big = (p) => (p.width >= 1100 || (!p.measured && !p.width)) && p.width / (p.height || 1) >= 1.15 && p.width / (p.height || 1) <= 2.6;
  const bigOnes = free.filter(big);
  const nameHash = [...slugBase].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const fadeOnes = free.filter((p) => p.width >= 700 && p.width / (p.height || 1) >= 1);
  const faded = !sp.length && nameHash % 3 === 2 && fadeOnes.length >= 1;
  const heroCount = photos.length >= 5 ? 3 : photos.length >= 4 ? 2 : 1;
  const prospectHeroes = faded
    ? fadeOnes.slice(0, Math.max(1, Math.min(3, fadeOnes.length, photos.length >= 3 ? 3 : 1)))
    : heroCount > 1 && bigOnes.length >= heroCount ? bigOnes.slice(0, heroCount) : bigOnes.length ? [bigOnes[0]] : free.length ? [free[0]] : [];
  const heroes = sp.length ? sp.filter((p) => p.role === 'hero') : prospectHeroes;
  const hero = heroes[0] || null;
  const split = !faded && !sp.length && heroes.length === 1 && hero && (!big(hero) || nameHash % 3 === 1);
  const rest = sp.length ? sp.filter((p) => p.role === 'gallery') : free.filter((p) => !heroes.includes(p));

  // ---------- trade, facts, palette ----------
  const tradeKey = tradeFlag || findTrade(rawName) || [places?.category, ...(site?.tradeHints || [])].map(findTrade).find(Boolean) || 'general';
  const T = TRADES[tradeKey];
  const phone = phoneArg || places?.phone || site?.phone || '';
  const description = places?.summary || site?.description || lookedUpAbout || '';
  const descriptionFrom = places?.summary ? 'google' : site?.description ? 'site' : lookedUpAbout ? 'lookup' : '';
  const hours = places && places.status !== 'CLOSED_PERMANENTLY' ? places.hours : [];
  const category = T.label || ''; // never Google's category text on the page (see above)

  let palette = null, paletteFrom = 'trade';
  if (logo) {
    const p = C.pickPalette(logo.entries, logo.mode);
    if (p.primary) { palette = p; paletteFrom = 'logo'; }
  }
  // The colors their own site's styles use most (D-061), before a single theme-color or a photo's colors.
  if (!palette && site?.cssColors?.length) {
    const p = C.pickPalette(site.cssColors, 'logo');
    if (p.primary) { palette = p; paletteFrom = 'site styles'; }
  }
  const theme = site?.themeColor;
  if (!palette && theme && C.chroma(theme) >= 0.12 && C.toHsl(theme).l > 0.08 && C.toHsl(theme).l < 0.92) { palette = { primary: theme, accent: null, dark: null }; paletteFrom = 'theme-color'; }
  if (!palette && hero && hero.source !== 'google' && !hero.local) {
    const entries = await attempt('photo colors', () => photoColorEntries(hero.url, { budget }));
    const p = entries ? C.pickPalette(entries, 'photo') : null;
    if (p?.primary) { palette = p; paletteFrom = 'photo'; }
  }
  if (!palette) palette = { primary: C.parseColor(T.accent), accent: null, dark: C.parseColor(T.accentDark) };
  let tokens = C.buildTokens(palette);
  const failing = C.contrastPairs(tokens).filter((x) => x.ratio < x.min);
  if (failing.length) {
    console.error(`[preview] palette from ${paletteFrom} missed AA on ${failing.map((f) => f.name).join(', ')}; using the trade palette`);
    tokens = C.buildTokens({ primary: C.parseColor(T.accent), accent: null, dark: C.parseColor(T.accentDark) });
    paletteFrom = 'trade';
  }

  // ---------- markup pieces ----------
  const initials = name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const wordmark = logo && logo.width / logo.height >= 2.2;
  const logoClass = logo ? `logo-${logo.tone}` : 'logo-none';
  const brandHtml = logo
    ? `<img class="logo" src="logo.png" width="${logo.width}" height="${logo.height}" alt="${wordmark ? esc(name) : ''}">${wordmark ? '' : `<span class="brand-name">${esc(name)}</span>`}`
    : `<span class="mark" aria-hidden="true">${esc(initials)}</span><span class="brand-name">${esc(name)}</span>`;
  const callSmall = phone
    ? `<a class="btn btn-main btn-sm" href="${esc(telHref(phone))}">${icon('phone')}<span>Call</span></a>`
    : `<span class="btn btn-main btn-sm is-sample" title="Your number goes here">${icon('phone')}<span>Call</span> <small>sample</small></span>`;
  const callHero = phone
    ? `<a class="btn btn-onphoto" href="${esc(telHref(phone))}">${icon('phone')}Call ${esc(phone)}</a>`
    : `<span class="btn btn-onphoto is-sample" title="Your number goes here">${icon('phone')}Call (970) 000-0000 <small>sample</small></span>`;

  const googleMark = '<span class="gmaps">Google Maps</span>';
  const credit = (p) => p.source === 'google' && p.authors?.length
    ? `Photo: ${p.authors.map((a) => (a.uri ? `<a href="${esc(a.uri)}" rel="noopener nofollow">${esc(a.name)}</a>` : esc(a.name))).join(', ')}`
    : p.lic ? `Photo: ${p.lic.creator ? esc(p.lic.creator) : 'public domain'}, <a href="#credits">${esc(p.lic.name)}</a>` : '';
  const altFor = (p, i) => p.alt || (p.source === 'google' ? `Photo of ${name} on Google Maps` : p.source === 'site' ? `Photo ${i + 1} from ${name}'s website` : `Photo of ${name}`);
  const img = (p, i, { sizes, lazy }) => {
    const r = p.local ? { src: p.url, srcset: p.srcset } : responsive(p.url, lazy ? [500, 750, 1000] : [750, 1000, 1500]);
    const [w, h] = p.width && p.height ? [p.width, p.height] : [1200, 900];
    return `<img src="${esc(r.src)}"${r.srcset ? ` srcset="${esc(r.srcset)}" sizes="${sizes}"` : ''} width="${w}" height="${h}" alt="${esc(altFor(p, i))}" referrerpolicy="no-referrer" data-ext ${lazy ? 'loading="lazy" decoding="async"' : 'fetchpriority="high"'}>`;
  };

  const heroLine = (() => {
    const first = (description.match(/^.{20,180}?[.!?](\s|$)/) || [])[0];
    return first ? first.trim() : T.sub;
  })();

  const trust = [];
  trust.push(`<li>${icon('pin')}<span><strong>${esc(town)}, CO</strong><small>${places?.serviceArea || !['food', 'salon', 'auto', 'health'].includes(tradeKey) ? 'Service area' : 'Location'}</small></span></li>`);
  if (hours.length) {
    const open = hours.filter((h) => !/closed/i.test(h)).length;
    trust.push(`<li>${icon('clock')}<span><strong><a href="#hours">${open === 7 ? 'Open 7 days' : `Open ${open} day${open === 1 ? '' : 's'} a week`}</a></strong><small>Hours</small></span></li>`);
  }
  if (phone) trust.push(`<li>${icon('phone')}<span><strong><a href="${esc(telHref(phone))}">${esc(phone)}</a></strong><small>Call</small></span></li>`);
  if (site?.familyOwned) trust.push(`<li>${icon('home')}<span><strong>Family owned</strong><small>Local business</small></span></li>`);
  const trustHtml = trust.length >= 2 ? `<div class="wrap"><ul class="trust" aria-label="At a glance">${trust.join('')}</ul></div>` : '';

  // Their own services when the lookup found at least 3 on their website (D-060); otherwise the trade's samples.
  // Or their photos' service labels with the photos themselves (D-061).
  const ownServices = theirServices.length >= 3 || photoServices.length >= 3;
  const serviceList = theirServices.length >= 3
    ? theirServices.map((h) => [h, '', photoServices.find((p) => p.alt.toLowerCase() === h.toLowerCase()) || null])
    : photoServices.length ? photoServices.map((p) => [p.alt, '', p]) : T.services.map(([h, p]) => [h, p, null]);
  const services = serviceList.map(([h, p, ph], i) => ph
    ? `<li data-reveal class="svc-photo" data-photo><figure>${img(ph, i + 1, { sizes: '(min-width: 760px) 30vw, 100vw', lazy: true }).replace(/ alt="[^"]*"/, ' alt=""')}</figure><h3>${esc(h)}</h3>${p ? `<p>${esc(p)}</p>` : ''}</li>`
    : `<li data-reveal><span class="num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><h3>${esc(h)}</h3>${p ? `<p>${esc(p)}</p>` : ''}</li>`).join('');
  const options = serviceList.map(([h]) => `<option>${esc(h)}</option>`).join('');
  const steps = T.steps.map((s, i) => `<li><span aria-hidden="true">${i + 1}</span>${esc(s)}</li>`).join('');

  const gallery = rest.length >= 2 ? rest : [];
  const aboutPhoto = sp.length ? sp.find((p) => p.role === 'about') || null : teamPhoto || (rest.length === 1 ? rest[0] : null);
  const fig = (p, i, sizes) => {
    const c = credit(p);
    return `<li data-photo data-reveal><figure>${img(p, i + 1, { sizes, lazy: true })}${c ? `<figcaption>${c}</figcaption>` : ''}</figure></li>`;
  };
  const sources = new Set(gallery.map((p) => p.source));
  const galleryNote = sources.has('sample')
    ? `Free-licensed photos standing in for the business's own work (credits at the bottom). On a real site, these are your own photos. <span class="tag">sample</span>`
    : sources.size === 1 && sources.has('google')
    ? `Photos from ${esc(name)}'s Google Business Profile, shown from ${googleMark}.`
    : sources.size === 1 && sources.has('site') ? `Photos from ${esc(name)}'s own website.` : `Photos of ${esc(name)}.`;
  const galleryHtml = gallery.length ? `
<section id="photos" class="sec sec-tint" aria-labelledby="photos-h"><div class="wrap">
<div class="sec-head" data-reveal><p class="kicker">Photos</p><h2 id="photos-h">A look at ${esc(name)}</h2><p class="lead">${galleryNote}</p></div>
<ul class="gallery">${gallery.map((p, i) => fig(p, i, '(min-width: 760px) 34vw, 50vw')).join('')}</ul>
${places?.mapsUri && sources.has('google') ? `<p class="fine"><a href="${esc(places.mapsUri)}" rel="noopener">See every photo on Google Maps</a></p>` : ''}
</div></section>` : '';

  const socialHtml = Object.entries(socials).map(([k, u]) => `<a class="social" href="${esc(u)}" rel="noopener">${icon(k)}Find us on ${k === 'facebook' ? 'Facebook' : 'Instagram'}</a>`).join('');
  const siteHost = site ? new URL(site.url).hostname.replace(/^www\./, '') : '';
  const aboutText = description
    ? `<p class="about-text">${esc(description)}</p><p class="src">${descriptionFrom === 'google' ? `Summary from ${googleMark}` : descriptionFrom === 'lookup' ? 'From a look at their website and listings' : `In their words, from ${esc(siteHost)}`}</p>`
    : `<p class="about-text">This is where ${esc(name)}'s story goes: how it started, who does the work and what makes it different. <span class="tag">sample</span></p>`;
  // No photo of their own: our illustrations (art.js) fill the hero and the About section instead (D-051).
  const scene = ART.sceneFor(tradeKey);
  const aboutHtml = `
<section id="about" class="sec" aria-labelledby="about-h"><div class="wrap about${aboutPhoto ? ' has-photo' : ' has-art'}">
<div data-reveal><p class="kicker">About</p><h2 id="about-h">About ${esc(name)}</h2>${aboutText}${socialHtml ? `<div class="socials">${socialHtml}</div>` : ''}</div>
${aboutPhoto ? `<figure class="about-photo" data-photo data-reveal>${img(aboutPhoto, 1, { sizes: '(min-width: 760px) 45vw, 100vw', lazy: true })}${credit(aboutPhoto) ? `<figcaption>${credit(aboutPhoto)}</figcaption>` : ''}</figure>` : `<div class="about-art">${ART.aboutArt(scene)}</div>`}
</div></section>`;

  const hoursHtml = hours.length ? `
<section id="hours" class="sec sec-tint" aria-labelledby="hours-h"><div class="wrap grid2">
<div><p class="kicker">Visit</p><h2 id="hours-h">Hours</h2><p class="lead">${esc(town)}, Colorado${phone ? ` · <a href="${esc(telHref(phone))}">${esc(phone)}</a>` : ''}</p>
<p class="fine">Details from ${googleMark}.${places.mapsUri ? ` <a href="${esc(places.mapsUri)}" rel="noopener">View on Google Maps</a>` : ''}</p></div>
<div class="card"><table class="hours"><caption class="sr">Opening hours</caption><tbody>${hours.map((h) => { const i = h.indexOf(':'); return i > 0 ? `<tr><th scope="row">${esc(h.slice(0, i))}</th><td>${esc(h.slice(i + 1).trim())}</td></tr>` : `<tr><td colspan="2">${esc(h)}</td></tr>`; }).join('')}</tbody></table></div>
</div></section>` : '';

  const heroCopy = `<p class="eyebrow">${category ? `${esc(category)} · ` : ''}${esc(town)}, Colorado</p>
<h1 id="h1">${esc(name)}</h1>
<p class="hero-sub">${esc(heroLine)}</p>
<div class="btns"><a class="btn btn-main" href="#contact">${esc(T.cta)}${icon('arrow')}</a>${callHero}</div>`;
  // Samples rotate in faded black and white; a prospect's own photos rotate in colour.
  const slides = samplePhotos.slides || (!sp.length && heroes.length >= 2);
  const bwSlides = slides && sp.length > 0;
  const heroHtml = split
    ? `<section class="hero hero-split" aria-labelledby="h1">
<div class="wrap split-inner">
<div class="hero-copy">
${heroCopy}
</div>
<figure class="split-photo" data-photo>${img(hero, 0, { sizes: '(min-width: 900px) 46vw, 100vw', lazy: false })}${credit(hero) ? `<figcaption>${credit(hero)}</figcaption>` : ''}</figure>
</div>
${ART.ridge()}
</section>`
    : hero
    ? `<section class="hero has-photo${slides ? ' has-slides' : ' has-zoom'}${bwSlides ? ' slides-bw' : ''}${faded ? ' has-faded' : ''}" aria-labelledby="h1">
<div class="hero-media${slides ? ' hero-slides' : ''}">${slides ? heroes.map((p, i) => {
    // Every slide loads at once (a hidden lazy image may never be fetched); only the first is urgent. Each is its
    // own data-photo, so one that fails to load is dropped alone.
    const tag = img(p, i, { sizes: '100vw', lazy: false }).replace(/ alt="[^"]*"/, ' alt=""').replace('<img ', '<img data-photo ');
    return i ? tag.replace('fetchpriority="high"', 'fetchpriority="low" decoding="async"') : tag;
  }).join('') : img(hero, 0, { sizes: '100vw', lazy: false })}</div>
<div class="wrap hero-inner">
${heroCopy}
</div>
${slides && sp.length ? `<p class="hero-credit">Photos: <a href="#credits">credits below</a></p>` : !slides && credit(hero) ? `<p class="hero-credit">${credit(hero)}</p>` : ''}
</section>`
    : `<section class="hero has-art art-${scene}" aria-labelledby="h1">
<div class="wrap hero-inner">
<div class="hero-copy">
${heroCopy}
</div>
<div class="hero-art">${ART.heroArt(scene)}</div>
</div>
${ART.ridge()}
</section>`;

  const nav = [['#services', 'Services'], ...(gallery.length ? [['#photos', 'Photos']] : []), ['#about', 'About'], ...(hours.length ? [['#hours', 'Hours']] : []), ['#book', 'Book'], ['#contact', 'Contact']]
    .map(([h, t]) => `<a href="${h}">${t}</a>`).join('');

  // Every sample photo's credit, with its licence and any change we made (CC BY and BY-SA ask for all three).
  const creditsHtml = sp.length ? `<div class="credits" id="credits"><h2>Photo credits</h2><ul>${sp.map((p) => {
    const l = p.lic;
    const who = l.creator ? (l.creatorUrl ? `<a href="${esc(l.creatorUrl)}" rel="noopener nofollow">${esc(l.creator)}</a>` : esc(l.creator)) : 'Unknown photographer';
    const what = l.title ? (l.source ? `<a href="${esc(l.source)}" rel="noopener nofollow">${esc(l.title)}</a>` : esc(l.title)) : l.source ? `<a href="${esc(l.source)}" rel="noopener nofollow">Photo</a>` : 'Photo';
    return `<li>${what} by ${who}, ${l.url ? `<a href="${esc(l.url)}" rel="noopener nofollow license">${esc(l.name)}</a>` : esc(l.name)}${l.changes ? `. ${esc(l.changes)}` : ''}.</li>`;
  }).join('')}</ul><p>The photos stand in for the business's own: ${esc(name)} is made up, and none of this is its work.</p></div>` : '';
  const v = (s) => Object.entries(s).map(([k, c]) => `--${k}:${C.toHex(c)}`).join(';');
  // The hero slideshow (D-058): each photo shows for 7 s, crossfading over about 1.6 s, faded to black and white,
  // drifting slowly closer. Pure CSS; negative delays so the first photo is there on load and none is ever blank.
  const SLIDE_S = 7;
  const slidesCss = (() => {
    if (slides) {
      const N = heroes.length, period = N * SLIDE_S, f = 100 / N, x = Math.min(f / 3, (1.6 / period) * 100);
      const pc = (n) => `${+n.toFixed(3)}%`;
      return `.hero-slides img{position:absolute;inset:0;animation:slide ${period}s linear infinite}
${heroes.map((_, i) => `.hero-slides img:nth-child(${i + 1}){animation-delay:${i === 0 ? 0 : (i - N) * SLIDE_S}s}`).join('')}
@keyframes slide{0%{opacity:1;transform:scale(1)}${pc(f - x)}{opacity:1}${pc(f)}{opacity:0;transform:scale(1.07)}${pc(100 - x)}{opacity:0;transform:scale(1)}100%{opacity:1;transform:scale(1)}}
.slides-bw .hero-slides img{filter:grayscale(1) contrast(.92) brightness(1.06)}
.slides-bw::before{background:linear-gradient(180deg,rgba(10,14,20,.55) 0%,rgba(10,14,20,.5) 45%,var(--overlay-deep) 100%)!important}`;
    }
    return hero ? `.has-zoom .hero-media img{animation:zoom 22s ease-out both}@keyframes zoom{from{transform:scale(1.08)}to{transform:scale(1)}}` : '';
  })();
  // Their fonts (D-061): the Google Fonts their site uses, or the closest free match for its paid ones.
  const SINGLE_WEIGHT = new Set(['Questrial', 'Righteous', 'Russo One', 'Archivo Black', 'Fjalla One', 'Anton', 'Bebas Neue', 'Abril Fatface']);
  const fonts = SAMPLE ? null : site?.fonts || null;
  const fontFam = (f) => `family=${f.replace(/ /g, '+')}${SINGLE_WEIGHT.has(f) ? '' : ':wght@400;600;700'}`;
  const fontsHref = fonts ? `https://fonts.googleapis.com/css2?${[fonts.heading, fonts.body].filter(Boolean).map(fontFam).join('&')}&display=swap` : '';
  const designCss = `
.hero-split{background:var(--band);background:radial-gradient(110% 80% at 100% 0%,var(--glow),transparent 60%),linear-gradient(160deg,var(--band),color-mix(in srgb,var(--band) 72%,var(--btn)))}
.split-inner{position:relative;z-index:1;display:grid;gap:34px;align-items:center;padding-top:44px;padding-bottom:clamp(72px,10vw,120px)}
@media(min-width:900px){.split-inner{grid-template-columns:1.05fr .95fr;gap:52px;padding-top:76px}}
.split-photo{position:relative;margin:0 14px 14px 0;isolation:isolate}
.split-photo::before{content:"";position:absolute;inset:16px -14px -14px 16px;border-radius:26px;background:var(--btn);z-index:-1}
.split-photo img{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:26px;box-shadow:0 30px 60px rgba(0,0,0,.35)}
.split-photo figcaption{border-radius:0 0 26px 26px}
.svc li.svc-photo{display:block;padding:0}.svc-photo figure{margin:0;aspect-ratio:4/3;overflow:hidden;background:var(--line)}
.svc-photo img{width:100%;height:100%;object-fit:cover;aspect-ratio:4/3;transition:transform .8s cubic-bezier(.2,.7,.2,1)}.svc-photo:hover img{transform:scale(1.05)}
.svc-photo h3{padding:16px 20px 4px}.svc-photo p{padding:0 20px 18px}.svc-photo h3:last-child{padding-bottom:20px}
.page-hero{position:relative;overflow:hidden;color:#fff;background:var(--band);background:radial-gradient(110% 90% at 100% 0%,var(--glow),transparent 60%),linear-gradient(160deg,var(--band),color-mix(in srgb,var(--band) 75%,var(--btn)))}
.page-hero .wrap{position:relative;z-index:1;padding-top:52px;padding-bottom:clamp(64px,9vw,104px)}.page-hero h1{font-size:clamp(32px,7vw,56px);margin:10px 0 12px;max-width:20ch}
.mnav{display:flex;gap:6px;overflow-x:auto;padding:8px 20px 10px;border-top:1px solid var(--line);scrollbar-width:none}.mnav::-webkit-scrollbar{display:none}
.mnav a{white-space:nowrap;padding:7px 14px;border-radius:999px;border:1px solid var(--line);color:inherit;text-decoration:none;font-weight:600;font-size:14px}
.mnav a[aria-current],nav.main a[aria-current]{color:var(--btn-ink);background:var(--btn);border-color:var(--btn);opacity:1;text-decoration:none}nav.main a[aria-current]{padding:6px 12px;border-radius:999px}
@media(min-width:900px){.mnav{display:none}}
.card-link{display:contents;color:inherit;text-decoration:none}.svc .more{grid-column:2;display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:14px;color:var(--link)}.svc-photo .more{padding:0 20px 18px}.svc li:has(.card-link):hover h3{text-decoration:underline}
.cta-band{background:var(--band);color:var(--on-band);padding:48px 0}.cta-inner{display:flex;flex-wrap:wrap;gap:20px;align-items:center;justify-content:space-between}.cta-band h2{margin:0 0 6px}.cta-band p{margin:0;color:var(--on-band-muted)}.cta-band a:not(.btn){color:var(--band-link)}
.svc-detail{display:grid;gap:36px;align-items:start}@media(min-width:900px){.svc-detail.has-photo{grid-template-columns:1.1fr .9fr}}.small-h{font-size:18px;margin:28px 0 8px}.links{margin:0;padding-left:18px}.links li{margin:4px 0}
.towns{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}.towns li{display:flex;gap:10px;align-items:center;padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);font-weight:700}.towns .ic{color:var(--accent)}
.r-sharp{--r:8px}.r-sharp .btn,.r-sharp .mnav a,.r-sharp nav.main a[aria-current]{border-radius:10px}.r-sharp .split-photo img,.r-sharp .split-photo::before{border-radius:10px}.r-round{--r:28px}
.hdr-brand header.site{background:var(--band);color:var(--on-band);border-bottom-color:transparent}.hdr-brand .mnav{border-top-color:rgba(255,255,255,.14)}.hdr-brand .mnav a{border-color:rgba(255,255,255,.28)}
.cards-line .svc li{box-shadow:none;border-width:2px}.cards-line .svc li::before{height:0}
.has-faded{background:var(--band);background:linear-gradient(160deg,var(--band),color-mix(in srgb,var(--band) 70%,var(--btn)))}
.has-faded .hero-media{opacity:.36;filter:grayscale(.6) contrast(1.05);mix-blend-mode:luminosity}
.hero.has-faded::before{background:var(--overlay);background:linear-gradient(90deg,color-mix(in srgb,var(--band) 82%,transparent) 0%,color-mix(in srgb,var(--band) 45%,transparent) 75%,color-mix(in srgb,var(--band) 30%,transparent) 100%)}
${fonts ? `h1,h2,h3,.brand-name,.foot-name,.btn{font-family:"${fonts.heading}",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}${fonts.body ? `body{font-family:"${fonts.body}",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}` : ''}${SINGLE_WEIGHT.has(fonts.heading) || /Oswald|Teko|Barlow Condensed/.test(fonts.heading) ? 'h1,h2{letter-spacing:.01em;font-weight:600}' : ''}` : ''}`;
  const ov = tokens.overlay, a = tokens.overlayAlpha;
  const css = `
:root{color-scheme:light dark;${v(tokens.light)};--overlay:${C.rgba(ov, a)};--overlay-deep:${C.rgba(ov, Math.min(0.97, a + 0.14))};--glow:${C.toHex(tokens.heroGlow)};--hdr:var(--surface);--hdr-ink:var(--ink);--r:18px;--shadow:0 1px 2px rgba(15,20,30,.06),0 8px 24px rgba(15,20,30,.08)}
@media (prefers-color-scheme:dark){:root{${v(tokens.dark)};--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35)}}
.logo-light{--hdr:var(--band);--hdr-ink:var(--on-band)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:128px;-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink);background:var(--bg)}
img{display:block;max-width:100%}a{color:var(--link);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:6px}
h1,h2,h3{line-height:1.15;letter-spacing:-.015em;text-wrap:balance}
.wrap{max-width:1140px;margin:0 auto;padding:0 20px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.skip{position:absolute;left:12px;top:-60px;z-index:60;background:var(--surface);color:var(--ink);padding:10px 14px;border-radius:10px}.skip:focus{top:12px}
.ic{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.top{position:sticky;top:0;z-index:40}
.pv{background:#14202e;color:#fff;font-size:12.5px;line-height:1.4;padding:6px 0}
.pv .wrap{display:flex;gap:4px 14px;flex-wrap:wrap;justify-content:space-between}.pv b{color:#f0a060}.pv a{color:#fff}
.pv-more{display:none}@media(min-width:640px){.pv-more{display:inline}}
header.site{background:var(--hdr);color:var(--hdr-ink);border-bottom:1px solid var(--line);box-shadow:0 2px 10px rgba(0,0,0,.06)}
header.site .wrap{display:flex;align-items:center;gap:16px;min-height:62px}
.brand{display:flex;align-items:center;gap:10px;margin-right:auto;min-width:0;color:inherit;text-decoration:none;font-weight:800;font-size:17px;line-height:1.15}
.brand-name{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.logo{height:42px;width:auto;max-width:min(190px,52vw);object-fit:contain}
.mark{width:40px;height:40px;border-radius:12px;background:var(--btn);color:var(--btn-ink);display:grid;place-items:center;font-size:15px;letter-spacing:.04em;flex:none}
@media (prefers-color-scheme:dark){.logo-dark .logo,.logo-opaque .logo{background:#fff;padding:4px 8px;border-radius:10px;height:46px}}
nav.main{display:none;gap:22px}nav.main a{color:inherit;text-decoration:none;font-weight:600;font-size:15px;opacity:.85}nav.main a:hover{opacity:1;text-decoration:underline}
@media(min-width:900px){nav.main{display:flex}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:50px;padding:12px 22px;border-radius:999px;font:inherit;font-weight:700;font-size:16px;text-decoration:none;border:2px solid transparent;cursor:pointer;transition:background-color .15s,transform .15s}
.btn-main{background:var(--btn);color:var(--btn-ink);border-color:var(--btn)}.btn-main:hover{background:var(--btn-hover);border-color:var(--btn-hover)}
.btn-sm{min-height:44px;padding:8px 16px;font-size:15px}
.btn-onphoto{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.9)}.btn-onphoto:hover{background:rgba(255,255,255,.18)}
.btn-ghost{background:transparent;color:var(--link);border-color:var(--field)}
.is-sample{cursor:default}.is-sample small,.tag{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:var(--tag-bg);color:var(--tag-ink);border-radius:6px;padding:2px 6px;vertical-align:middle}
.hero{position:relative;isolation:isolate;overflow:hidden;color:#fff;background:radial-gradient(120% 90% at 85% 0%,var(--glow),transparent 60%),var(--band)}
.hero-media{position:absolute;inset:0;z-index:-2}.hero-media img{width:100%;height:100%;object-fit:cover}
.hero.has-photo::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,var(--overlay) 0%,var(--overlay) 45%,var(--overlay-deep) 100%)}
.hero-inner{min-height:min(74svh,640px);display:flex;flex-direction:column;justify-content:flex-end;padding-top:48px;padding-bottom:44px}
.hero:not(.has-photo) .hero-inner{min-height:0;padding-top:88px;padding-bottom:72px}
.hero.has-art .hero-inner{position:relative;z-index:1;display:grid;gap:28px;align-items:center;padding-top:56px;padding-bottom:clamp(72px,10vw,128px)}
@media(min-width:900px){.hero.has-art .hero-inner{grid-template-columns:1fr 1fr;gap:40px;padding-top:72px}}
.hero-art{width:100%;max-width:300px;justify-self:center}@media(min-width:900px){.hero-art{max-width:540px}}
.art{display:block;width:100%;height:auto;filter:drop-shadow(0 26px 40px rgba(0,0,0,.35))}
.art .sun{fill:#f2a65a;opacity:.9}.art .glow{fill:#f2a65a;opacity:.14}.art .far{fill:rgba(255,255,255,.07)}.art .near{fill:rgba(255,255,255,.12)}
.art .solid,.art .plate{fill:#fff}.art .plate{opacity:.92}.art .brand{fill:var(--btn)}.art .accent{fill:var(--band-link)}.art .glass{fill:#ffd79a}.art .awning{fill:#fff;opacity:.92}
.art .beam{fill:#ffd79a;opacity:.08}.art .spark{fill:#fff;opacity:.55}
.art .line{fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:.85}.art .thin{stroke-width:2;opacity:.5}
.art-build{background:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px) 0 0/32px 32px,linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px) 0 0/32px 32px,radial-gradient(120% 90% at 85% 0%,var(--glow),transparent 60%),var(--band)}
.art-kitchen{background:radial-gradient(rgba(255,255,255,.07) 1.2px,transparent 1.7px) 0 0/22px 22px,radial-gradient(120% 90% at 85% 0%,var(--glow),transparent 60%),var(--band)}
.art-store{background:repeating-linear-gradient(135deg,rgba(255,255,255,.035) 0 2px,transparent 2px 16px),radial-gradient(120% 90% at 85% 0%,var(--glow),transparent 60%),var(--band)}
.hero-ridge{position:absolute;left:0;right:0;bottom:-1px;width:100%;height:clamp(36px,6vw,84px);fill:var(--bg);z-index:0}
.about.has-art{align-items:center}@media(min-width:860px){.about.has-art{grid-template-columns:1.1fr .9fr}}
.about-art{border-radius:24px;padding:28px;border:1px solid var(--line);box-shadow:var(--shadow);background:radial-gradient(var(--line) 1px,transparent 1.5px) 0 0/18px 18px,linear-gradient(160deg,var(--tint),var(--surface))}
.vig{display:block;width:100%;height:auto}.vig .soft{fill:var(--tint)}.vig .brand{fill:var(--btn)}.vig .accent{fill:var(--accent)}.vig .warm{fill:#f2a65a}
.vig .line{fill:none;stroke:var(--ink);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:.8}.vig .thin{stroke-width:1.5;opacity:.3}
.eyebrow{margin:0;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.hero h1{font-size:clamp(36px,9vw,68px);margin:10px 0 14px;max-width:16ch;letter-spacing:-.025em;text-shadow:0 2px 18px rgba(0,0,0,.35)}
.hero-sub{font-size:clamp(17px,2.4vw,21px);line-height:1.5;max-width:44ch;margin:0 0 26px}
.btns{display:flex;gap:12px;flex-wrap:wrap}
.hero-credit{position:absolute;right:12px;bottom:8px;margin:0;font-size:12px;color:#fff}.hero-credit a{color:#fff}
.trust{list-style:none;margin:-30px 0 0;padding:6px;position:relative;z-index:2;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0 4px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.trust li{display:flex;gap:12px;align-items:center;padding:10px 14px}.trust li+li{border-top:1px solid var(--line)}@media(min-width:700px){.trust li+li{border-top:0}}.trust .ic{color:var(--accent);width:24px;height:24px}
.trust strong{display:block;font-size:16px;line-height:1.3;white-space:nowrap}.trust strong a{color:inherit;text-decoration:none}.trust strong a:hover{text-decoration:underline}.trust small{display:block;color:var(--muted);font-size:13px}
.sec{padding:72px 0}.sec-tint{background:radial-gradient(var(--line) 1px,transparent 1.5px) 0 0/22px 22px,var(--tint)}
.sec-head{max-width:640px;margin-bottom:32px}.kicker{margin:0 0 8px;color:var(--accent);font-weight:800;font-size:13px;letter-spacing:.14em;text-transform:uppercase}
h2{font-size:clamp(27px,4.4vw,40px);margin:0 0 12px}.lead{color:var(--muted);font-size:17px;margin:0}
.svc{list-style:none;margin:0;padding:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.svc li{position:relative;overflow:hidden;display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:start;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px;box-shadow:var(--shadow);transition:transform .2s,box-shadow .2s}
.svc li::before{content:"";position:absolute;inset:0 0 auto 0;height:4px;background:linear-gradient(90deg,var(--btn),var(--accent))}
.svc li:hover{transform:translateY(-3px);box-shadow:0 2px 4px rgba(15,20,30,.06),0 18px 36px rgba(15,20,30,.12)}
.svc .num{grid-row:span 2;display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--tag-bg);color:var(--tag-ink);font-weight:800;font-size:14px;letter-spacing:.04em}.svc h3{font-size:18px;margin:0}.svc p{margin:0;color:var(--muted);font-size:15.5px}@media(min-width:700px){.svc li{padding:24px}}
.gallery{list-style:none;margin:0;padding:0;display:grid;gap:10px;grid-template-columns:1fr 1fr}
.gallery li:first-child{grid-column:1/-1}@media(min-width:760px){.gallery{grid-template-columns:repeat(3,1fr);gap:14px}.gallery li:first-child{grid-column:span 2;grid-row:span 2}}
.gallery figure,.about-photo{margin:0;position:relative;border-radius:14px;overflow:hidden;background:var(--line);height:100%}
.gallery img,.about-photo img{width:100%;height:100%;aspect-ratio:4/3;object-fit:cover}
figcaption{position:absolute;left:0;right:0;bottom:0;padding:16px 10px 6px;font-size:12px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.78))}figcaption a{color:#fff}
.about{display:grid;gap:36px;align-items:center}@media(min-width:860px){.about.has-photo{grid-template-columns:1.1fr 1fr}}
.about-text{font-size:19px;line-height:1.65;max-width:60ch;margin:0 0 10px}.src{color:var(--muted);font-size:14px;margin:0 0 20px}
.socials{display:flex;gap:10px;flex-wrap:wrap}.social{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:8px 16px;border:1px solid var(--field);border-radius:999px;text-decoration:none;font-weight:600}
.gmaps{font-family:Roboto,Arial,sans-serif;font-weight:400;white-space:nowrap}
.grid2{display:grid;gap:32px}@media(min-width:860px){.grid2{grid-template-columns:1fr 1fr;align-items:start}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:24px;box-shadow:var(--shadow)}
.hours{width:100%;border-collapse:collapse;font-size:16px}.hours th,.hours td{padding:10px 4px;border-bottom:1px solid var(--line);text-align:left;font-weight:600}.hours td{font-weight:400;color:var(--muted);text-align:right}.hours tr:last-child>*{border-bottom:0}
.steps{list-style:none;margin:24px 0 0;padding:0;display:grid;gap:12px}
.steps li{display:flex;gap:14px;align-items:center;font-weight:700}.steps span{flex:none;width:36px;height:36px;border-radius:50%;background:var(--btn);color:var(--btn-ink);display:grid;place-items:center}
.slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}
.slots button{min-height:46px;padding:8px;border:1px solid var(--field);border-radius:12px;background:var(--surface);color:var(--ink);font:inherit;cursor:pointer}
.slots button[aria-pressed=true]{background:var(--btn);color:var(--btn-ink);border-color:var(--btn)}
form label{display:block;font-weight:600;font-size:15px;margin:14px 0 6px}
form input,form select,form textarea{width:100%;min-height:48px;padding:12px 14px;border:1px solid var(--field);border-radius:12px;font:inherit;background:var(--surface);color:var(--ink)}
.full{width:100%;margin-top:16px}.hp{position:absolute;left:-9999px}.fine{font-size:13px;color:var(--muted);margin:12px 0 0}
.ok{display:none;text-align:center;padding:30px 10px}.ok.show{display:block}.ok h3{margin:0 0 8px;font-size:24px}
.foot{background:var(--band);color:var(--on-band);padding:56px 0 110px;font-size:15px}.foot a{color:var(--band-link)}
.foot-grid{display:grid;gap:28px}@media(min-width:760px){.foot-grid{grid-template-columns:1.2fr 1fr}}
.credits{grid-column:1/-1;border-top:1px solid rgba(255,255,255,.18);padding-top:20px;font-size:13px}.credits h2{font-size:15px}.credits ul{margin:0 0 8px;padding-left:18px;color:var(--on-band-muted)}.credits li{margin:0 0 4px}
.foot-name{font-size:22px;font-weight:800;margin:0 0 6px}.foot p{margin:0 0 8px;color:var(--on-band-muted)}.foot h2{font-size:16px;margin:0 0 8px;color:var(--on-band)}
.foot .social{border-color:var(--on-band-muted);color:var(--on-band)}.foot .socials{margin-top:14px}${slidesCss}${designCss}
.gallery img{transition:transform .8s cubic-bezier(.2,.7,.2,1)}.gallery figure:hover img{transform:scale(1.05)}
.rv{opacity:0;transform:translateY(22px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1)}.rv.in{opacity:1;transform:none}
.svc li.rv:nth-child(2),.gallery li.rv:nth-child(2){transition-delay:.08s}.svc li.rv:nth-child(3),.gallery li.rv:nth-child(3){transition-delay:.16s}.svc li.rv:nth-child(4),.gallery li.rv:nth-child(4){transition-delay:.24s}.gallery li.rv:nth-child(5){transition-delay:.32s}
@media (prefers-reduced-motion:reduce){.rv{opacity:1;transform:none}.hero-media img{animation:none!important}.hero-slides img:not(:first-child){display:none}}
`;

  const script = `
(()=>{const LEAD=${JSON.stringify(LEAD_URL).replace(/</g, '\\u003c')},SLUG=${JSON.stringify(slug)};
document.querySelectorAll('img[data-ext]').forEach(i=>{const gone=()=>{const p=i.closest('[data-photo]')||i.closest('.hero-media');if(p)p.remove();else i.remove();const h=document.querySelector('.hero'),s=document.querySelectorAll('.hero-slides img');if(s.length===1)s[0].style.animation='none';if(h&&!h.querySelector('.hero-media img'))h.classList.remove('has-photo')};if(i.complete&&i.naturalWidth===0&&i.getAttribute('loading')!=='lazy')gone();else i.addEventListener('error',gone)});
if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&'IntersectionObserver' in window){const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{rootMargin:'0px 0px -8% 0px'});
document.querySelectorAll('[data-reveal]').forEach(el=>{if(el.getBoundingClientRect().top>innerHeight*.9){el.classList.add('rv');io.observe(el)}})}
const f=document.getElementById('lead'),ok=document.getElementById('ok');
if(f){f.addEventListener('submit',e=>{e.preventDefault();const d=new FormData(f),em=String(d.get('email')||'').trim();
if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)){f.email.focus();f.email.setCustomValidity('Enter an email address');f.email.reportValidity();return}f.email.setCustomValidity('');
const first=String(d.get('name')||'').trim().split(/\\s+/)[0];
if(LEAD){const b=new URLSearchParams();['name','email','phone','service','message','_gotcha'].forEach(k=>{const v=d.get(k);if(v)b.append(k,String(v).slice(0,1000))});b.append('preview',SLUG);b.append('page',location.pathname);
fetch(LEAD,{method:'POST',mode:'no-cors',body:b}).catch(()=>{});
document.getElementById('okmsg').textContent='Check your inbox: a personal reply is on its way, usually in under a minute.'}
else{document.getElementById('okmsg').textContent=${JSON.stringify(SAMPLE ? 'On a real site, the customer gets a personal reply by email within a minute. This sample sends nothing.' : 'On the live site, a personal reply lands in this inbox within a minute. (The preview reply is being switched on.)')}}
document.getElementById('okname').textContent=first?', '+first:'';f.hidden=true;ok.classList.add('show');ok.focus()});
f.email.addEventListener('input',()=>f.email.setCustomValidity(''));
document.getElementById('again').onclick=()=>{f.reset();f.hidden=false;ok.classList.remove('show');f.querySelector('input').focus()}}
const slots=[...document.querySelectorAll('.slots button')];let pick=null;
slots.forEach(s=>s.onclick=()=>{slots.forEach(x=>x.setAttribute('aria-pressed','false'));s.setAttribute('aria-pressed','true');pick=s.textContent});
const bb=document.getElementById('bookbtn');if(bb)bb.onclick=()=>{document.getElementById('bookmsg').textContent=pick?'Booked for '+pick+'. On the live site this goes on the calendar and the customer gets a confirmation and a reminder.':'Pick a time first.'};
})();
`;
  const scriptHash = crypto.createHash('sha256').update(script).digest('base64');
  const csp = [
    "default-src 'none'", "img-src 'self' https:", `style-src 'self' 'unsafe-inline'${fontsHref ? ' https://fonts.googleapis.com' : ''}`, `script-src 'sha256-${scriptHash}'`,
    ...(fontsHref ? ['font-src https://fonts.gstatic.com'] : []),
    `connect-src ${LEAD_URL ? new URL(LEAD_URL).origin : "'none'"}`, "base-uri 'none'", "form-action 'none'",
  ].join('; ');

  const html = `<!doctype html>
<html lang="en" class="${logoClass}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="format-detection" content="telephone=no">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${C.toHex(tokens.light.band)}">
${logo ? '<link rel="icon" href="logo.png">\n' : ''}<title>${esc(name)} (${SAMPLE ? 'sample design' : 'preview'} by Bookcliff Web)</title>
<meta name="description" content="${SAMPLE ? `A sample website by Bookcliff Web. ${esc(name)} is a made-up business.` : `A preview website built by Bookcliff Web for ${esc(name)}. Not the official site.`}">
${fontsHref ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${esc(fontsHref)}">\n` : ''}<style>${css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="top">
<div class="pv" role="note"><div class="wrap"><span>${SAMPLE ? `<b>Sample design</b> by Bookcliff Web. ${esc(name)} is a made-up business.` : `<b>Preview</b> by Bookcliff Web. Not ${esc(name)}'s official site. Expires ${expires}.`}</span><span class="pv-more">Hidden from Google · <a href="https://bookcliffweb.com" rel="noopener">bookcliffweb.com</a></span></div></div>
<header class="site"><div class="wrap"><a class="brand" href="#top">${brandHtml}</a>
<nav class="main" aria-label="Main">${nav}</nav>${callSmall}</div></header>
</div>
<main id="main">
<div id="top"></div>
${heroHtml}
${trustHtml}
<section id="services" class="sec" aria-labelledby="services-h"><div class="wrap">
<div class="sec-head" data-reveal>${ownServices
    ? `<p class="kicker">Services</p><h2 id="services-h">${esc(T.headline(name, town))}</h2><p class="lead">What ${esc(name)} offers, from their own website.</p>`
    : `<p class="kicker">Services <span class="tag">sample</span></p><h2 id="services-h">${esc(T.headline(name, town))}</h2><p class="lead">Typical ${esc(T.noun)} services. On the real site, these are ${esc(name)}'s own, in their own words.</p>`}</div>
<ul class="svc">${services}</ul></div></section>
${galleryHtml}
${aboutHtml}
${hoursHtml}
<section id="book" class="sec${hours.length ? '' : ' sec-tint'}" aria-labelledby="book-h"><div class="wrap grid2">
<div data-reveal><p class="kicker">Book online <span class="tag">demo</span></p><h2 id="book-h">Pick a time in a few taps</h2><p class="lead">Customers choose a time without a phone call. It lands on your calendar with a reminder for them.</p><ol class="steps">${steps}</ol></div>
<div class="card" id="bookcard" data-reveal><strong>Pick a time</strong> <span class="tag">demo</span><div class="slots" role="group" aria-label="Sample times">
<button type="button" aria-pressed="false">Mon 9:00</button><button type="button" aria-pressed="false">Mon 1:00</button><button type="button" aria-pressed="false">Tue 10:30</button><button type="button" aria-pressed="false">Wed 8:00</button><button type="button" aria-pressed="false">Thu 2:00</button><button type="button" aria-pressed="false">Fri 11:00</button></div>
<button class="btn btn-main full" id="bookbtn" type="button">Confirm time</button><p class="fine" id="bookmsg" role="status"></p></div>
</div></section>
<section id="contact" class="sec${hours.length ? ' sec-tint' : ''}" aria-labelledby="contact-h"><div class="wrap grid2">
<div data-reveal><p class="kicker">Contact</p><h2 id="contact-h">${esc(T.cta)}</h2><p class="lead">Send a message and get a personal reply by email within a minute, any time of day.</p>
${SAMPLE ? '' : `<p class="fine">Try it with your own email address: that's the reply your customers would get.</p>`}</div>
<div class="card" data-reveal><form id="lead" novalidate>
<label for="f-name">Your name</label><input id="f-name" name="name" autocomplete="name" required>
<label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" required>
<label for="f-phone">Phone (optional)</label><input id="f-phone" name="phone" type="tel" autocomplete="tel">
<label for="f-service">What do you need?</label><select id="f-service" name="service">${options}<option>Something else</option></select>
<label for="f-msg">Details</label><textarea id="f-msg" name="message" rows="4"></textarea>
<input class="hp" tabindex="-1" autocomplete="off" name="_gotcha" aria-hidden="true">
<button class="btn btn-main full" type="submit">Send</button>
<p class="fine">${SAMPLE ? 'Sample form: nothing you type is sent or saved.' : 'Preview form: your email gets one sample reply from Bookcliff Web and is not saved to any list.'}</p>
</form><div class="ok" id="ok" tabindex="-1" role="status"><h3>Thanks<span id="okname"></span>!</h3><p id="okmsg"></p><button class="btn btn-ghost" id="again" type="button">Send another</button></div></div>
</div></section>
</main>
<footer class="foot"><div class="wrap foot-grid">
<div><p class="foot-name">${esc(name)}</p><p>${esc(town)}, Colorado${phone ? ` · <a href="${esc(telHref(phone))}">${esc(phone)}</a>` : ''}</p>${socialHtml ? `<div class="socials">${socialHtml}</div>` : ''}
${places?.mapsUri ? `<p class="fine"><a href="${esc(places.mapsUri)}" rel="noopener">Their listing on ${googleMark}</a></p>` : ''}</div>
${SAMPLE
    ? `<div><h2>About this sample</h2><p>A sample design built by <a href="https://bookcliffweb.com" rel="noopener">Bookcliff Web</a> to show what we make. ${esc(name)} is a made-up business, and this page is hidden from Google.</p>
<p>Want a site like this for your business? <a href="${BOOKCLIFF_CAL}" rel="noopener">Book a free 15-minute call</a>.</p></div>${creditsHtml}`
    : `<div><h2>About this preview</h2><p>A preview built ${built} by <a href="https://bookcliffweb.com" rel="noopener">Bookcliff Web</a>. It is not ${esc(name)}'s official site, it is hidden from Google, and it expires ${expires}.</p>
<p>Want this site for real? <a href="${BOOKCLIFF_CAL}" rel="noopener">Book a free 15-minute call</a>.</p></div>`}
</div></footer>
<script>${script}</script>
</body>
</html>
`;

  // ---------- a multi-page site for prospects (D-063) ----------
  // Shaped by the kind of business: home, services (a page per real service), the trade's own pages (service area and
  // projects for builders, menu and photos for food, booking for salons), gallery, about and contact. One stylesheet;
  // the same banner, noindex and CSP on every page. Samples stay one page.
  let pages = null;
  if (!SAMPLE) {
    const more = site ? (await attempt('their other pages', () => readPages(site, { budget, services: serviceList.map(([h]) => h) }))) || {} : {};
    const KIND = ['construction', 'hauling', 'landscaping'].includes(tradeKey) ? 'build' : tradeKey === 'food' ? 'food' : ['salon', 'health'].includes(tradeKey) ? 'book' : 'general';
    const slugify = (t) => String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'service';
    const real = ownServices ? serviceList.map(([h, , ph]) => ({ name: h, slug: slugify(h), photo: ph, text: more.services?.[h] || '' })) : [];
    const contactName = KIND === 'build' ? 'Free estimate' : KIND === 'book' ? 'Book' : KIND === 'food' ? 'Visit & contact' : 'Contact';
    const allPhotos = [...new Set([...rest, ...photoServices, ...(teamPhoto ? [teamPhoto] : []), ...(heroes.length > 1 ? heroes.slice(1) : [])])];
    const hasGallery = allPhotos.length >= 3;
    const galleryName = KIND === 'build' ? 'Projects' : KIND === 'food' ? 'Photos' : 'Gallery';
    const navItems = [['index.html', 'Home'], ['services.html', KIND === 'food' ? 'Menu & more' : 'Services'],
      ...(KIND === 'build' ? [['service-area.html', 'Service area']] : []), ...(hasGallery ? [['gallery.html', galleryName]] : []),
      ['about.html', 'About'], ['contact.html', contactName]];
    const navFor = (pre, here) => navItems.map(([href, t]) => `<a href="${pre}${href}"${href === here ? ' aria-current="page"' : ''}>${esc(t)}</a>`).join('');
    const sample = '<span class="tag">sample</span>';
    const pageHead = (kicker, title, lead) => `<section class="page-hero"><div class="wrap"><p class="eyebrow">${kicker}</p><h1 id="h1">${title}</h1>${lead ? `<p class="hero-sub">${lead}</p>` : ''}</div>${ART.ridge()}</section>`;
    const ctaBand = (pre) => `<section class="cta-band"><div class="wrap cta-inner" data-reveal><div><h2>${esc(T.cta)}</h2><p>${phone ? `Call <a href="${esc(telHref(phone))}">${esc(phone)}</a>, or send` : 'Send'} a message and get a reply fast.</p></div><a class="btn btn-main" href="${pre}contact.html">${esc(contactName)}${icon('arrow')}</a></div></section>`;
    const card = (s, pre, i) => `<li data-reveal${s.photo ? ' class="svc-photo"' : ''}><a class="card-link" href="${pre}services/${s.slug}.html">${s.photo ? `<figure>${img(s.photo, i + 1, { sizes: '(min-width: 760px) 30vw, 100vw', lazy: true }).replace(/ alt="[^"]*"/, ' alt=""')}</figure>` : `<span class="num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>`}<h3>${esc(s.name)}</h3><span class="more">Learn more${icon('arrow')}</span></a></li>`;
    const serviceCards = (pre) => real.length ? real.map((s, i) => card(s, pre, i)).join('') : services;
    const footerHtml = html.slice(html.indexOf('<footer class="foot">'), html.indexOf('</footer>') + 9);
    const contactSections = html.slice(html.indexOf('<section id="book"'), html.indexOf('</main>'));
    const aboutWords = more.about || description;
    const aboutFrom = more.about ? 'In their words, from their website' : description ? (descriptionFrom === 'google' ? `Summary from ${googleMark}` : descriptionFrom === 'lookup' ? 'From a look at their website and listings' : `In their words, from ${esc(siteHost)}`) : '';
    const v = nameHash >>> 2;
    const variantClass = `r-${['soft', 'sharp', 'round'][v % 3]} hdr-${(v >> 2) % 2 ? 'brand' : 'light'} cards-${(v >> 3) % 2 ? 'line' : 'lift'}`;
    const page = (title, main, here, pre = '') => html
      .replace(/<html lang="en" class="[^"]*">/, `<html lang="en" class="${logoClass} ${variantClass}">`)
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)} · ${esc(name)} (preview by Bookcliff Web)</title>`)
      .replace(/<link rel="icon" href="logo\.png">/, `<link rel="icon" href="${pre}logo.png">`)
      .replace(/<style>[\s\S]*?<\/style>/, `<link rel="stylesheet" href="${pre}css/style.css">`)
      .replace(/<a class="brand" href="#top">([\s\S]*?)<\/a>\n<nav class="main" aria-label="Main">[\s\S]*?<\/nav>/, (m, brand) =>
        `<a class="brand" href="${pre}index.html">${brand.replace('src="logo.png"', `src="${pre}logo.png"`)}</a>\n<nav class="main" aria-label="Main">${navFor(pre, here)}</nav>`)
      .replace('</div></header>', `</div><nav class="mnav" aria-label="Pages">${navFor(pre, here)}</nav></header>`)
      .replace(/<main id="main">[\s\S]*<\/main>/, () => `<main id="main">\n${main}\n</main>`)
      .replace(/<footer class="foot">[\s\S]*?<\/footer>/, () => footerHtml);
    const home = `${heroHtml.replace(/href="#contact"/g, 'href="contact.html"')}
${trustHtml}
<section class="sec" aria-labelledby="services-h"><div class="wrap">
<div class="sec-head" data-reveal>${real.length ? `<p class="kicker">Services</p><h2 id="services-h">${esc(T.headline(name, town))}</h2><p class="lead">What ${esc(name)} offers, from their own website.</p>`
  : `<p class="kicker">Services ${sample}</p><h2 id="services-h">${esc(T.headline(name, town))}</h2><p class="lead">Typical ${esc(T.noun)} services. On the real site, these are ${esc(name)}'s own.</p>`}</div>
<ul class="svc">${serviceCards('')}</ul>${real.length ? '' : '<p class="fine"><a href="services.html">All services</a></p>'}</div></section>
<section class="sec sec-tint" aria-labelledby="about-h"><div class="wrap about${aboutPhoto ? ' has-photo' : ' has-art'}">
<div data-reveal><p class="kicker">About</p><h2 id="about-h">About ${esc(name)}</h2>${aboutWords ? `<p class="about-text">${esc(aboutWords.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '))}</p>` : `<p class="about-text">The story of ${esc(name)} goes here: how it started and who does the work. ${sample}</p>`}<p><a class="btn btn-ghost" href="about.html">More about us${icon('arrow')}</a></p></div>
${aboutPhoto ? `<figure class="about-photo" data-photo data-reveal>${img(aboutPhoto, 1, { sizes: '(min-width: 760px) 45vw, 100vw', lazy: true })}</figure>` : `<div class="about-art">${ART.aboutArt(scene)}</div>`}
</div></section>
${hasGallery ? `<section class="sec" aria-labelledby="photos-h"><div class="wrap"><div class="sec-head" data-reveal><p class="kicker">${esc(galleryName)}</p><h2 id="photos-h">A look at ${esc(name)}</h2></div>
<ul class="gallery">${allPhotos.slice(0, 3).map((p, i) => fig(p, i, '(min-width: 760px) 34vw, 50vw')).join('')}</ul><p class="fine"><a href="gallery.html">See all ${esc(galleryName.toLowerCase())}</a></p></div></section>` : ''}
${ctaBand('')}`;
    pages = { 'index.html': page('Home', home, 'index.html') };
    pages['services.html'] = page('Services', `${pageHead('Services', esc(T.headline(name, town)), real.length ? `What ${esc(name)} offers, from their own website.` : `Typical ${esc(T.noun)} services ${sample}`)}
<section class="sec"><div class="wrap">${KIND === 'food' && more.menuUrl ? `<p data-reveal><a class="btn btn-main" href="${esc(more.menuUrl)}" rel="noopener">See their current menu${icon('arrow')}</a></p>` : ''}<ul class="svc">${serviceCards('')}</ul></div></section>
${ctaBand('')}`, 'services.html');
    for (const s of real) {
      const others = real.filter((o) => o !== s).map((o) => `<li><a href="${o.slug}.html">${esc(o.name)}</a></li>`).join('');
      pages[`services/${s.slug}.html`] = page(s.name, `${pageHead(`Services · ${esc(town)}`, esc(s.name), '')}
<section class="sec"><div class="wrap svc-detail${s.photo ? ' has-photo' : ''}">
<div data-reveal>${s.text ? `<p class="about-text">${esc(s.text)}</p><p class="src">In their words, from their website</p>` : `<p class="about-text">${esc(s.name)} from ${esc(name)} in ${esc(town)}, Colorado. On the real site, this page explains how they handle it, in their own words. ${sample}</p>`}
<p><a class="btn btn-main" href="../contact.html">${esc(contactName)}${icon('arrow')}</a></p>${others ? `<h2 class="small-h">Other services</h2><ul class="links">${others}</ul>` : ''}</div>
${s.photo ? `<figure class="split-photo" data-photo data-reveal>${img(s.photo, 1, { sizes: '(min-width: 900px) 46vw, 100vw', lazy: false }).replace(/ alt="[^"]*"/, ` alt="${esc(s.name)}"`)}</figure>` : ''}
</div></section>
${ctaBand('../')}`, 'services.html', '../');
    }
    if (KIND === 'build') {
      const towns = ['Grand Junction', 'Fruita', 'Palisade', 'Clifton', 'Orchard Mesa', 'Redlands', 'Whitewater', 'Loma', 'Mack'];
      pages['service-area.html'] = page('Service area', `${pageHead('Service area', `Serving ${esc(town)} and the Grand Valley`, `Typical service area ${sample} On the real site, these are the towns ${esc(name)} covers.`)}
<section class="sec"><div class="wrap"><ul class="towns">${[town, ...towns.filter((t) => t !== town)].map((t) => `<li data-reveal>${icon('pin')}${esc(t)}</li>`).join('')}</ul></div></section>
${ctaBand('')}`, 'service-area.html');
    }
    if (hasGallery) {
      pages['gallery.html'] = page(galleryName, `${pageHead(esc(galleryName), `A look at ${esc(name)}`, `Photos from ${esc(name)}'s own website.`)}
<section class="sec"><div class="wrap"><ul class="gallery">${allPhotos.map((p, i) => fig(p, i, '(min-width: 760px) 34vw, 50vw')).join('')}</ul></div></section>
${ctaBand('')}`, 'gallery.html');
    }
    pages['about.html'] = page('About', `${pageHead('About', `About ${esc(name)}`, '')}
<section class="sec"><div class="wrap about${aboutPhoto ? ' has-photo' : ' has-art'}">
<div data-reveal>${aboutWords ? `<p class="about-text">${esc(aboutWords)}</p><p class="src">${aboutFrom}</p>` : `<p class="about-text">This is where ${esc(name)}'s story goes: how it started, who does the work and what makes it different. ${sample}</p>`}${socialHtml ? `<div class="socials">${socialHtml}</div>` : ''}</div>
${aboutPhoto ? `<figure class="about-photo" data-photo data-reveal>${img(aboutPhoto, 1, { sizes: '(min-width: 760px) 45vw, 100vw', lazy: false })}</figure>` : `<div class="about-art">${ART.aboutArt(scene)}</div>`}
</div></section>
${hoursHtml}
${ctaBand('')}`, 'about.html');
    pages['contact.html'] = page(contactName, `${pageHead(esc(contactName), esc(T.cta), 'Send a message and get a personal reply by email within a minute, any time of day.')}
${KIND === 'book' ? contactSections : contactSections.replace(/<section id="book"[\s\S]*?<\/section>\n?/, (m) => '').concat(contactSections.match(/<section id="book"[\s\S]*?<\/section>/)?.[0] || '')}`, 'contact.html');
  }

  fs.mkdirSync(path.join(outDir, slug), { recursive: true });
  if (pages) {
    fs.mkdirSync(path.join(outDir, slug, 'css'), { recursive: true });
    fs.writeFileSync(path.join(outDir, slug, 'css', 'style.css'), css.trim() + '\n');
    for (const [file, body] of Object.entries(pages)) {
      fs.mkdirSync(path.dirname(path.join(outDir, slug, file)), { recursive: true });
      fs.writeFileSync(path.join(outDir, slug, file), body);
    }
  } else {
    fs.writeFileSync(path.join(outDir, slug, 'index.html'), html);
  }
  if (sp.length) {
    fs.mkdirSync(path.join(outDir, slug, 'img'), { recursive: true });
    for (const file of sp.flatMap((p) => p.files)) fs.copyFileSync(file, path.join(outDir, slug, 'img', path.basename(file)));
  }
  if (logo) fs.writeFileSync(path.join(outDir, slug, 'logo.png'), logo.png);
  if (SAMPLE) {
    console.log(JSON.stringify({ slug, business: name, trade: tradeKey, town, sample: true, file: path.join(outDir, slug, 'index.html') }));
    return;
  }
  fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  const listPath = path.join(outDir, 'previews.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter((p) => p.slug !== slug);
  // --request: the portal's request ID, so the portal can find this preview's link once it's built.
  const request = opt('--request', '');
  list.push({ slug, business: name, trade: tradeKey, town, built, expires, ...(/^[\w-]{1,64}$/.test(request) ? { request } : {}) });
  fs.writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');
  const sourcesUsed = {
    places: Boolean(places), site: Boolean(site), logo: logo ? logo.from : null, photos: photos.length,
    palette: paletteFrom, phone: phoneArg ? 'given' : places?.phone ? 'google' : site?.phone ? 'site' : 'sample',
  };
  console.log(JSON.stringify({ slug, business: name, trade: tradeKey, town, expires, file: path.join(outDir, slug, 'index.html'), sources: sourcesUsed }));
}

main().catch((err) => {
  console.error(`[preview] build failed: ${err?.stack || err}`);
  process.exit(1);
});
