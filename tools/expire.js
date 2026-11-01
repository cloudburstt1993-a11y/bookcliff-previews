// Removes previews whose expiry date has passed: their folder and their previews.json entry (D-035).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const listPath = path.join(root, 'previews.json');
const today = new Date().toISOString().slice(0, 10);
let list = [];
try { list = JSON.parse(fs.readFileSync(listPath, 'utf8')); } catch { list = []; }

const keep = [];
for (const p of list) {
  const safe = typeof p.slug === 'string' && /^[a-z0-9-]{3,60}$/.test(p.slug);
  if (safe && p.expires >= today) { keep.push(p); continue; }
  if (safe) fs.rmSync(path.join(root, p.slug), { recursive: true, force: true });
  console.log(`expired: ${p.slug} (${p.business}, ${p.expires})`);
}
fs.writeFileSync(listPath, JSON.stringify(keep, null, 2) + '\n');
console.log(`${keep.length} preview(s) still live`);
