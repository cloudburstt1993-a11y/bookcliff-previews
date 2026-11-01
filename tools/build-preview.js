// Preview-site generator (D-035). Builds a one-page, phone-first mock website for a prospect so the
// owners can show "this is what yours could look like" with a working form, tap-to-call and a booking
// flow. Deterministic: no AI call, no network. Output is static HTML for the public previews repo.
//
// Usage:
//   node ops/previews/build-preview.js --name "Naturally Spotless Cleaning LLC" --town Clifton \
//        [--trade cleaning] [--phone "(970) 555-0100"] [--days 14] [--out ../bookcliff-previews]
//
// What it writes into --out (default ./previews-out):
//   <slug>-<code>/index.html   the preview (unguessable folder name)
//   previews.json              active previews: slug, business, built, expires (read by n8n's preview
//                              reply to decide which business name it may use; expired ones are refused)
//   robots.txt                 disallow everything
// Rules it enforces: "Preview by Bookcliff Web" banner on every screen, noindex, no reviews, ratings,
// photos, prices, licenses or claims, services labelled as samples, expiry date shown.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TRADES = require('./trades');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const rawName = opt('--name');
if (!rawName) { console.error('Usage: --name "Business LLC" --town Town [--trade key] [--phone ...] [--days 14] [--out dir]'); process.exit(1); }
const town = opt('--town', 'Grand Junction');
const phone = opt('--phone', '');
const days = parseInt(opt('--days', '14'), 10) || 14;
const outDir = path.resolve(opt('--out', 'previews-out'));
// The live lead-reply endpoint for previews; empty until the n8n preview reply is deployed (OQ-050).
const LEAD_URL = opt('--lead-url', process.env.PREVIEW_LEAD_URL || '');
const BOOKCLIFF_CAL = 'https://cal.com/cloudburstt/15min';

const name = rawName.replace(/,?\s*\b(L\.?L\.?C|Inc\.?|Incorporated|Corp\.?|Co\.)\s*$/i, '').replace(/\s+/g, ' ').trim();
const tradeKey = opt('--trade') || Object.keys(TRADES).find((k) => k !== 'general' && TRADES[k].match.test(rawName)) || 'general';
const T = TRADES[tradeKey];
if (!T) { console.error(`Unknown trade "${tradeKey}". Use one of: ${Object.keys(TRADES).join(', ')}`); process.exit(1); }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugBase = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const code = crypto.randomBytes(3).toString('hex');
const slug = `${slugBase}-${code}`;
const today = new Date();
const expires = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
const built = today.toISOString().slice(0, 10);
const tel = phone.replace(/[^\d+]/g, '');
const phoneHtml = phone
  ? `<a class="btn btn-ghost" href="tel:${esc(tel.startsWith('+') ? tel : '+1' + tel)}">Call ${esc(phone)}</a>`
  : `<span class="btn btn-ghost is-sample" title="Your number goes here">Call (970) 000-0000 <small>sample</small></span>`;
