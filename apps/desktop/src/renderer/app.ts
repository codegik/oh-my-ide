import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

/**
 * NOTE: deliberately vanilla TS, not React, for this slice. The plan calls for
 * React + Zustand once the UI grows; adding that build layer now would not change
 * what is on screen. The one rule below is the important part either way.
 */

declare global {
  interface Window {
    omi: {
      rpc(method: string, params?: unknown): Promise<any>;
      welcome(): Promise<any>;
      openExternal(url: string): Promise<void>;
      listDir(raw: string): Promise<{ home: string; path: string; dirs: string[] } | null>;
      ptyInput(viewId: string, bytes: Uint8Array): void;
      onPty(cb: (viewId: string, epoch: number, offset: string, bytes: Uint8Array) => void): void;
      onEvent(cb: (msg: any) => void): void;
      osFont: { ui: number | null; mono: number | null };
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

const ago = (ms: number) => {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  if (s < 86400) return `${(s / 3600) | 0}h`;
  return `${(s / 86400) | 0}d`;
};

/**
 * Shortens a path for the one line it gets in the header: home becomes ~, and a
 * deep path keeps its last two segments, which are the ones that identify it.
 * The full path stays in the tooltip. (CSS ellipsis alone would cut off exactly
 * the informative end, and direction:rtl fixes that by moving the leading slash
 * to the other end of the string, which is a lie.)
 */
function shortPath(full: string): string {
  const home = full.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
  const parts = home.split('/');
  if (parts.length <= 4) return home;
  return [parts[0], '…', ...parts.slice(-2)].join('/');
}

const COURT_LABEL: Record<string, string> = {
  ON_ME: 'ON ME',
  ON_CLAUDE: 'ON CLAUDE',
  ON_SYSTEM: 'ON SYSTEM',
  ON_THEM: 'ON THEM',
  PARKED: 'PARKED',
  DONE: 'DONE',
  DROPPED: 'DROPPED',
};

/** Whose court a session state puts the ball in; drives the session dot colour. */
const STATE_COURT: Record<string, string> = {
  NEEDS_INPUT: 'ON_ME',
  NEEDS_PERMISSION: 'ON_ME',
  FAILED: 'ON_ME',
  WORKING: 'ON_CLAUDE',
  STARTING: 'ON_CLAUDE',
  IDLE: 'PARKED',
  STOPPED: 'PARKED',
  RESUMABLE: 'PARKED',
  UNKNOWN: 'PARKED',
};

interface Ref {
  id: number;
  kind: string;
  externalId: string;
  url: string | null;
  label: string | null;
  state: string | null;
  sessionId: string;
}

interface Track {
  id: number;
  title: string;
  question: string | null;
  nextAction: string | null;
  court: string;
  courtReason: string | null;
  courtRule: string | null;
  courtSource: string;
  lifecycle: 'open' | 'done' | 'dropped';
  originUrl: string | null;
  lastActivityAt: number;
  cwd: string | null;
  archivedAt: number | null;
  refs: Ref[];
}

let tracks: Track[] = [];
/**
 * Finished tracks, fetched only while the `done` section is open. A track's
 * status is binary — going on, or finished — so this is the whole of the other
 * half, and it does not belong in the five-second poll.
 */
let closedTracks: Track[] = [];
let doneOpen = false;
/** Archived tracks, fetched alongside the done list so its entry can show a count. */
let archivedTracks: Track[] = [];
let sessions: any[] = [];
let openTabs: number[] = [];
let activeTab: number | null = null;
/**
 * Which session each track is currently showing. A track holds several
 * conversations and switching between them must not lose your place, so the
 * choice is per track and survives a restart like the tab set does.
 */
let activeSession: Record<number, string> = {};
/** Guards the one slow click in the UI: starting a session takes a moment. */
let starting: number | null = null;

/**
 * Open tabs survive a restart. Closing the window should not cost you the set of
 * things you were working on — that is the same complaint as losing a terminal.
 * localStorage can throw (private windows, blocked site data), so never let it
 * break boot.
 */
function saveTabs() {
  try {
    localStorage.setItem('omi.tabs', JSON.stringify({ openTabs, activeTab, activeSession }));
  } catch {
    /* a lost tab set is not worth an error */
  }
}
function loadTabs() {
  try {
    const raw = localStorage.getItem('omi.tabs');
    if (!raw) return;
    const v = JSON.parse(raw);
    if (Array.isArray(v.openTabs))
      openTabs = v.openTabs.filter((n: unknown) => typeof n === 'number');
    if (typeof v.activeTab === 'number') activeTab = v.activeTab;
    if (v.activeSession && typeof v.activeSession === 'object') activeSession = v.activeSession;
  } catch {
    /* corrupt or unavailable: start clean */
  }
}

/**
 * THE ONE NON-OBVIOUS RULE: terminals live outside the view layer, in this map.
 * Re-rendering a tab must never dispose a Terminal — that would throw away
 * scrollback and force a full replay on every tab switch. The same map is what
 * makes switching sessions inside a track free: each session keeps its own live
 * terminal, detached from the DOM but never torn down.
 */
const terms = new Map<
  string,
  { term: Terminal; fit: FitAddon; el: HTMLDivElement; expect: bigint; epoch: number }
>();

/**
 * Fitting is only meaningful once the host element is laid out. A detached or
 * zero-sized element (mid re-render, or a session that is not on screen) would
 * make the addon compute a nonsense grid, so those calls are dropped rather
 * than clamped.
 */
function fitTerm(v: { term: Terminal; fit: FitAddon; el: HTMLDivElement }) {
  if (!v.el.isConnected || v.el.clientWidth < 2 || v.el.clientHeight < 2) return;
  try {
    v.fit.fit();
  } catch {
    /* layout not settled yet; the ResizeObserver will come back around */
  }
}

const pendingFit = new Set<string>();
function scheduleFit(viewId: string) {
  if (pendingFit.has(viewId)) return;
  pendingFit.add(viewId);
  requestAnimationFrame(() => {
    pendingFit.delete(viewId);
    const v = terms.get(viewId);
    if (v) fitTerm(v);
  });
}

// Match the desktop's text size. This runs before first paint (the bundle is
// the last thing in <body>), so the UI never flashes at the fallback size.
if (window.omi.osFont.ui) {
  document.documentElement.style.setProperty('--fs-s', `${window.omi.osFont.ui}px`);
}
/** Whole pixels: xterm measures cells from this, and a fraction blurs the grid. */
const TERM_FONT_PX = Math.round(window.omi.osFont.mono ?? 14);

function termFor(viewId: string) {
  let t = terms.get(viewId);
  if (t) return t;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono","Fira Code",monospace',
    fontSize: TERM_FONT_PX,
    scrollback: 10_000,
    cursorBlink: true,
    theme: { background: '#0b0d12', foreground: '#e6e9f0' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'termhost';
  term.open(el);
  term.onData((data) => window.omi.ptyInput(viewId, new TextEncoder().encode(data)));

  /**
   * xterm emits ESC[Z for Shift+Tab but does not mark the event cancelled, so
   * without this the browser's own focus traversal runs and pulls focus out of
   * the terminal — which is exactly the key the Claude CLI uses to cycle modes.
   * Returning true still lets xterm send the sequence on to the pty.
   *
   * xterm sends a bare CR for Shift+Enter, indistinguishable from Enter, so the
   * Claude CLI submits instead of inserting a newline. Send ESC CR (Meta+Enter)
   * instead, the same thing `claude /terminal-setup` binds in native terminals.
   * All event types are swallowed so the keypress can't also emit a CR.
   */
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        e.preventDefault();
        window.omi.ptyInput(viewId, new TextEncoder().encode('\x1b\r'));
      }
      return false;
    }
    if (e.type === 'keydown' && e.key === 'Tab') e.preventDefault();
    return true;
  });

  // The pty is the thing that actually has to learn the new size: fitting only
  // reshapes our grid, and a pty left at 80x24 makes the CLI draw at 80x24.
  term.onResize(({ cols, rows }) => {
    if (!openedPtys.has(viewId)) return;
    void window.omi.rpc('pty.resize', { viewId, cols, rows }).catch(() => {});
  });

  // resize alone is not enough: the terminal also changes size when the layout
  // does (tab switch, side panel, font load) with the window standing still.
  t = { term, fit, el, expect: -1n, epoch: 0 };
  new ResizeObserver(() => scheduleFit(viewId)).observe(el);
  terms.set(viewId, t);
  return t;
}

window.omi.onPty((viewId, epoch, offset, bytes) => {
  const t = terms.get(viewId);
  if (!t) return;
  const off = BigInt(offset);
  if (epoch !== t.epoch) {
    t.term.reset();
    t.epoch = epoch;
    t.expect = off;
  }
  if (t.expect >= 0n && off !== t.expect) {
    // A gap means we lost bytes; a partial repaint would be worse than a reset.
    t.term.reset();
  }
  t.term.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  t.expect = off + BigInt((bytes as Uint8Array).length);
});

/**
 * What refreshes the UI on its own. There is no polling here on purpose: the
 * daemon already watches Claude's supervisor and pushes `changed` when a session
 * state or a track actually moves, so a timer would just be a second, worse copy
 * of that — one that repaints while you are typing. The one exception is the
 * token count of a working session; see the timer in boot().
 */
window.omi.onEvent((msg) => {
  if (msg?.t === 'changed') {
    void refresh();
    return;
  }
  if (msg?.t === 'reconnected') {
    // The daemon came back, which means every pty view it owned is gone. Drop
    // what we think is open and let the next render re-attach; the Terminal
    // objects stay, so scrollback survives the round trip.
    openedPtys.clear();
    if (mounted) mounted.viewId = null;
    void refresh();
  }
});

// ── sessions ────────────────────────────────────────────────────────────────

const sessionIdOf = (ref: { externalId: string }) => ref.externalId.replace(/^claude:/, '');
const shortIdOf = (sessionId: string) => sessionId.replace(/-/g, '').slice(0, 8);

