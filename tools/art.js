// Original illustrations for preview and sample sites (D-051). Drawn here as plain SVG, so there is no stock
// photo, licence or outside request. Used only when a page has no photo of the business's own: the hero
// scene sits beside the headline, and a smaller vignette fills the About section. Colours come from the
// page's own tokens through class names (see the .art and .vig rules in build-preview.js), so every scene
// takes on the business's palette. Decorative only: every SVG is aria-hidden and carries no words.

// Which scene each trade gets.
const SCENE_FOR_TRADE = { construction: 'build', hauling: 'build', food: 'kitchen' };
const sceneFor = (tradeKey) => SCENE_FOR_TRADE[tradeKey] || 'store';

const svg = (viewBox, body, cls) => `<svg class="${cls}" viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;

// Far mesas, the ground, and a few stars: shared backdrop for the outdoor scenes.
const BACKDROP = `<path class="far" d="M0 300V232l58-8 22-18h100l20 12h30l20-18h110l20 14h30l20-18h50v124z"/>
<path class="near" d="M0 400V322c110-22 290-22 480-8v86z"/>
<path class="spark" d="M56 96l3 9 9 3-9 3-3 9-3-9-9-3 9-3zM438 214l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM214 70l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>`;

const HERO = {
  // A finished house, its addition still in framing, a crane lifting a beam, and a ladder.
  build: `<circle class="sun" cx="350" cy="116" r="64"/>${BACKDROP}
<g class="line thin"><path d="M428 330V70M440 330V70"/><path d="M428 330l12-26-12-26 12-26-12-26 12-26-12-26 12-26-12-26 12-26"/></g>
<path class="line" d="M300 72h176"/><rect class="brand" x="428" y="60" width="26" height="18" rx="3"/><path class="line thin" d="M322 72v74"/>
<rect class="accent" x="286" y="146" width="72" height="9" rx="2"/>
<g class="line"><path d="M246 330v-78h116v78"/><path d="M236 254l68-48 68 48z"/><path d="M304 206v46M304 252l-32-23M304 252l32-23"/></g>
<path class="line thin" d="M266 252v78M286 252v78M324 252v78M344 252v78"/>
<rect class="brand" x="196" y="194" width="16" height="34"/>
<rect class="solid" x="92" y="246" width="156" height="84"/>
<path class="brand" d="M76 252l94-80 94 80z"/>
<rect class="glass" x="106" y="264" width="34" height="28" rx="3"/><rect class="glass" x="204" y="264" width="34" height="28" rx="3"/>
<rect class="brand" x="153" y="278" width="36" height="52" rx="3"/><circle class="glass" cx="181" cy="306" r="2.5"/>
<g class="line"><path d="M384 330l-30-92M400 330l-30-92"/></g><path class="line thin" d="M380 318l16 0M376 302l16 0M370 286l16 0M365 270l16 0M360 254l16 0"/>
<path class="line thin" d="M20 330h440"/>
<circle class="near" cx="60" cy="326" r="14"/><circle class="near" cx="80" cy="330" r="10"/>`,

  // Pendant lights over a table: a plated dish with steam, a glass, and a bowl of Palisade peaches.
  kitchen: `<circle class="glow" cx="240" cy="236" r="160"/>
<path class="spark" d="M56 150l3 9 9 3-9 3-3 9-3-9-9-3 9-3zM430 170l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>
<g class="beam"><path d="M122 96h36l44 196H78z"/><path d="M222 120h36l44 172H178z"/><path d="M322 96h36l44 196H278z"/></g>
<path class="line thin" d="M140 0v64M240 0v88M340 0v64"/>
<path class="brand" d="M116 96h48l-10-34h-28z"/><path class="brand" d="M216 120h48l-10-34h-28z"/><path class="brand" d="M316 96h48l-10-34h-28z"/>
<ellipse class="glass" cx="140" cy="98" rx="11" ry="4"/><ellipse class="glass" cx="240" cy="122" rx="11" ry="4"/><ellipse class="glass" cx="340" cy="98" rx="11" ry="4"/>
<rect class="solid" x="36" y="304" width="408" height="14" rx="7"/><path class="line" d="M74 318v72M406 318v72"/>
<ellipse class="plate" cx="240" cy="300" rx="80" ry="10"/>
<path class="accent" d="M182 299c4-38 112-38 116 0z"/>
<circle class="sun" cx="224" cy="274" r="6"/><circle class="sun" cx="250" cy="268" r="5"/><circle class="brand" cx="264" cy="280" r="4"/>
<path class="line thin" d="M222 252c-10-12 10-20 0-32M240 244c-10-12 10-20 0-32M258 252c-10-12 10-20 0-32"/>
<path class="sun" d="M110 254h26c-1 14-5 20-13 20s-12-6-13-20z"/><path class="line" d="M106 238h34c0 28-7 38-17 38s-17-10-17-38zM123 276v24M110 302h26"/>
<circle class="sun" cx="354" cy="270" r="14"/><circle class="sun" cx="380" cy="268" r="13"/><circle class="sun" cx="367" cy="252" r="12"/>
<path class="accent" d="M367 240c6-9 17-10 20-7-4 7-13 9-20 7z"/>
<path class="brand" d="M330 272h74c-2 22-17 32-37 32s-35-10-37-32z"/>`,

  // A shop front with a striped awning, a big window and a door: for every other trade.
  store: `<circle class="sun" cx="364" cy="108" r="60"/>${BACKDROP}
<rect class="solid" x="92" y="170" width="296" height="160" rx="6"/>
<rect class="brand" x="82" y="156" width="316" height="20" rx="6"/>
<rect class="brand" x="176" y="186" width="128" height="26" rx="13"/><rect class="glass" x="196" y="196" width="88" height="6" rx="3"/>
<path class="accent" d="M100 222h35v22a17.5 8 0 0 1-35 0zM170 222h35v22a17.5 8 0 0 1-35 0zM240 222h35v22a17.5 8 0 0 1-35 0zM310 222h35v22a17.5 8 0 0 1-35 0z"/>
<path class="awning" d="M135 222h35v22a17.5 8 0 0 1-35 0zM205 222h35v22a17.5 8 0 0 1-35 0zM275 222h35v22a17.5 8 0 0 1-35 0zM345 222h35v22a17.5 8 0 0 1-35 0z"/>
<rect class="glass" x="112" y="262" width="150" height="60" rx="4"/><path class="line thin" d="M187 262v60M112 292h150"/>
<rect class="brand" x="290" y="258" width="64" height="72" rx="4"/><circle class="glass" cx="342" cy="296" r="3"/>
<path class="brand" d="M52 330l6-26h28l6 26z"/><circle class="accent" cx="64" cy="292" r="12"/><circle class="accent" cx="80" cy="286" r="14"/><circle class="accent" cx="72" cy="274" r="10"/>
<path class="line thin" d="M20 330h440"/>`,
};

