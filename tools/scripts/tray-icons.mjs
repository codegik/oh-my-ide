/**
 * Draws the two tray icons into apps/desktop/assets/.
 *
 * They are committed, not built: a tray icon is needed before anything in the
 * app runs, and making every clone render SVG would put ImageMagick on the
 * critical path of `./start.sh`. This exists so the shapes stay editable rather
 * than becoming two opaque PNGs nobody dares touch.
 *
 *   node tools/scripts/tray-icons.mjs        # needs ImageMagick with SVG support
 *
 * The mark is the app icon's `< >`, alone: at the ~16 physical pixels a panel
 * gives you, the ring of dots around it turns to mush, and a tray icon that
 * cannot be read at a glance is not doing its one job.
 *
 * Two states, differing in BOTH colour and shape, because colour alone is not a
 * signal everyone can see: idle is a grey mark, attention is the same mark in
 * the ON_ME orange with a filled dot in the corner.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'apps', 'desktop', 'assets');

/** ON_ME, straight from the renderer's stylesheet, and the muted line colour. */
const ON_ME = '#ff7a59';
const IDLE = '#9aa3b8';

/**
 * The canvas a panel scales down to its icon size — so every transparent row
 * around the mark is height the icon does not get, and the whole job of the
 * numbers below is to leave as few of them as possible.
 */
const SIZE = 32;

/**
 * The app icon's `< >` is a wide, short shape. Drawn at those proportions in a
 * square canvas the panel hands back a mark half the height of every neighbour
 * on the bar, because the width runs out first and the rest is padding. So the
 * chevrons here are steeper than the app icon's — the one liberty taken — and
 * pushed out to a ~1px margin on all four sides.
 *
 * The gap is the other half of it: made tall and left at the app icon's spacing
 * the two chevrons close up into a plain diamond outline at 16px. TIP and OPEN
 * are set to keep roughly 6px of daylight between them, which is what still
 * reads as two marks once the panel is done scaling.
 */
const STROKE = 4.5;
const TIP = 3.5; // x of the chevron's point, at the canvas edge
const OPEN = 10.5; // x of its two open ends, facing the gap
const TOP = 5;
const BOTTOM = 27;

/** Mirrored rather than written twice, so the pair cannot drift apart. */
const chevrons = (x) => `M${x(OPEN)} ${TOP} L${x(TIP)} ${SIZE / 2} L${x(OPEN)} ${BOTTOM}`;
const MARK = `
    <path d="${chevrons((v) => v)}"/>
    <path d="${chevrons((v) => SIZE - v)}"/>`;

/**
 * Attention needs a clear corner for the badge, and the only honest way to find
 * one is to step the mark down: 0.8, dropped to the bottom-left. The scale
 * takes the stroke with it, which is the point — a shrunk mark carrying the
 * full-size stroke closes its own gap back up — and it leaves the dot and the
 * chevrons a few pixels apart at every point, so neither needs an outline
 * knocked out of the other. The two together still fill the whole canvas.
 */
const BADGE = 0.8;
const DROP = 7.6;
const DOT = { cx: 26.5, cy: 5.5, r: 5.25 };

const mark = (color, dot) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <g fill="none" stroke="${color}" stroke-width="${STROKE}"
     stroke-linecap="round" stroke-linejoin="round"
     ${dot ? `transform="translate(0 ${DROP}) scale(${BADGE})"` : ''}>${MARK}
  </g>
  ${dot ? `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${ON_ME}"/>` : ''}
</svg>`;

const ICONS = [
  ['tray-idle.png', mark(IDLE, false)],
  ['tray-attention.png', mark(ON_ME, true)],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, svg] of ICONS) {
  const tmp = path.join(OUT, `${name}.svg`);
  fs.writeFileSync(tmp, svg.trim());
  try {
    execFileSync('magick', ['-background', 'none', tmp, '-depth', '8', path.join(OUT, name)]);
  } finally {
    fs.unlinkSync(tmp);
  }
  console.log(`wrote ${path.relative(ROOT, path.join(OUT, name))}`);
}