/**
 * `claude attach` only works on BACKGROUND jobs. An interactive session is a
 * terminal someone else already owns; there is nothing for us to attach to.
 */
const liveSession = (ref: { externalId: string }) => {
  const id = sessionIdOf(ref);
  // By job too, not just UUID: a background session that moves into a worktree
  // is listed under a new UUID, but keeps the short id it was launched with.
  return sessions.find(
    (s) => s.sessionId === id || (s.kind === 'background' && s.shortId === shortIdOf(id)),
  );
};
const isAttachable = (ref: { externalId: string }) => liveSession(ref)?.kind === 'background';

const sessionRefsOf = (t: Track) => t.refs.filter((r) => r.kind === 'claude_session');

/**
 * The dot is ATTENTION — does this want me right now — and the derived court is
 * already exactly that, so it is the only thing that colours one. There is no
 * second rule here on purpose: a dot computed from sessions alone would miss a
 * failing PR, and two engines answering the same question drift apart.
 *
 * Status is the other axis and never touches this: a track is going on or it is
 * finished, and that lives in `lifecycle`.
 */
const dotOf = (t: Track) => t.court;

/** The session on screen for a track: the remembered one, else the first. */
function currentSession(t: Track): Ref | undefined {
  const list = sessionRefsOf(t);
  const picked = list.find((r) => r.externalId === activeSession[t.id]);
  return picked ?? list.find(isAttachable) ?? list[0];
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * Same rule as the detail pane, for a smaller reason: rebuilding the rail on
 * every poll resets its scroll position, which at 200 tracks means the list
 * jumps out from under the pointer.
 */
let railSig = '';
let tabsSig = '';

const ICON_ARCHIVE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>`;

/** A finished row swaps its age for an archive button on hover; open rows have none. */
const railRow = (t: Track, closed = false) => `
  <div class="titem ${closed ? 'closed' : ''} ${activeTab === t.id ? 'sel' : ''}" data-id="${t.id}">
    <span class="dot ${dotOf(t)}"></span>
    <span class="tname">${esc(t.title)}</span>
    <span class="tago">${ago(t.lastActivityAt)}</span>
    ${
      closed
        ? `<button class="tarch" data-archive="${t.id}" title="archive — hide it from this list"
                 aria-label="archive ${esc(t.title)}">${ICON_ARCHIVE}</button>`
        : ''
    }
  </div>`;

/**
 * One flat list, not a board. Status is binary, so there is nothing to group by;
 * the daemon already returns tracks ordered by court weight then recency, which
 * floats whatever wants you to the top and leaves everything else where it was.
 *
 * Grouping by court is what this used to do, and it meant a row physically
 * jumped between headings while you were reading it — a session finishing its
 * turn would teleport the track from ON CLAUDE to ON ME. The dot changes colour
 * in place instead, which says the same thing without moving anything.
 */
function renderRail() {
  const needs = tracks.filter((t) => t.court === 'ON_ME').length;

  const sig =
    tracks.map((t) => `${t.id}/${t.title}/${dotOf(t)}/${ago(t.lastActivityAt)}`).join(',') +
    `|${activeTab}|${doneOpen}|${closedTracks.map((t) => t.id).join(',')}|${archivedTracks.length}`;
  if (railSig === sig) return;
  railSig = sig;

  // The archive lives behind one line at the foot of the done list: out of the
  // way, but always where you would look for something you finished.
  const archived = `
    <button class="archlink" id="archivedopen" title="archived tracks — search and restore">
      ${archivedTracks.length > 0 ? `archived (${archivedTracks.length})…` : 'view archived…'}
    </button>`;
  const done = `
    <div class="donehead" id="donetoggle" title="finished tracks">
      <span class="caret">${doneOpen ? '⌄' : '›'}</span>
      <span>done</span>
      <span class="tago">${doneOpen ? closedTracks.length || '' : ''}</span>
    </div>
    ${
      doneOpen
        ? (
            closedTracks.map((t) => railRow(t, true)).join('') ||
              '<div class="pad muted">nothing finished yet</div>'
          ) + archived
        : ''
    }`;

  $('railbody').innerHTML =
    tracks.length === 0 && !doneOpen
      ? '<div class="empty">No tracks yet.<br><br>Press <b>+ track</b> to make one.</div>' + done
      : `<div class="railhead">
         <span>${tracks.length} open</span>
         ${needs > 0 ? `<span class="needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : ''}
       </div>
       ${tracks.map((t) => railRow(t)).join('')}
       ${done}`;

  for (const el of document.querySelectorAll<HTMLElement>('.titem')) {
    el.onclick = () => openTrack(Number(el.dataset.id));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-archive]')) {
    b.onclick = (e) => {
      // The button sits inside the row; without this the click also opens it.
      e.stopPropagation();
      void archiveFromRail(Number(b.dataset.archive), b);
    };
  }
  $('donetoggle').onclick = () => {
    void toggleDone();
  };
  const arch = document.getElementById('archivedopen');
  if (arch) arch.onclick = () => openArchiveSheet();
}

/**
 * Finished tracks are fetched on demand — see `tracks.closed` in the daemon.
 * A failed fetch keeps what was there rather than blanking the section.
 */
async function loadDone() {
  const [closed, archived] = await Promise.all([
    window.omi.rpc('tracks.closed').catch(() => closedTracks),
    window.omi.rpc('tracks.archived').catch(() => archivedTracks),
  ]);
  closedTracks = closed;
  archivedTracks = archived;
}

async function toggleDone() {
  doneOpen = !doneOpen;
  if (doneOpen) await loadDone();
  renderRail();
}

/**
 * Archiving hides a finished track without touching its status, so it can come
 * back from the archive sheet exactly as it was. A track being archived is not
 * one you are looking at any more, so its tab goes too.
 */
async function archiveFromRail(id: number, btn: HTMLButtonElement) {
  btn.disabled = true;
  try {
    await window.omi.rpc('tracks.archive', { id });
  } catch (err) {
    btn.disabled = false;
    btn.title = String((err as Error).message);
    return;
  }
  closedTracks = closedTracks.filter((t) => t.id !== id);
  if (openTabs.includes(id) || activeTab === id) closeTab(id);
  else renderRail();
  await refreshAll();
}

// ── tab strips ─────────────────────────────────────────────────────────────

/**
 * Both tab rows behave like IntelliJ's editor tabs: a single row with no
 * scrollbar. A plain mouse wheel scrolls it sideways, the active tab is kept in
 * view, a faded edge says there is more that way, and ▾ — shown only when
 * something does not fit — lists every tab. Called after every rewrite of the
 * row; the handlers are properties, so re-wiring replaces rather than stacks.
 */
const stripObservers = new Map<string, ResizeObserver>();

function wireTabStrip(scroller: HTMLElement, more: HTMLButtonElement, itemSel: string) {
  const sync = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    more.hidden = max <= 1;
    scroller.classList.toggle('fade-l', scroller.scrollLeft > 1);
    scroller.classList.toggle('fade-r', scroller.scrollLeft < max - 1);
  };
  scroller.onwheel = (e) => {
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    // A trackpad already scrolls sideways; only translate a vertical wheel.
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    e.preventDefault();
    scroller.scrollLeft += e.deltaY;
  };
  scroller.onscroll = sync;
  // Middle click closes a tab, as in a browser: it does whatever its × does, so
  // a tab without one (a session still holding refs) stays put.
  scroller.onmousedown = (e) => {
    // Otherwise Linux starts autoscroll or pastes the primary selection.
    if (e.button === 1) e.preventDefault();
  };
  scroller.onauxclick = (e) => {
    if (e.button !== 1) return;
    const x = (e.target as HTMLElement).closest(itemSel)?.querySelector<HTMLElement>('.x');
    if (!x) return;
    e.preventDefault();
    x.click();
  };
  more.onclick = (e) => {
    e.stopPropagation();
    toggleTabMenu(more, scroller, itemSel);
  };
  // The row gets narrower when the window or the rail does, not only when tabs
  // change, so the ▾ has to follow its size too.
  stripObservers.get(more.id)?.disconnect();
  const ro = new ResizeObserver(sync);
  ro.observe(scroller);
  stripObservers.set(more.id, ro);

  // Settle the ▾ first: showing it narrows the row, and scrolling the active tab
  // into view before that would leave it half behind the edge.
  sync();
  scroller
    .querySelector<HTMLElement>(`${itemSel}.on`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  sync();
}

function closeTabMenu() {
  const menu = $('tabmenu');
  if (menu.hidden) return;
  menu.hidden = true;
  document.querySelector('.tabmore.open')?.classList.remove('open');
}

function toggleTabMenu(anchor: HTMLElement, scroller: HTMLElement, itemSel: string) {
  const menu = $('tabmenu');
  if (!menu.hidden && menu.dataset.for === anchor.id) {
    closeTabMenu();
    return;
  }
  closeTabMenu();
  const items = [...scroller.querySelectorAll<HTMLElement>(itemSel)];
  menu.innerHTML = items
    .map((el, i) => {
      const dot = el.querySelector('.dot')?.className ?? 'dot';
      const label = el.querySelector('.tlabel, .sname')?.textContent ?? '';
      return `<button class="tmi ${el.classList.contains('on') ? 'on' : ''}" data-i="${i}"
                    title="${esc(label)}"><span class="${esc(dot)}"></span><span class="tml">${esc(label)}</span></button>`;
    })
    .join('');
  for (const b of menu.querySelectorAll<HTMLElement>('.tmi')) {
    b.onclick = () => {
      const el = items[Number(b.dataset.i)];
      closeTabMenu();
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el.click();
    };
  }
  // Hang it under the ▾, right-aligned to it, like IntelliJ's hidden-tabs list.
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
  menu.dataset.for = anchor.id;
  menu.hidden = false;
  anchor.classList.add('open');
}