const VIGNETTE = {
  // A blueprint with a house plan, a hammer, a tape measure and a pencil.
  build: `<rect class="soft" x="20" y="22" width="184" height="150" rx="10"/>
<path class="line thin" d="M56 22v150M92 22v150M128 22v150M164 22v150M20 58h184M20 94h184M20 130h184"/>
<path class="line" d="M62 150v-48l42-34 42 34v48zM96 150v-26h16v26"/>
<circle class="brand" cx="256" cy="146" r="36"/><circle class="soft" cx="256" cy="146" r="14"/>
<rect class="warm" x="196" y="174" width="64" height="12" rx="2"/><path class="line thin" d="M206 174v6M218 174v6M230 174v6M242 174v6"/>
<g transform="rotate(-32 256 76)"><rect class="accent" x="250" y="56" width="12" height="96" rx="6"/><path class="brand" d="M226 40h52v20h-52z"/><path class="brand" d="M278 40c14 0 22 9 22 20h-22z"/></g>
<g transform="rotate(-6 110 200)"><rect class="accent" x="40" y="194" width="10" height="12" rx="2"/><rect class="warm" x="50" y="194" width="110" height="12"/><path class="soft" d="M160 194l16 6-16 6z"/><path class="brand" d="M171 198l5 2-5 2z"/></g>`,
  // A pan, a whisk, a ladle and a peach.
  kitchen: `<circle class="soft" cx="120" cy="120" r="78"/><circle class="brand" cx="120" cy="120" r="56"/><circle class="soft" cx="120" cy="120" r="42"/>
<rect class="brand" x="168" y="110" width="110" height="18" rx="9" transform="rotate(-18 168 119)"/>
<g class="line"><path d="M250 40v70"/><path d="M250 110c-26 30-26 60 0 70 26-10 26-40 0-70zM250 110c-12 30-12 60 0 70 12-10 12-40 0-70z"/></g>
<circle class="warm" cx="92" cy="198" r="18"/><path class="accent" d="M92 180c6-9 17-10 20-7-4 7-13 9-20 7z"/>
<path class="line" d="M296 52v96"/><path class="accent" d="M282 148h28c0 18-6 26-14 26s-14-8-14-26z"/>`,
  // An open sign on a hook, a shopping bag and a small plant.
  store: `<path class="line thin" d="M160 20v28M160 48l-60 40M160 48l60 40"/>
<rect class="brand" x="80" y="86" width="160" height="70" rx="12"/><rect class="soft" x="100" y="106" width="120" height="10" rx="5"/><rect class="soft" x="120" y="126" width="80" height="10" rx="5"/>
<path class="accent" d="M232 150h66l-8 60h-50z"/><path class="line" d="M250 150c0-22 30-22 30 0"/>
<path class="brand" d="M40 210l6-30h28l6 30z"/><circle class="warm" cx="52" cy="168" r="12"/><circle class="accent" cx="68" cy="160" r="14"/>`,
};

// Each scene's frame, cropped to where its drawing is.
const HERO_VIEWBOX = { build: '0 36 480 312', kitchen: '0 0 480 400', store: '0 36 480 312' };
const heroArt = (scene) => svg(HERO_VIEWBOX[scene], HERO[scene], 'art');
const aboutArt = (scene) => svg('0 0 320 220', VIGNETTE[scene], 'vig');
// The soft ridge under the hero, filled with the colour of the section below it.
const ridge = () => '<svg class="hero-ridge" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 120V72l140-30 90 20 180-40 120 30 100-24 200 44 160-34 150 26 120-20 180 30v46z"/></svg>';

module.exports = { sceneFor, heroArt, aboutArt, ridge };