const initials = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const services = T.services.map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`).join('');
const options = T.services.map(([h]) => `<option>${esc(h)}</option>`).join('');
const steps = T.steps.map((s, i) => `<li><span>${i + 1}</span>${esc(s)}</li>`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(name)} (preview by Bookcliff Web)</title>
<meta name="description" content="A preview website built by Bookcliff Web for ${esc(name)}. Not the official site.">
<style>
:root{--a:${T.accent};--ad:${T.accentDark};--tint:${T.tint};--ink:#18212b;--muted:#5b6672;--line:#e3e7ec;--bg:#fff}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55}
a{color:var(--ad)}.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.pv{position:sticky;top:0;z-index:20;background:#14202E;color:#fff;font-size:13px;padding:8px 0}
.pv .wrap{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.pv b{color:#E8833A}.pv a{color:#fff}
header.top{border-bottom:1px solid var(--line);background:#fff}header.top .wrap{display:flex;align-items:center;justify-content:space-between;height:68px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:var(--ink);text-decoration:none}
.mark{width:38px;height:38px;border-radius:10px;background:var(--a);color:#fff;display:grid;place-items:center;font-size:15px;letter-spacing:.5px}
nav a{margin-left:18px;color:var(--muted);text-decoration:none;font-size:15px}nav a:hover{color:var(--ink)}
.hero{background:linear-gradient(160deg,var(--tint),#fff 70%);padding:64px 0 56px}
.hero h1{font-size:clamp(30px,5vw,48px);line-height:1.1;margin:0 0 14px;max-width:16ch}.hero p{font-size:18px;color:var(--muted);max-width:52ch;margin:0 0 26px}
.btns{display:flex;gap:12px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;gap:8px;padding:14px 20px;border-radius:12px;font-weight:700;text-decoration:none;border:2px solid var(--a);cursor:pointer;font-size:16px}
.btn-main{background:var(--a);color:#fff}.btn-main:hover{background:var(--ad);border-color:var(--ad)}.btn-ghost{background:#fff;color:var(--ad)}
.is-sample small,.tag{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:#fff3e6;color:#9a4a0c;border-radius:6px;padding:2px 6px}
.chips{display:flex;gap:18px;flex-wrap:wrap;margin-top:28px;color:var(--muted);font-size:14px}.chips span::before{content:"✓ ";color:var(--a);font-weight:800}
section{padding:60px 0}h2{font-size:clamp(24px,3.4vw,32px);margin:0 0 8px}.lead{color:var(--muted);margin:0 0 28px}
.svc{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.svc li{border:1px solid var(--line);border-radius:14px;padding:20px;background:#fff}.svc h3{margin:0 0 6px;font-size:18px}.svc p{margin:0;color:var(--muted);font-size:15px}
.band{background:var(--tint)}.steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.steps li{background:#fff;border-radius:14px;padding:20px;font-weight:700;display:flex;gap:12px;align-items:center}.steps span{flex:none;width:34px;height:34px;border-radius:50%;background:var(--a);color:#fff;display:grid;place-items:center}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:28px}@media(max-width:760px){.grid2{grid-template-columns:1fr}nav{display:none}}
.card{border:1px solid var(--line);border-radius:16px;padding:24px;background:#fff}
.empty{border:2px dashed var(--line);border-radius:14px;padding:22px;color:var(--muted);text-align:center}
form label{display:block;font-weight:600;font-size:14px;margin:12px 0 6px}form input,form select,form textarea{width:100%;padding:12px;border:1px solid #cfd6dd;border-radius:10px;font:inherit}
form button{margin-top:16px;width:100%}.hp{position:absolute;left:-9999px}.fine{font-size:12px;color:var(--muted);margin-top:10px}
.ok{display:none;text-align:center;padding:30px 10px}.ok.show{display:block}.ok h3{margin:0 0 8px;font-size:22px}
.slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}.slots button{padding:10px;border:1px solid #cfd6dd;border-radius:10px;background:#fff;font:inherit;cursor:pointer}
.slots button[aria-pressed=true]{background:var(--a);color:#fff;border-color:var(--a)}
footer{border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:14px}
.callbar{position:fixed;left:0;right:0;bottom:0;display:none;gap:8px;padding:10px;background:#fff;border-top:1px solid var(--line);z-index:15}.callbar .btn{flex:1;justify-content:center;padding:12px}
@media(max-width:760px){.callbar{display:flex}body{padding-bottom:70px}}
</style>
</head>
<body>
<div class="pv" role="note"><div class="wrap"><span><b>Preview</b> by Bookcliff Web. Not ${esc(name)}'s official site.</span><span>Hidden from Google · expires ${expires} · <a href="https://bookcliffweb.com" rel="noopener">bookcliffweb.com</a></span></div></div>
<header class="top"><div class="wrap"><a class="brand" href="#top"><span class="mark" aria-hidden="true">${esc(initials)}</span>${esc(name)}</a>
<nav aria-label="Main"><a href="#services">Services</a><a href="#how">How it works</a><a href="#book">Book</a><a href="#contact">Contact</a></nav></div></header>
<main id="top">
<section class="hero"><div class="wrap">
<h1>${esc(T.headline(name, town))}</h1><p>${esc(T.sub)}</p>
<div class="btns"><a class="btn btn-main" href="#contact">${esc(T.cta)}</a>${phoneHtml}</div>
<div class="chips"><span>Locally owned in ${esc(town)}</span><span>Fast replies</span><span>Easy online booking</span></div>
</div></section>
<section id="services"><div class="wrap"><h2>Services <span class="tag">sample</span></h2><p class="lead">Typical ${esc(T.noun)} services. On the real site, these are ${esc(name)}'s own, in their own words.</p><ul class="svc">${services}</ul></div></section>
<section id="how" class="band"><div class="wrap"><h2>How it works</h2><p class="lead">Three simple steps.</p><ol class="steps">${steps}</ol></div></section>
<section id="reviews"><div class="wrap grid2">
<div><h2>What customers say</h2><p class="lead">Real Google reviews show here once customers leave them. A simple request after each job is how most local businesses get their first 20.</p></div>
<div class="empty">Your Google reviews will appear here.<br><small>We never write or invent reviews.</small></div>
</div></section>
<section id="book" class="band"><div class="wrap grid2">
<div><h2>Book online</h2><p class="lead">Customers pick a time without a phone call. It lands on your calendar with a reminder for them.</p></div>
<div class="card" id="bookcard"><strong>Pick a time</strong> <span class="tag">demo</span><div class="slots" role="group" aria-label="Sample times">
<button type="button">Mon 9:00</button><button type="button">Mon 1:00</button><button type="button">Tue 10:30</button><button type="button">Wed 8:00</button><button type="button">Thu 2:00</button><button type="button">Fri 11:00</button></div>
<button class="btn btn-main" id="bookbtn" type="button" style="width:100%">Confirm time</button><p class="fine" id="bookmsg" role="status"></p></div>
</div></section>
<section id="contact"><div class="wrap grid2">
<div><h2>${esc(T.cta)}</h2><p class="lead">Send a message and get a personal reply by email within a minute, any time of day.</p>
<p class="fine">Try it with your own email address: that's the reply your customers would get.</p></div>
<div class="card"><form id="lead" novalidate>
<label for="f-name">Your name</label><input id="f-name" name="name" autocomplete="name" required>
<label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" required>
<label for="f-phone">Phone (optional)</label><input id="f-phone" name="phone" type="tel" autocomplete="tel">
<label for="f-service">What do you need?</label><select id="f-service" name="service">${options}<option>Something else</option></select>
<label for="f-msg">Details</label><textarea id="f-msg" name="message" rows="4"></textarea>
<input class="hp" tabindex="-1" autocomplete="off" name="_gotcha" aria-hidden="true">
<button class="btn btn-main" type="submit">Send</button>
<p class="fine">Preview form: your email gets one sample reply from Bookcliff Web and is not saved to any list.</p>
</form><div class="ok" id="ok" tabindex="-1" role="status"><h3>Thanks<span id="okname"></span>!</h3><p id="okmsg"></p><button class="btn btn-ghost" id="again" type="button">Send another</button></div></div>
</div></section>
</main>
<footer><div class="wrap">${esc(name)} · ${esc(town)}, Colorado · preview built ${built} by <a href="https://bookcliffweb.com" rel="noopener">Bookcliff Web</a>. Want this site for real? <a href="${BOOKCLIFF_CAL}" rel="noopener">Book a free 15-minute call</a>.</div></footer>
<div class="callbar">${phone ? `<a class="btn btn-ghost" href="tel:${esc(tel.startsWith('+') ? tel : '+1' + tel)}">Call</a>` : '<span class="btn btn-ghost is-sample">Call</span>'}<a class="btn btn-main" href="#contact">Message us</a></div>
<script>
(()=>{const LEAD=${JSON.stringify(LEAD_URL)},SLUG=${JSON.stringify(slug)};
const f=document.getElementById('lead'),ok=document.getElementById('ok');
f.addEventListener('submit',e=>{e.preventDefault();const d=new FormData(f),em=String(d.get('email')||'').trim();
if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)){f.email.focus();f.email.setCustomValidity('Enter an email address');f.email.reportValidity();return}f.email.setCustomValidity('');
const first=String(d.get('name')||'').trim().split(/\\s+/)[0];
if(LEAD){const b=new URLSearchParams();['name','email','phone','service','message','_gotcha'].forEach(k=>{const v=d.get(k);if(v)b.append(k,String(v).slice(0,1000))});b.append('preview',SLUG);b.append('page',location.pathname);
fetch(LEAD,{method:'POST',mode:'no-cors',body:b}).catch(()=>{});
document.getElementById('okmsg').textContent='Check your inbox: a personal reply is on its way, usually in under a minute.'}
else{document.getElementById('okmsg').textContent='On the live site, a personal reply lands in this inbox within a minute. (The preview reply is being switched on.)'}
document.getElementById('okname').textContent=first?', '+first:'';f.hidden=true;ok.classList.add('show');ok.focus()});
document.getElementById('again').onclick=()=>{f.reset();f.hidden=false;ok.classList.remove('show')};
const slots=[...document.querySelectorAll('.slots button')];let pick=null;
slots.forEach(s=>s.onclick=()=>{slots.forEach(x=>x.setAttribute('aria-pressed','false'));s.setAttribute('aria-pressed','true');pick=s.textContent});
document.getElementById('bookbtn').onclick=()=>{document.getElementById('bookmsg').textContent=pick?'Booked for '+pick+'. On the live site this goes on the calendar and the customer gets a confirmation and a reminder.':'Pick a time first.'};
})();
</script>
</body>
</html>
`;

fs.mkdirSync(path.join(outDir, slug), { recursive: true });
fs.writeFileSync(path.join(outDir, slug, 'index.html'), html);
fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
const listPath = path.join(outDir, 'previews.json');
let list = [];
try { list = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch { list = []; }
list = list.filter((p) => p.slug !== slug);
// --request: the portal's request ID, so the portal can find this preview's link once it's built.
const request = opt('--request', '');
list.push({ slug, business: name, trade: tradeKey, town, built, expires, ...(/^[\w-]{1,64}$/.test(request) ? { request } : {}) });
fs.writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');
console.log(JSON.stringify({ slug, business: name, trade: tradeKey, town, expires, file: path.join(outDir, slug, 'index.html') }));