function renderTabs() {
  const sig =
    openTabs
      .map((id) => {
        const t = tracks.find((x) => x.id === id);
        return `${id}/${t?.title ?? ''}/${t?.question ?? ''}/${t ? dotOf(t) : ''}`;
      })
      .join(',') + `|${activeTab}`;
  if (tabsSig === sig) return;
  tabsSig = sig;

  $('tabs').innerHTML = openTabs
    .map((id) => {
      const t = tracks.find((x) => x.id === id);
      if (!t) return '';
      return `<div class="tab ${activeTab === id ? 'on' : ''}" data-id="${id}">
      <span class="dot ${dotOf(t)}"></span><span class="tlabel" title="${esc(t.question ?? t.title)}">${esc(t.title)}</span><span class="x" data-close="${id}">×</span></div>`;
    })
    .join('');
  wireTabStrip($('tabs'), $<HTMLButtonElement>('tabsmore'), '.tab');

  for (const el of document.querySelectorAll<HTMLElement>('.tab')) {
    el.onclick = (e) => {
      const close = (e.target as HTMLElement).dataset.close;
      if (close) {
        closeTab(Number(close));
        e.stopPropagation();
        return;
      }
      activeTab = Number(el.dataset.id);
      saveTabs();
      renderAll();
      focusTerminal();
    };
  }
}

/**
 * THE SECOND NON-OBVIOUS RULE: the detail pane is built ONCE per track and then
 * patched in place. Replacing its innerHTML on every poll would detach the
 * terminal element — which drops keyboard focus on the floor and makes xterm
 * repaint from scratch, the "blink every few seconds" that made the terminal
 * unusable. Every region below is rewritten only when its own signature
 * changes, so an idle poll touches no DOM at all.
 */
let mounted: {
  trackId: number;
  viewId: string | null;
  sig: { head: string; sess: string; side: string; time: string; usage: string };
} | null = null;

const EMPTY_SIG = { head: '', sess: '', side: '', time: '', usage: '' };

const trackById = (id: number) =>
  tracks.find((x) => x.id === id) ?? closedTracks.find((x) => x.id === id);

const DETAIL_SKELETON = `
  <div class="thead">
    <div class="trow">
      <span class="folder" id="folder"></span>
      <span class="court" id="whybtn" title="why?"></span>
      <button class="fin" id="finish"></button>
    </div>
  </div>
  <div class="body">
    <div class="left">
      <div class="sessbar" id="sessbar"></div>
      <div id="termwrap" class="termwrap"></div>
    </div>
    <div class="side" id="side">
      <button id="sideclose" class="sideclose" title="close (Esc)">×</button>
      <div id="usage" class="usage"></div>
      <div id="scopebar"></div>
      <input id="paste" placeholder="paste a PR / Slack / Jira link, or PAY-123" />
      <div id="sidetop"></div>
      <div class="shead snotes">NOTES</div>
      <input id="note" placeholder="add a note…" />
      <div id="timeline" class="timeline"></div>
    </div>
  </div>`;

/**
 * Handlers wired once, at build time, so patching a region never has to rebuild
 * them. They read the CURRENT track through trackById rather than closing over
 * the snapshot they were built with, which would go stale on the next poll.
 */
function buildDetail(id: number) {
  const host = $('detail');
  host.innerHTML = DETAIL_SKELETON;
  mounted = { trackId: id, viewId: null, sig: { ...EMPTY_SIG } };

  /**
   * Starting a session needs a folder to start it in, so the two are wired to
   * the same place: no folder, no session. And once a session is bound to the
   * folder the choice is over — a session runs where it was started, and the
   * track cannot claim otherwise (the daemon refuses it either way).
   */
  $('folder').onclick = async () => {
    const t = trackById(id);
    if (!t) return;
    if (t.cwd && sessionRefsOf(t).length > 0) {
      await navigator.clipboard.writeText(t.cwd);
      $('folder').textContent = 'copied';
      setTimeout(() => {
        const btn = $('folder');
        if (!btn.isConnected || btn.textContent !== 'copied') return;
        const cur = trackById(id);
        btn.textContent = cur?.cwd ? shortPath(cur.cwd) : 'choose a folder…';
      }, 900);
      return;
    }
    const dir = await pickFolder($('folder'), t.cwd);
    if (!dir) return;
    await window.omi.rpc('tracks.update', { id, patch: { cwd: dir } });
    await refresh();
  };

  // The drawer covers the right end of the term bar, so it cannot rely on the
  // button that opened it: it closes from inside, or with Escape.
  $('sideclose').onclick = () => {
    $('side').classList.remove('open');
    focusTerminal();
  };

  $<HTMLInputElement>('paste').onkeydown = (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const el = e.target as HTMLInputElement;
    const t = trackById(id);
    const session = t ? currentSession(t) : undefined;
    // A ref is always about the conversation it came up in. A track with no
    // session yet parks them at '' and hands them over when it gets one.
    window.omi
      .rpc('tracks.addLink', { id, text: el.value, sessionId: session?.externalId ?? '' })
      .then(() => {
        el.value = '';
        return refresh();
      })
      .catch((err) => {
        el.value = '';
        el.placeholder = err.message;
      });
  };

  $<HTMLInputElement>('note').onkeydown = (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const el = e.target as HTMLInputElement;
    const text = el.value.trim();
    if (!text) return;
    void window.omi.rpc('tracks.addNote', { id, text }).then(() => {
      el.value = '';
      return refresh();
    });
  };

  // NEVER alert()/confirm()/prompt() here: a modal dialog blocks the whole
  // renderer, freezing every terminal in every tab until it is dismissed.
  $('whybtn').onclick = (e) => {
    e.stopPropagation();
    const t = trackById(id);
    if (!t) return;
    const pop = $('why');
    pop.innerHTML = `
      <div class="whyhead">why is this ${esc(COURT_LABEL[t.court] ?? t.court)}?</div>
      <div class="whyrow"><span>rule</span><b>${esc(t.courtRule)}</b></div>
      <div class="whyrow"><span>source</span><b>${esc(t.courtSource)}</b></div>
      <div class="whyreason">${esc(t.courtReason ?? '')}</div>
      <div class="whyacts">
        <button data-pin="ON_THEM">pin ON THEM</button>
        <button data-pin="">unpin</button>
      </div>`;
    pop.hidden = false;
    for (const b of pop.querySelectorAll<HTMLElement>('[data-pin]')) {
      b.onclick = () => {
        const v = b.dataset.pin;
        void window.omi.rpc('tracks.pin', { id, court: v ? v : null, kind: 'hard' }).then(() => {
          pop.hidden = true;
          return refresh();
        });
      };
    }
    for (const b of pop.querySelectorAll<HTMLElement>('[data-life]')) {
      b.onclick = () => {
        void window.omi
          .rpc('tracks.update', { id, patch: { lifecycle: b.dataset.life } })
          .then(() => {
            pop.hidden = true;
            closeTab(id);
            return refresh();
          });
      };
    }
    // Scoped to this popover, and replaced on the next open, so it cannot pile
    // up one listener per poll the way a render-time listener would.
    const away = () => {
      pop.hidden = true;
    };
    setTimeout(() => document.addEventListener('click', away, { once: true }), 0);
  };
}

/**
 * Folder, court and finish, on one line. No title: the active tab right above
 * already names the track, and the rail names it again. The question rides
 * along as the tab's tooltip instead.
 */
function patchHead(t: Track) {
  const m = mounted as NonNullable<typeof mounted>;
  const sig = `${t.court}|${t.lifecycle}|${t.cwd}|${sessionRefsOf(t).length > 0}`;
  if (m.sig.head === sig) return;
  m.sig.head = sig;

  const court = $('whybtn');
  court.className = `court ${t.court}`;
  court.textContent = COURT_LABEL[t.court] ?? t.court;

  // Binary: going on, or finished. Reopening is the same button, because a
  // status with two values should never need two controls.
  const finish = $<HTMLButtonElement>('finish');
  const closed = t.lifecycle !== 'open';
  finish.textContent = closed ? 'reopen' : 'finish';
  finish.title = closed
    ? `${t.lifecycle} — click to put this back in the open list`
    : 'mark this finished and file it under done';
  finish.onclick = () => {
    void window.omi
      .rpc('tracks.update', {
        id: t.id,
        patch: { lifecycle: closed ? 'open' : 'done' },
      })
      .then(() => {
        if (!closed) closeTab(t.id);
        return refreshAll();
      });
  };

  const folder = $('folder');
  const fixed = !!t.cwd && sessionRefsOf(t).length > 0;
  folder.className = fixed ? 'folder fixed' : 'folder';
  folder.title = t.cwd
    ? fixed
      ? `${t.cwd} — click to copy`
      : `${t.cwd} — click to change`
    : 'no folder set — click to choose one';
  folder.textContent = t.cwd ? shortPath(t.cwd) : 'choose a folder…';
}

/** Icons for the session strip's buttons; they take the button's text colour. */
const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

