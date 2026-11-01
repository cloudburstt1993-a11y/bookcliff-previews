# Bookcliff Web previews

Sample websites that Bookcliff Web builds for a prospect an owner picks, so the prospect can see what theirs
could look like (HQ decision D-035). Published with GitHub Pages at an unguessable folder name, hidden from
search engines (`noindex` and `robots.txt`), and deleted 14 days after they're built.

- **Build one:** the "Make a preview site" button in the Bookcliff Portal, or Actions → "Build a preview" →
  Run workflow. `tools/build-preview.js` makes the page; `previews.json` lists what's live (the portal and the
  n8n preview reply read it).
- **Clean-up:** "Expire old previews" runs every morning (`tools/expire.js`).
- **Rules:** every page says "Preview by Bookcliff Web. Not <business>'s official site." Since HQ D-044 a preview
  uses the business's own logo, photos, colors and details from its own website and the links an owner gives
  (photos hotlinked, never copied; the logo saved for its colors). Nothing from Google's listing is saved into a
  page (Google's terms), Facebook and Instagram are linked, never read. No reviews, ratings, prices, licenses or
  claims; services are marked samples; the phone is a marked sample unless the business publishes one.
- **Builder packages:** `tools/package.json` (sharp, for logo colors); the workflow runs `npm ci` in `tools/`.
- **Source of truth:** `ops/previews/` in the private HQ repo. Copy changes from there to `tools/`.

Nothing else belongs in this repo: it's public.
