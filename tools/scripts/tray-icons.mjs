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
 * The mark is the app icon's `< >`, alone: at 22 physical pixels — which is what
 * a panel gives you — the ring of dots around it turns to mush, and a tray icon
 * that cannot be read at a glance is not doing its one job.
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
 * 32px, which is the size a panel scales from in either direction. Strokes are
 * heavy on purpose: thin ones alias into nothing at a third of this size.
 */
const mark = (color, dot) => `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g fill="none" stroke="${color}" stroke-width="3.2"
     stroke-linecap="round" stroke-linejoin="round"
     ${dot ? 'transform="translate(-2 2) scale(0.75) translate(4 4)"' : ''}>
    <path d="M12 10 L5.5 16 L12 22"/>
    <path d="M20 10 L26.5 16 L20 22"/>
  </g>
  ${dot ? `<circle cx="25" cy="7" r="5.5" fill="${ON_ME}"/>` : ''}
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