/** One chip per session in the track, plus the buttons that add another. */
function patchSessbar(t: Track, session: Ref | undefined) {
  const m = mounted as NonNullable<typeof mounted>;
  const list = sessionRefsOf(t);
  const sig =
    list
      .map((r) => {
        const held = t.refs.filter(
          (x) => x.kind !== 'claude_session' && x.sessionId === r.externalId,
        ).length;
        return `${r.externalId}:${r.label}:${r.state ?? liveSession(r)?.state ?? ''}:${held}`;
      })
      .join(',') + `|${session?.externalId ?? ''}|${starting === t.id}`;
  if (m.sig.sess === sig) return;
  m.sig.sess = sig;

  // The row is rebuilt below; keep where it was scrolled to, or every poll that
  // changes a session's state would jump it back to the start.
  const scrolled = document.getElementById('sesstabs')?.scrollLeft ?? 0;
  $('sessbar').innerHTML = `
    <div id="sesstabs" class="tabscroll">
    ${list
      .map((r) => {
        const state = r.state ?? liveSession(r)?.state ?? '';
        // An empty session is disposable; one holding refs is not, because they
        // live in its scope and would go with it.
        const holds = t.refs.filter(
          (x) => x.kind !== 'claude_session' && x.sessionId === r.externalId,
        ).length;
        // A session's folder is fixed by Claude when it starts, so one that is not
        // the track's own folder is worth saying out loud.
        const cwd = liveSession(r)?.cwd;
        const where = cwd && cwd !== t.cwd ? `\n${cwd}` : '';
        // The count of what it holds belongs in the tooltip, not on the chip.
        const held = holds === 0 ? '' : `\n${holds} ref${holds === 1 ? '' : 's'} linked here`;
        return `<div class="sess ${session?.externalId === r.externalId ? 'on' : ''}"
                   data-sid="${esc(r.externalId)}"
                   title="${esc((state ? `${state} · ${sessionIdOf(r)}` : sessionIdOf(r)) + where + held)}">
        <span class="dot ${STATE_COURT[state] ?? 'PARKED'}"></span>
        <span class="sname">${esc(r.label ?? shortIdOf(sessionIdOf(r)))}</span>
        ${
          holds === 0
            ? `<span class="x" data-drop="${r.id}" title="remove this session from the track">×</span>`
            : ''
        }
      </div>`;
      })
      .join('')}
    </div>
    <button id="sessmore" class="tabmore" hidden title="all sessions in this track">▾</button>
    <div class="sessacts">
      ${
        starting === t.id
          ? `<button class="sadd" id="addsess" disabled aria-busy="true"
                   title="starting a session…" aria-label="starting a session…">${ICON_PLUS}</button>`
          : `<button class="sadd" id="addsess"
                   title="open another session in this track" aria-label="open another session in this track">${ICON_PLUS}</button>`
      }
      <button class="sadd" id="attachsess"
              title="attach a session that is already running" aria-label="attach a session that is already running">${ICON_LINK}</button>
      <button id="sidetoggle" class="sidetoggle" title="refs">refs ↔</button>
    </div>`;
  $('sesstabs').scrollLeft = scrolled;
  wireTabStrip($('sesstabs'), $<HTMLButtonElement>('sessmore'), '.sess');

  for (const el of document.querySelectorAll<HTMLElement>('.sess')) {
    el.onclick = (e) => {
      const drop = (e.target as HTMLElement).dataset.drop;
      if (drop) {
        e.stopPropagation();
        void window.omi
          .rpc('tracks.removeRef', { id: t.id, refId: Number(drop) })
          .then(() => {
            // Fall back to whatever session is left.
            delete activeSession[t.id];
            saveTabs();
            return refresh();
          })
          .catch((err) => {
            el.title = String(err.message);
          });
        return;
      }
      activeSession[t.id] = String(el.dataset.sid);
      saveTabs();
      renderDetail();
      focusTerminal();
    };
  }

  $('sidetoggle').onclick = () => {
    $('side').classList.toggle('open');
    focusTerminal();
  };
  $('attachsess').onclick = () => openAttachSheet(t.id);
  /**
   * One click, one session. It opens idle with no prompt and no name — the first
   * thing typed into the terminal is what gives it both a subject and a title,
   * so there is nothing to fill in here.
   */
  $('addsess').onclick = async () => {
    if (starting !== null) return;
    let cur = trackById(t.id);
    // A session has to start somewhere. If the track has no folder yet, ask for
    // one and carry on — a button that silently does nothing is worse than a
    // button that asks a question.
    if (!cur?.cwd) {
      const dir = await pickFolder($('addsess'));
      if (!dir) return;
      await window.omi.rpc('tracks.update', { id: t.id, patch: { cwd: dir } });
      await refresh();
      cur = trackById(t.id);
      if (!cur?.cwd) return;
    }
    starting = t.id;
    renderDetail();
    try {
      const r = await window.omi.rpc('tracks.startSession', { id: t.id });
      if (r?.session?.sessionId) activeSession[t.id] = `claude:${r.session.sessionId}`;
      saveTabs();
    } catch (err) {
      $('addsess').title = String((err as Error).message);
    } finally {
      starting = null;
    }
    await refresh();
    focusTerminal();
  };
}

function patchSide(t: Track, session: Ref | undefined) {
  const m = mounted as NonNullable<typeof mounted>;
  const sid = session?.externalId ?? '';
  // Only this session's refs. Switching session switches the whole panel with
  // it — that is the point of scoping them in the first place.
  const refs = t.refs.filter((r) => r.kind !== 'claude_session' && r.sessionId === sid);
  const fingerprint = (r: Ref) => `${r.id}:${r.label}:${r.state}`;
  const sig = `${sid}|${refs.map(fingerprint).join(',')}`;
  if (m.sig.side === sig) return;
  m.sig.side = sig;

  const refRow = (r: Ref) => `
    <div class="ref">
      <span class="rk">${esc(r.kind.replace('_', ' '))}</span>
      <span class="rl">${esc(r.label ?? r.externalId)}</span>
      ${r.state ? `<span class="rs">${esc(r.state)}</span>` : ''}
      ${r.url ? `<a class="go" data-url="${esc(r.url)}" title="open link">↗</a>` : ''}
      <a class="rm" data-ref="${r.id}" title="unlink">×</a>
    </div>`;

  // The box you type into sits above the list it adds to, so what you add
  // appears under your cursor. The session is already named in the tab bar.
  $('scopebar').innerHTML = '<div class="shead">REFS</div>';

  $('sidetop').innerHTML = `
    <div id="refs">
      ${refs.map(refRow).join('')}
    </div>`;

  for (const el of document.querySelectorAll<HTMLElement>('#refs .go')) {
    el.onclick = () => window.omi.openExternal(el.dataset.url as string);
  }
  for (const el of document.querySelectorAll<HTMLElement>('.rm')) {
    el.onclick = () =>
      void window.omi
        .rpc('tracks.removeRef', { id: t.id, refId: Number(el.dataset.ref) })
        .then(refresh)
        .catch((err) => {
          el.title = String(err.message);
        });
  }
}

/** 1234 → 1.2k, 411975 → 412k, 40574131 → 40.6M. Tokens are read at a glance. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * What the session on screen has spent, above its refs. Read from the
 * transcript by the daemon, so it works for a session that has stopped too.
 * Context comes first: it is the number you act on — it says when a
 * conversation has grown heavy enough to compact or start over — where the
 * totals only ever go up.
 */
function patchUsage(t: Track, session: Ref | undefined) {
  const el = document.getElementById('usage');
  if (!el) return;
  const sid = session?.externalId ?? '';
  // A different session's numbers must not linger while this one's load.
  if (el.dataset.sid !== sid) {
    el.dataset.sid = sid;
    el.innerHTML = '';
    if (mounted) mounted.sig.usage = '';
  }
  if (!session) return;

  const stored = sessionIdOf(session);
  const live = liveSession(session);
  const ids = live && live.sessionId !== stored ? [stored, live.sessionId] : [stored];
  void window.omi
    .rpc('sessions.usage', { ids, cwd: live?.cwd ?? t.cwd ?? '' })
    .then((u: any) => {
      const m = mounted;
      if (!m || m.trackId !== t.id || el.dataset.sid !== sid || !el.isConnected) return;
      const row = (k: string, v: string, tip = '') =>
        `<div class="kv" ${tip ? `title="${esc(tip)}"` : ''}><span class="rk">${k}</span><span class="kvv">${v}</span></div>`;
      let html = '<div class="shead">SESSION</div>';
      if (!u || u.requests === 0) {
        html += '<div class="muted pad">nothing spent yet</div>';
      } else {
        const input = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        const cached = input > 0 ? Math.round((u.cacheReadTokens / input) * 100) : 0;
        html +=
          row(
            'context',
            `${fmtTokens(u.contextTokens)} tokens`,
            'what the last request sent: how much the conversation weighs now. Drops after a compaction.',
          ) +
          row(
            'output',
            fmtTokens(u.outputTokens),
            `tokens written by Claude, thinking included, over ${u.requests} requests`,
          ) +
          row(
            'input',
            `${fmtTokens(input)} <span class="muted">· ${cached}% cached</span>`,
            `fresh ${u.inputTokens.toLocaleString()} · cache read ${u.cacheReadTokens.toLocaleString()} · cache write ${u.cacheWriteTokens.toLocaleString()}\n` +
              "from the transcript: the CLI's own side requests (titles, classifiers) are not in it",
          ) +
          (u.gitBranch
            ? row('branch', esc(u.gitBranch === 'HEAD' ? 'detached' : u.gitBranch))
            : '');
      }
      if (m.sig.usage === html) return;
      m.sig.usage = html;
      el.innerHTML = html;
    })
    .catch(() => {});
}

/**
 * Mounting is the one thing allowed to move the terminal element, and it only
 * happens when the session on screen actually changes.
 */
/**
 * Puts the cursor back in the terminal. Called after the things that take focus
 * away by necessity — opening a track, switching session, closing a sheet — and
 * never on a data refresh, so a session going NEEDS_INPUT cannot yank the caret
 * out of the field you are typing in.
 */
function focusTerminal() {
  if (!mounted?.viewId?.startsWith('claude:')) return;
  const v = terms.get(mounted.viewId);
  const el = document.activeElement;
  // If the user is in an input, they chose that; leave them there.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (!el.classList.contains('xterm-helper-textarea')) return;
  }
  v?.term.focus();
}

/**
 * Whether a stopped session still has a transcript to resume from, by session
 * ref. Asked when one is first put on screen, not on the poll — the answer means
 * listing every folder Claude keeps. Undefined until the daemon answers.
 */
const transcripts = new Map<string, boolean>();
const askingTranscript = new Set<string>();
function checkTranscript(ext: string) {
  if (askingTranscript.has(ext)) return;
  askingTranscript.add(ext);
  void window.omi
    .rpc('sessions.hasTranscript', { session: ext })
    // Could not tell: keep offering resume, which is what it always did.
    .catch(() => true)
    .then((has: boolean) => {
      askingTranscript.delete(ext);
      if (transcripts.get(ext) === has) return;
      transcripts.set(ext, has);
      renderDetail();
    });
}
function transcriptOf(ext: string): boolean | undefined {
  const has = transcripts.get(ext);
  if (has === undefined) checkTranscript(ext);
  return has;
}

function mountTerminal(t: Track, session: Ref | undefined) {
  const m = mounted as NonNullable<typeof mounted>;
  const live = session ? liveSession(session) : undefined;
  // The job's own short id, which is what `claude attach` takes.
  const shortId = live?.kind === 'background' ? (live.shortId as string) : null;
  const viewId = shortId ? `claude:${shortId}` : null;
  // Only a session that is gone from the listing can be missing its transcript.
  const has = session && !live ? transcriptOf(session.externalId) : undefined;
  const key = viewId ?? `none:${session?.externalId ?? ''}:${live?.kind ?? ''}:${has ?? ''}`;
  if (m.viewId === key) return;
  m.viewId = key;

  const wrap = $('termwrap');
  // The element is only detached, never disposed: its Terminal keeps its
  // scrollback so coming back to this session is instant.
  wrap.replaceChildren();

  if (session && viewId) {
    const v = termFor(viewId);
    wrap.appendChild(v.el);
    // Fit BEFORE opening: the pty is spawned with whatever cols/rows we pass,
    // and the default 80x24 is almost never what the pane is.
    fitTerm(v);
    void openPty(shortId as string, viewId, t.cwd);
    // Switching session is a deliberate act, so put the cursor where the user
    // is now looking — unless they are mid-sentence in one of the fields, which
    // focusTerminal() checks for us.
    focusTerminal();
    requestAnimationFrame(() => fitTerm(v));
    return;
  }

  if (session) {
    if (live) {
      wrap.innerHTML = `<div class="empty">
        <b>${esc(session.label ?? '')}</b> is an ${esc(live.kind)} session.<br><br>
        Only background sessions can be attached — an interactive one already belongs to a terminal you opened.
        </div>`;
      return;
    }
    const label = esc(session.label ?? '');
    const holds = t.refs.filter(
      (x) => x.kind !== 'claude_session' && x.sessionId === session.externalId,
    ).length;
    const refCount = `${holds} ref${holds === 1 ? '' : 's'}`;
    if (has === undefined) {
      // Asking the daemon takes a moment; offering resume meanwhile would be a
      // promise the answer may take back.
      wrap.innerHTML = `<div class="empty"><b>${label}</b> is no longer running.</div>`;
      return;
    }
    const busy = (b: HTMLButtonElement, text: string) => {
      for (const x of wrap.querySelectorAll<HTMLButtonElement>('.deadacts button'))
        x.disabled = true;
      b.textContent = text;
    };
    const fail = (err: unknown) => {
      // The view is keyed on the session, so it is not rebuilt on its own; put
      // the buttons back so the user can try again or take the other way out.
      m.viewId = null;
      renderDetail();
      const el = document.getElementById('deaderr');
      if (el) el.textContent = (err as Error).message;
    };
    /** Puts the session that just started on screen. */
    const land = async (r: any) => {
      if (r?.session?.sessionId) activeSession[t.id] = `claude:${r.session.sessionId}`;
      saveTabs();
      await refresh();
      focusTerminal();
    };

    if (!has) {
      // Its transcript is gone — deleted, or cleaned up by Claude — so resume
      // has nothing to load. The refs are still ours; a fresh session takes them
      // and the dead tab goes, instead of leaving a corpse to click past.
      wrap.innerHTML = `<div class="empty">
        <b>${label}</b> cannot be resumed.<br><br>
        Claude no longer has its transcript, so there is nothing to pick up from.<br>
        A fresh session in ${t.cwd ? esc(shortPath(t.cwd)) : "this track's folder"} takes its place${
          holds > 0 ? `, keeping its ${refCount}` : ''
        }.
        <div class="deadacts">
          <button class="wbtn primary" id="replacesess">start fresh session</button>
        </div>
        <div class="deaderr muted" id="deaderr"></div>
        </div>`;
      $<HTMLButtonElement>('replacesess').onclick = async (e) => {
        busy(e.currentTarget as HTMLButtonElement, 'starting…');
        try {
          const r = await window.omi.rpc('tracks.replaceSession', {
            id: t.id,
            session: session.externalId,
          });
          transcripts.delete(session.externalId);
          await land(r);
        } catch (err) {
          fail(err);
        }
      };
      return;
    }

    // A stopped session is not a dead end. Resuming keeps its id, so the refs it
    // holds stay put; starting over is the fallback when resume will not take,
    // and it takes those refs along instead of leaving them on a corpse.
    wrap.innerHTML = `<div class="empty">
      <b>${label}</b> is no longer running.<br><br>
      Its transcript is kept, so it can pick up where it left off.
      <div class="deadacts">
        <button class="wbtn primary" id="resumesess">resume</button>
        ${
          holds > 0
            ? `<button class="wbtn" id="freshsess"
                     title="for when it cannot be resumed">new session, keep ${refCount}</button>`
            : ''
        }
      </div>
      <div class="deaderr muted" id="deaderr"></div>
      </div>`;
    $<HTMLButtonElement>('resumesess').onclick = async (e) => {
      busy(e.currentTarget as HTMLButtonElement, 'resuming…');
      try {
        await land(
          await window.omi.rpc('tracks.resumeSession', {
            id: t.id,
            session: session.externalId,
          }),
        );
      } catch (err) {
        fail(err);
        // A transcript can go while the app is open; if that is why, this
        // swaps the panel for the one that offers the way out.
        checkTranscript(session.externalId);
      }
    };
    const fresh = document.getElementById('freshsess') as HTMLButtonElement | null;
    if (fresh) {
      fresh.onclick = async () => {
        busy(fresh, 'starting…');
        try {
          await land(
            await window.omi.rpc('tracks.startSession', {
              id: t.id,
              carryFrom: session.externalId,
            }),
          );
        } catch (err) {
          fail(err);
        }
      };
    }
    return;
  }

  wrap.innerHTML = `<div class="empty">
    No session in this track yet.<br><br>
    <b>+ session</b> starts one in ${t.cwd ? esc(t.cwd) : 'a folder you choose'},
    <b>attach…</b> picks one that is already running.
    </div>`;
}

/**
 * Only the user's own notes. System events (links, renames, pins) are still
 * recorded — they drive activity times and the "why" popover — but as a feed
 * they were noise next to what the user actually wrote down.
 */
function patchTimeline(t: Track) {
  void window.omi.rpc('tracks.notes', { id: t.id }).then((rows: any[]) => {
    const el = document.getElementById('timeline');
    const m = mounted;
    if (!el || !m || m.trackId !== t.id) return;
    const html = rows
      .map(
        (r) => `
      <div class="ev"><span class="evt">${ago(r.occurred_at)}</span>
      <span class="evb">${esc(r.body ?? r.title)}</span></div>`,
      )
      .join('');
    if (m.sig.time === html) return;
    m.sig.time = html;
    el.innerHTML = html;
  });
}

function renderDetail() {
  // trackById, not `tracks`: a finished track opened from the `done` section is
  // still readable — you just cannot do much in it.
  const t = activeTab === null ? undefined : trackById(activeTab);
  const host = $('detail');
  if (!t) {
    if (mounted) {
      host.innerHTML = '<div class="empty">Open a track from the list, or create one.</div>';
      mounted = null;
    }
    return;
  }

  if (!mounted || mounted.trackId !== t.id) buildDetail(t.id);

  const session = currentSession(t);
  patchHead(t);
  patchSessbar(t, session);
  patchSide(t, session);
  patchUsage(t, session);
  mountTerminal(t, session);
  patchTimeline(t);
}

// ── folder picker ───────────────────────────────────────────────────────────

/**
 * A folder is typed, not browsed to in a native dialog: a small box under
 * whatever asked, starting at home, completing directory names as you go. It
 * only ever resolves to a directory that exists — the main process checks — so
 * a typo cannot point a track at nothing.
 */
interface Picker {
  resolve: (dir: string | null) => void;
  /** Listings keyed by the parent as typed; fresh for every opening. */
  cache: Map<string, string[] | null>;
  matches: string[];
  sel: number;
  /** Drops listings that come back after the input has already moved on. */
  seq: number;
  away: (e: MouseEvent) => void;
  restore: Element | null;
}
let picker: Picker | null = null;

const PICKER_ROWS = 200;
const PICKER_HINT = 'tab completes · enter chooses · esc cancels';

const tildify = (abs: string, home: string) =>
  abs === home ? '~' : abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;

/** '~/src/oh-m' → ['~/src/', 'oh-m']: where to look, and what to look for. */
function splitPath(v: string): [string, string] {
  const i = v.lastIndexOf('/');
  return i < 0 ? ['', v] : [v.slice(0, i + 1), v.slice(i + 1)];
}

/**
 * Exact name first, then names that start with what was typed, then names that
 * merely contain it. Dot-folders stay out of the way until you type the dot.
 */
function rankDirs(dirs: string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  const shown = p.startsWith('.') ? dirs : dirs.filter((d) => !d.startsWith('.'));
  if (!p) return shown;
  const exact: string[] = [];
  const starts: string[] = [];
  const has: string[] = [];
  for (const d of shown) {
    const l = d.toLowerCase();
    if (l === p) exact.push(d);
    else if (l.startsWith(p)) starts.push(d);
    else if (l.includes(p)) has.push(d);
  }
  return [...exact, ...starts, ...has];
}

async function pickFolder(anchor: HTMLElement, startIn?: string | null): Promise<string | null> {
  if (picker) closePicker(null);
  const root = await window.omi.listDir('~');
  if (!root) return null;
  const home = root.path;

  return new Promise((resolve) => {
    const host = $('fpick');
    const away = (e: MouseEvent) => {
      if (!host.contains(e.target as Node)) closePicker(null);
    };
    picker = {
      resolve,
      cache: new Map([['~/', root.dirs]]),
      matches: [],
      sel: -1,
      seq: 0,
      away,
      restore: document.activeElement,
    };
    host.innerHTML = `
      <div class="fptop">
        <input id="fpin" spellcheck="false" autocomplete="off" />
        <button type="button" id="fpgo" class="wbtn">choose</button>
      </div>
      <div id="fplist" class="fplist"></div>
      <div id="fphint" class="fphint">${PICKER_HINT}</div>`;
    host.hidden = false;

    // Under the thing that asked, kept on screen.
    const r = anchor.getBoundingClientRect();
    const width = Math.min(460, window.innerWidth - 32);
    host.style.width = `${width}px`;
    host.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - width - 16))}px`;
    host.style.top = `${r.bottom + 6}px`;

    const input = $<HTMLInputElement>('fpin');
    const start = startIn ? tildify(startIn, home) : '~';
    input.value = start.endsWith('/') ? start : `${start}/`;
    input.oninput = () => void suggest();
    input.onkeydown = onPickerKey;
    $('fpgo').onclick = () => void choose();
    document.addEventListener('mousedown', away, true);
    input.focus();
    void suggest();
  });
}

function closePicker(dir: string | null) {
  const p = picker;
  if (!p) return;
  picker = null;
  document.removeEventListener('mousedown', p.away, true);
  const host = $('fpick');
  host.hidden = true;
  host.innerHTML = '';
  const back = p.restore;
  if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus();
  else if (!wizard && !attachSheet) focusTerminal();
  p.resolve(dir);
}

function setPickerHint(msg: string | null) {
  const el = document.getElementById('fphint');
  if (!el) return;
  el.textContent = msg ?? PICKER_HINT;
  el.classList.toggle('bad', msg !== null);
}

async function suggest() {
  const p = picker;
  if (!p) return;
  const [parent, prefix] = splitPath($<HTMLInputElement>('fpin').value);
  const seq = ++p.seq;
  let dirs = p.cache.get(parent);
  if (dirs === undefined) {
    dirs = (await window.omi.listDir(parent || '~'))?.dirs ?? null;
    p.cache.set(parent, dirs);
  }
  if (picker !== p || seq !== p.seq) return;
  p.matches = dirs ? rankDirs(dirs, prefix) : [];
  // With a name half typed, the best match is one keypress away; right after a
  // slash nothing is, so Enter means the folder you are standing in.
  p.sel = prefix && p.matches.length > 0 ? 0 : -1;
  setPickerHint(dirs ? null : `${parent || '~'} is not a folder`);
  renderPickerList(dirs === null ? '' : prefix ? 'no match' : 'no folders in here');
}

function renderPickerList(none = '') {
  const p = picker;
  if (!p) return;
  const list = $('fplist');
  list.innerHTML =
    p.matches
      .slice(0, PICKER_ROWS)
      .map(
        (d, i) => `
    <div class="fprow ${i === p.sel ? 'on' : ''}" data-i="${i}">${esc(d)}<span class="muted">/</span></div>`,
      )
      .join('') || (none ? `<div class="fpnone">${none}</div>` : '');
  for (const el of list.querySelectorAll<HTMLElement>('.fprow')) {
    // Keep the caret in the input: the list is only ever a shortcut for typing.
    el.onmousedown = (e) => e.preventDefault();
    el.onclick = () => descend(Number(el.dataset.i));
  }
  list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

/** Completes the input to a folder and lists what is inside it. */
function descend(i: number) {
  const p = picker;
  const name = p?.matches[i];
  if (!p || name === undefined) return;
  const input = $<HTMLInputElement>('fpin');
  input.value = `${splitPath(input.value)[0]}${name}/`;
  input.focus();
  void suggest();
}

async function choose() {
  const p = picker;
  if (!p) return;
  const value = $<HTMLInputElement>('fpin').value;
  const typed = p.sel >= 0 ? splitPath(value)[0] + p.matches[p.sel] : value;
  const r = await window.omi.listDir(typed || '~');
  if (picker !== p) return;
  if (!r) {
    setPickerHint(`${typed} is not a folder`);
    return;
  }
  closePicker(r.path);
}

function onPickerKey(e: KeyboardEvent) {
  const p = picker;
  if (!p) return;
  const n = Math.min(p.matches.length, PICKER_ROWS);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (n === 0) return;
    p.sel = e.key === 'ArrowDown' ? (p.sel + 1) % n : p.sel <= 0 ? n - 1 : p.sel - 1;
    renderPickerList();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    descend(p.sel >= 0 ? p.sel : 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    void choose();
  }
}

// ── new track ───────────────────────────────────────────────────────────────

/**
 * A track is a folder plus the conversations happening in it, so the wizard asks
 * in that order: folder first, then which sessions — you cannot pick a session
 * before you know where to look for one.
 */
interface Wizard {
  title: string;
  cwd: string | null;
  picked: Set<string>;
  fresh: boolean;
  busy: string | null;
  /** Focus belongs to the user once they have started typing. */
  focused: boolean;
  /** Sessions that ran in `cwd` before but aren't live now — fetched on demand. */
  past: any[];
  pastLoading: boolean;
}
let wizard: Wizard | null = null;

/**
 * Past sessions live on disk, not in the polled `sessions` list, so they are
 * fetched on demand for one folder at a time — never from the event-driven
 * `refresh()` path, the same way `pickFolder` already does on-demand `listDir`
 * calls instead of pre-loading the whole filesystem.
 */
async function fetchPast(cwd: string | null): Promise<any[]> {
  if (!cwd) return [];
  return window.omi.rpc('sessions.past', { cwd }).catch(() => []);
}

function setWizardCwd(cwd: string | null) {
  const w = wizard;
  if (!w) return;
  w.cwd = cwd;
  w.picked.clear();
  w.past = [];
  w.pastLoading = !!cwd;
  renderWizard();
  void fetchPast(cwd).then((rows) => {
    if (!wizard || wizard.cwd !== cwd) return; // folder changed again meanwhile
    wizard.past = rows;
    wizard.pastLoading = false;
    renderWizard();
  });
}

function openWizard() {
  const recent = [...new Set(tracks.map((t) => t.cwd).filter((c): c is string => !!c))];
  attachSheet = null;
  archiveSheet = null;
  wizard = {
    title: '',
    cwd: null,
    picked: new Set(),
    fresh: false,
    busy: null,
    focused: false,
    past: [],
    pastLoading: false,
  };
  setWizardCwd(recent[0] ?? null);
}

function renderWizard() {
  const w = wizard;
  const host = $('modal');
  if (!w) return;
  host.hidden = false;

  const recent = [...new Set(tracks.map((t) => t.cwd).filter((c): c is string => !!c))].slice(0, 6);
  const here = w.cwd ? sessions.filter((s) => s.cwd === w.cwd) : [];

  host.innerHTML = `
    <form class="sheet" id="wiz">
      <div class="whead">NEW TRACK</div>

      <label class="wlab">what is the question? <span class="muted">— optional</span></label>
      <input id="wtitle" value="${esc(w.title)}" placeholder="a question works best, but you can name it later…" />

      <label class="wlab">folder</label>
      <div class="wrow">
        <button type="button" id="wpick" class="wbtn">${w.cwd ? 'change…' : 'choose a folder…'}</button>
        <span class="wpath">${w.cwd ? esc(w.cwd) : '<span class="muted">none yet</span>'}</span>
      </div>
      ${
        recent.length > 0
          ? `<div class="wrecent">${recent
              .map(
                (c) => `
        <button type="button" class="chip ${c === w.cwd ? 'on' : ''}" data-cwd="${esc(c)}">${esc(c.split('/').pop() ?? c)}</button>`,
              )
              .join('')}</div>`
          : ''
      }

      <label class="wlab">sessions in this folder</label>
      <div class="wsess">
        ${!w.cwd ? '<div class="muted pad">choose a folder first</div>' : ''}
        ${w.cwd && here.length === 0 ? '<div class="muted pad">none running here yet</div>' : ''}
        ${here
          .map((s) => {
            const bg = s.kind === 'background';
            return `<label class="wopt ${bg ? '' : 'off'}">
            <input type="checkbox" data-sess="${esc(s.sessionId)}" ${bg ? '' : 'disabled'}
                   ${w.picked.has(s.sessionId) ? 'checked' : ''} />
            <span class="dot ${STATE_COURT[s.state] ?? 'PARKED'}"></span>
            <span class="wname">${esc(s.name ?? s.shortId)}</span>
            <span class="sstate">${esc(s.state)}${bg ? '' : ' · interactive, cannot attach'}</span>
          </label>`;
          })
          .join('')}
        ${w.pastLoading ? '<div class="muted pad">looking for past sessions…</div>' : ''}
        ${w.past.length > 0 ? '<div class="wsub">past sessions here</div>' : ''}
        ${w.past
          .map(
            (s) => `
          <label class="wopt past">
            <input type="checkbox" data-sess="${esc(s.sessionId)}" ${w.picked.has(s.sessionId) ? 'checked' : ''} />
            <span class="dot PARKED"></span>
            <span class="wname">${esc(s.preview ?? s.shortId)}</span>
            <span class="sstate">${s.gitBranch ? `${esc(s.gitBranch)} · ` : ''}last active ${ago(s.lastActivityAt)} ago</span>
          </label>`,
          )
          .join('')}
        <label class="wopt">
          <input type="checkbox" id="wfresh" ${w.fresh ? 'checked' : ''} ${w.cwd ? '' : 'disabled'} />
          <span class="dot ON_CLAUDE"></span>
          <span class="wname">open a new session</span>
          <span class="sstate">idle until you type in it</span>
        </label>
      </div>

      ${w.busy ? `<div class="wbusy">${esc(w.busy)}</div>` : ''}
      <div class="wacts">
        <button type="button" id="wcancel" class="wbtn">cancel</button>
        <button type="submit" class="wbtn primary" ${w.busy ? 'disabled' : ''}>create track</button>
      </div>
    </form>`;

  /**
   * The title is bound to state, not to the DOM: the session list can refresh
   * under the sheet, and a re-render must not drop what was typed. Focus is
   * taken once, for the same reason.
   */
  const title = document.getElementById('wtitle') as HTMLInputElement | null;
  if (title)
    title.oninput = () => {
      if (wizard) wizard.title = title.value;
    };
  if (!w.busy && !w.focused) {
    w.focused = true;
    $('wtitle').focus();
  }

  $('wpick').onclick = async () => {
    const dir = await pickFolder($('wpick'), w.cwd);
    if (!dir) return;
    setWizardCwd(dir);
  };
  for (const c of document.querySelectorAll<HTMLElement>('.chip')) {
    c.onclick = () => setWizardCwd(String(c.dataset.cwd));
  }
  for (const b of document.querySelectorAll<HTMLInputElement>('[data-sess]')) {
    b.onchange = () => {
      if (!wizard) return;
      const id = String(b.dataset.sess);
      if (b.checked) wizard.picked.add(id);
      else wizard.picked.delete(id);
    };
  }
  const fresh = document.getElementById('wfresh') as HTMLInputElement | null;
  if (fresh)
    fresh.onchange = () => {
      if (!wizard) return;
      wizard.fresh = fresh.checked;
      renderWizard();
    };
  $('wcancel').onclick = () => closeModal();
  $<HTMLFormElement>('wiz').onsubmit = (e) => {
    e.preventDefault();
    void createFromWizard();
  };
}

async function createFromWizard() {
  const w = wizard;
  if (!w) return;
  // The question is optional: a track is often opened to poke at a folder
  // before there is a question worth writing down, and refusing to create one
  // stops that. An unnamed track is named after its folder and can be renamed
  // later; only a real question is recorded as the question.
  const question = w.title.trim();
  const title = question || w.cwd?.replace(/\/+$/, '').split('/').pop() || 'untitled';

  w.busy = 'creating…';
  renderWizard();

  const track = await window.omi.rpc('tracks.create', {
    title,
    question: question || null,
    cwd: w.cwd,
  });
  for (const sessionId of w.picked) {
    await window.omi.rpc('tracks.attachSession', { id: track.id, sessionId }).catch(() => {});
  }
  if (w.fresh) {
    if (wizard) {
      wizard.busy = 'opening a session…';
      renderWizard();
    }
    try {
      const r = await window.omi.rpc('tracks.startSession', { id: track.id });
      if (r?.session?.sessionId) activeSession[track.id] = `claude:${r.session.sessionId}`;
    } catch (err) {
      // The track is already real; a failed launch must not lose it. Say so and
      // leave the track open so the user can retry from the session strip.
      if (wizard) {
        wizard.busy = `track created, but the session did not start: ${(err as Error).message}`;
        renderWizard();
      }
      await refresh();
      openTrack(track.id);
      return;
    }
  }
  closeModal();
  await refresh();
  openTrack(track.id);
}

// ── attach an already-running session ───────────────────────────────────────

/**
 * Attaching is a deliberate act, so it gets a sheet with a button — not a select
 * hovering over the terminal. Sessions are filtered to the track's folder,
 * because a session from somewhere else is almost never the one you meant.
 */
let attachSheet: {
  trackId: number;
  picked: Set<string>;
  all: boolean;
  busy: boolean;
  past: any[];
  pastLoading: boolean;
  query: string;
} | null = null;

function openAttachSheet(trackId: number) {
  archiveSheet = null;
  attachSheet = {
    trackId,
    picked: new Set(),
    all: false,
    busy: false,
    past: [],
    pastLoading: true,
    query: '',
  };
  $('modal').innerHTML = ''; // a sheet left up for another track must be rebuilt, not patched
  renderModal();
  const cwd = tracks.find((x) => x.id === trackId)?.cwd ?? null;
  void fetchPast(cwd).then((rows) => {
    if (!attachSheet || attachSheet.trackId !== trackId) return;
    attachSheet.past = rows;
    attachSheet.pastLoading = false;
    renderModal();
  });
}

/**
 * Built once per open, then only the list is patched — same as the archive
 * sheet. Sessions refresh under the sheet, and rebuilding it would replace the
 * search box under the caret.
 */
function renderAttachSheet() {
  const a = attachSheet;
  if (!a) return;
  const t = tracks.find((x) => x.id === a.trackId);
  if (!t) {
    closeModal();
    return;
  }
  const host = $('modal');
  host.hidden = false;
  if (document.getElementById('att')) {
    patchAttachList();
    return;
  }

  host.innerHTML = `
    <form class="sheet" id="att">
      <div class="whead">ATTACH A SESSION</div>
      <div class="wpath">${t.cwd ? esc(t.cwd) : '<span class="muted">this track has no folder — showing everything</span>'}</div>
      <input id="atsearch" class="wsearch" value="${esc(a.query)}" placeholder="search sessions…"
             aria-label="search sessions" autocomplete="off" spellcheck="false" />
      <div class="wsess" id="atlist"></div>
      <div id="atmore"></div>
      <div class="wacts">
        <button type="button" id="acancel" class="wbtn">cancel</button>
        <button type="submit" id="atsubmit" class="wbtn primary">attach</button>
      </div>
    </form>`;

  const search = $<HTMLInputElement>('atsearch');
  search.oninput = () => {
    if (!attachSheet) return;
    attachSheet.query = search.value;
    patchAttachList();
  };
  // Enter in the search box filters; it must not submit an empty pick and close.
  search.onkeydown = (e) => {
    if (e.key === 'Enter') e.preventDefault();
  };
  $('acancel').onclick = () => closeModal();
  $<HTMLFormElement>('att').onsubmit = async (e) => {
    e.preventDefault();
    if (!attachSheet || attachSheet.busy) return;
    attachSheet.busy = true;
    patchAttachList();
    const first = [...attachSheet.picked][0];
    for (const sessionId of attachSheet.picked) {
      await window.omi.rpc('tracks.attachSession', { id: a.trackId, sessionId }).catch(() => {});
    }
    if (first) activeSession[a.trackId] = `claude:${first}`;
    saveTabs();
    closeModal();
    await refresh();
  };
  patchAttachList();
  search.focus();
}

/** Case-insensitive across whatever a row shows: name, id, state, branch, folder. */
function patchAttachList() {
  const a = attachSheet;
  const list = document.getElementById('atlist');
  const t = a ? tracks.find((x) => x.id === a.trackId) : undefined;
  if (!a || !list || !t) return;

  const linked = new Set(
    sessionRefsOf(t)
      .map((r) => liveSession(r))
      .filter(Boolean),
  );
  const linkedIds = new Set(sessionRefsOf(t).map(sessionIdOf));
  const inFolder = sessions.filter((s) => !t.cwd || a.all || s.cwd === t.cwd);
  const free = inFolder.filter((s) => !linked.has(s));
  const hiddenByFolder = sessions.length - inFolder.length;
  // Scoped to the track's own folder only — the "other folders" toggle below
  // stays live-only; browsing past sessions across arbitrary folders is a much
  // bigger feature than "attach one that ran here before".
  const freePast = a.past.filter((p) => !linkedIds.has(p.sessionId));

  const q = a.query.trim().toLowerCase();
  const hit = (...fields: unknown[]) =>
    !q || fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
  const shown = free.filter((s) => hit(s.name, s.shortId, s.sessionId, s.state, s.cwd));
  const shownPast = freePast.filter((s) => hit(s.preview, s.shortId, s.sessionId, s.gitBranch));
  const nothing = free.length === 0 && freePast.length === 0;
  const noMatch = !nothing && !!q && shown.length === 0 && shownPast.length === 0;

  list.innerHTML = `
    ${nothing && !a.pastLoading ? '<div class="muted pad">nothing left to attach here</div>' : ''}
    ${noMatch && !a.pastLoading ? `<div class="muted pad">no session matches “${esc(a.query.trim())}”</div>` : ''}
    ${shown
      .map((s) => {
        const bg = s.kind === 'background';
        return `<label class="wopt ${bg ? '' : 'off'}">
        <input type="checkbox" data-sess="${esc(s.sessionId)}" ${bg ? '' : 'disabled'}
               ${a.picked.has(s.sessionId) ? 'checked' : ''} />
        <span class="dot ${STATE_COURT[s.state] ?? 'PARKED'}"></span>
        <span class="wname">${esc(s.name ?? s.shortId)}</span>
        <span class="sstate">${esc(s.state)}${bg ? '' : ' · interactive, cannot attach'}</span>
      </label>`;
      })
      .join('')}
    ${a.pastLoading ? '<div class="muted pad">looking for past sessions…</div>' : ''}
    ${shownPast.length > 0 ? '<div class="wsub">past sessions here</div>' : ''}
    ${shownPast
      .map(
        (s) => `
      <label class="wopt past">
        <input type="checkbox" data-sess="${esc(s.sessionId)}" ${a.picked.has(s.sessionId) ? 'checked' : ''} />
        <span class="dot PARKED"></span>
        <span class="wname" title="${esc(s.preview ?? s.shortId)}">${esc(s.preview ?? s.shortId)}</span>
        <span class="sstate">${s.gitBranch ? `${esc(s.gitBranch)} · ` : ''}last active ${ago(s.lastActivityAt)} ago</span>
      </label>`,
      )
      .join('')}`;

  for (const b of list.querySelectorAll<HTMLInputElement>('[data-sess]')) {
    b.onchange = () => {
      if (!attachSheet) return;
      const id = String(b.dataset.sess);
      if (b.checked) attachSheet.picked.add(id);
      else attachSheet.picked.delete(id);
    };
  }

  $('atmore').innerHTML =
    hiddenByFolder > 0 && !a.all
      ? `<button type="button" id="aall" class="wlink">show ${hiddenByFolder} session(s) from other folders</button>`
      : '';
  const all = document.getElementById('aall');
  if (all)
    all.onclick = () => {
      if (attachSheet) {
        attachSheet.all = true;
        patchAttachList();
      }
    };
  $<HTMLButtonElement>('atsubmit').disabled = a.busy;
}

// ── archived tracks ─────────────────────────────────────────────────────────

/**
 * The archive is a sheet, not a rail section: archived work is out of the way
 * on purpose, and you only come here looking for one thing — hence the search.
 * `rows` is null until the first fetch lands.
 */
let archiveSheet: { query: string; rows: Track[] | null; error: string | null } | null = null;

function openArchiveSheet() {
  wizard = null;
  attachSheet = null;
  archiveSheet = { query: '', rows: null, error: null };
  renderModal();
  void window.omi
    .rpc('tracks.archived')
    .then((rows: Track[]) => {
      archivedTracks = rows;
      if (!archiveSheet) return;
      archiveSheet.rows = rows;
      patchArchiveList();
    })
    .catch((err) => {
      if (!archiveSheet) return;
      archiveSheet.rows = [];
      archiveSheet.error = String(err.message);
      patchArchiveList();
    });
}

/**
 * Built once per open, then only the list is patched. Rebuilding the sheet on
 * every keystroke would replace the search box under the caret.
 */
function renderArchiveSheet() {
  const a = archiveSheet;
  if (!a) return;
  const host = $('modal');
  host.hidden = false;
  if (document.getElementById('arch')) {
    patchArchiveList();
    return;
  }

  host.innerHTML = `
    <div class="sheet" id="arch" role="dialog" aria-label="archived tracks">
      <div class="whead">ARCHIVED TRACKS</div>
      <input id="asearch" value="${esc(a.query)}" placeholder="search title, question or folder…"
             aria-label="search archived tracks" autocomplete="off" spellcheck="false" />
      <div class="wsess alist" id="alist"></div>
      <div class="wacts">
        <button type="button" id="aclose" class="wbtn">close</button>
      </div>
    </div>`;

  const search = $<HTMLInputElement>('asearch');
  search.oninput = () => {
    if (!archiveSheet) return;
    archiveSheet.query = search.value;
    patchArchiveList();
  };
  $('aclose').onclick = () => closeModal();
  patchArchiveList();
  search.focus();
}

const archiveRow = (t: Track) => {
  const meta = [
    t.cwd ? shortPath(t.cwd) : 'no folder',
    t.lifecycle,
    t.archivedAt ? `archived ${ago(t.archivedAt)} ago` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<div class="arow">
    <div class="amain">
      <div class="wname" title="${esc(t.question ?? t.title)}">${esc(t.title)}</div>
      <div class="ameta" title="${esc(t.cwd ?? '')}">${esc(meta)}</div>
    </div>
    <button type="button" class="wbtn" data-restore="${t.id}" aria-label="restore ${esc(t.title)}">restore</button>
  </div>`;
};

/** Case-insensitive across title, question and folder: whatever you remember it by. */
function patchArchiveList() {
  const a = archiveSheet;
  const list = document.getElementById('alist');
  if (!a || !list) return;
  const q = a.query.trim().toLowerCase();
  const rows = (a.rows ?? []).filter(
    (t) => !q || [t.title, t.question, t.cwd].some((s) => !!s && s.toLowerCase().includes(q)),
  );

  list.innerHTML =
    a.rows === null
      ? '<div class="muted pad">loading…</div>'
      : a.error
        ? `<div class="muted pad">could not load the archive: ${esc(a.error)}</div>`
        : a.rows.length === 0
          ? '<div class="muted pad">no archived tracks</div>'
          : rows.length === 0
            ? `<div class="muted pad">no archived track matches “${esc(a.query.trim())}”</div>`
            : rows.map(archiveRow).join('');

  for (const b of list.querySelectorAll<HTMLButtonElement>('[data-restore]')) {
    b.onclick = () => {
      void restoreArchived(Number(b.dataset.restore), b);
    };
  }
}

/** Back into the done list, with the status it was archived with. */
async function restoreArchived(id: number, btn: HTMLButtonElement) {
  btn.disabled = true;
  try {
    await window.omi.rpc('tracks.restore', { id });
  } catch (err) {
    btn.disabled = false;
    btn.title = String((err as Error).message);
    return;
  }
  if (archiveSheet?.rows) archiveSheet.rows = archiveSheet.rows.filter((t) => t.id !== id);
  archivedTracks = archivedTracks.filter((t) => t.id !== id);
  patchArchiveList();
  // The button that had focus is gone; keep the keyboard in the sheet.
  document.getElementById('asearch')?.focus();
  await refreshAll();
}

/** One host element, one sheet at a time. Escape closes whichever is up. */
function renderModal() {
  if (wizard) renderWizard();
  else if (attachSheet) renderAttachSheet();
  else if (archiveSheet) renderArchiveSheet();
  else closeModal();
}
function closeModal() {
  wizard = null;
  attachSheet = null;
  archiveSheet = null;
  $('modal').hidden = true;
  $('modal').innerHTML = '';
  focusTerminal();
}

// ── pty ─────────────────────────────────────────────────────────────────────

const openedPtys = new Set<string>();
async function openPty(shortId: string, viewId: string, cwd: string | null) {
  if (openedPtys.has(viewId)) return;
  openedPtys.add(viewId);
  const t = termFor(viewId);
  try {
    const info = await window.omi.rpc('pty.open', {
      shortId,
      cols: t.term.cols,
      rows: t.term.rows,
      cwd,
    });
    t.epoch = info.epoch;
    t.expect = -1n; // accept whatever offset the replay starts at
    // The hub hands back an EXISTING view when one is already open, and that one
    // still carries the size of whoever opened it first. Re-assert ours.
    fitTerm(t);
    void window.omi
      .rpc('pty.resize', { viewId, cols: t.term.cols, rows: t.term.rows })
      .catch(() => {});
  } catch (err) {
    openedPtys.delete(viewId);
    t.term.writeln(`\r\n\x1b[31mcould not attach: ${String((err as Error).message)}\x1b[0m`);
  }
}

function openTrack(id: number) {
  if (!openTabs.includes(id)) openTabs.push(id);
  activeTab = id;
  saveTabs();
  renderAll();
  focusTerminal();
}
function closeTab(id: number) {
  openTabs = openTabs.filter((x) => x !== id);
  if (activeTab === id) activeTab = openTabs[openTabs.length - 1] ?? null;
  saveTabs();
  renderAll();
}

function renderAll() {
  renderRail();
  renderTabs();
  renderDetail();
}

/** Both halves of the binary: the open list, and the done section if it is up. */
async function refreshAll() {
  if (doneOpen) await loadDone();
  return refresh();
}

async function refresh() {
  tracks = await window.omi.rpc('tracks.list');
  // Keep the last known session list if this one fails: an empty list would
  // make every session look unattachable and tear the terminal off the screen
  // over what is usually a hiccup in one `claude agents` call.
  sessions = await window.omi.rpc('sessions.list').catch(() => sessions);
  renderAll();
  // The sheets read the session list too, so a session that appears while one is
  // open should show up in it — but only when nothing is mid-flight in there.
  if ((wizard && !wizard.busy) || (attachSheet && !attachSheet.busy)) renderModal();
}

async function boot() {
  // Still waited on: it is how we know the daemon answered before the first
  // rpc. Nothing is displayed — the version belonged in a status bar we do not
  // have room for.
  await window.omi.welcome();

  $('new').onclick = () => openWizard();
  // The tab list closes on any click outside it, like any menu would.
  window.addEventListener(
    'mousedown',
    (e) => {
      const t = e.target as HTMLElement;
      // The ▾ toggles the menu itself on click; closing it here first would
      // make that click open it again.
      if (!$('tabmenu').contains(t) && !t.closest('.tabmore')) closeTabMenu();
    },
    true,
  );
  window.addEventListener('blur', closeTabMenu);
  window.addEventListener('resize', closeTabMenu);
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      // Innermost first: the picker can sit on top of the new-track sheet.
      if (picker) {
        e.stopPropagation();
        closePicker(null);
        return;
      }
      if (!$('tabmenu').hidden) {
        closeTabMenu();
        return;
      }
      if (wizard || attachSheet || archiveSheet) {
        closeModal();
        return;
      }
      const side = document.getElementById('side');
      if (side?.classList.contains('open')) {
        side.classList.remove('open');
        focusTerminal();
      }
    },
    true,
  );

  // Load tracks BEFORE restoring tabs: the restore filters against them.
  await refresh();

  loadTabs();
  // Drop tabs whose track has since been closed or deleted.
  openTabs = openTabs.filter((id) => tracks.some((t) => t.id === id));
  if (activeTab !== null && !openTabs.includes(activeTab)) activeTab = openTabs[0] ?? null;
  // First run with nothing restored: open the most pressing track rather than
  // showing an empty stage.
  const first = tracks[0];
  if (openTabs.length === 0 && first) openTrack(first.id);
  else renderAll();

  window.addEventListener('resize', () => {
    for (const [, v] of terms) fitTerm(v);
  });

  // Tokens pile up mid-turn with no state change to push a `changed`, so while
  // the session on screen is working, re-read what it has spent. Only the usage
  // block is touched, and only when its numbers moved.
  setInterval(() => {
    const t = activeTab === null ? undefined : trackById(activeTab);
    const s = t ? currentSession(t) : undefined;
    if (!t || !s) return;
    const state = liveSession(s)?.state ?? s.state;
    if (state === 'WORKING' || state === 'STARTING') patchUsage(t, s);
  }, 5000);

  focusTerminal();
}

void boot();
