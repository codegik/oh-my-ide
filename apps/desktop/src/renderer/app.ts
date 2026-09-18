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
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

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
  ON_ME: 'ON ME', ON_CLAUDE: 'ON CLAUDE', ON_SYSTEM: 'ON SYSTEM',
  ON_THEM: 'ON THEM', PARKED: 'PARKED', DONE: 'DONE', DROPPED: 'DROPPED',
};

/** Whose court a session state puts the ball in; drives the session dot colour. */
const STATE_COURT: Record<string, string> = {
  NEEDS_INPUT: 'ON_ME', NEEDS_PERMISSION: 'ON_ME', FAILED: 'ON_ME',
  WORKING: 'ON_CLAUDE', STARTING: 'ON_CLAUDE',
  IDLE: 'PARKED', STOPPED: 'PARKED', RESUMABLE: 'PARKED', UNKNOWN: 'PARKED',
};

interface Ref {
  id: number; kind: string; externalId: string; url: string | null;
  label: string | null; state: string | null; sessionId: string;
}

interface Track {
  id: number; title: string; question: string | null; nextAction: string | null;
  court: string; courtReason: string | null; courtRule: string | null; courtSource: string;
  lifecycle: 'open' | 'done' | 'dropped';
  originUrl: string | null; lastActivityAt: number; cwd: string | null;
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
  } catch { /* a lost tab set is not worth an error */ }
}
function loadTabs() {
  try {
    const raw = localStorage.getItem('omi.tabs');
    if (!raw) return;
    const v = JSON.parse(raw);
    if (Array.isArray(v.openTabs)) openTabs = v.openTabs.filter((n: unknown) => typeof n === 'number');
    if (typeof v.activeTab === 'number') activeTab = v.activeTab;
    if (v.activeSession && typeof v.activeSession === 'object') activeSession = v.activeSession;
  } catch { /* corrupt or unavailable: start clean */ }
}

/**
 * THE ONE NON-OBVIOUS RULE: terminals live outside the view layer, in this map.
 * Re-rendering a tab must never dispose a Terminal — that would throw away
 * scrollback and force a full replay on every tab switch. The same map is what
 * makes switching sessions inside a track free: each session keeps its own live
 * terminal, detached from the DOM but never torn down.
 */
const terms = new Map<string, { term: Terminal; fit: FitAddon; el: HTMLDivElement; expect: bigint; epoch: number }>();

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

function termFor(viewId: string) {
  let t = terms.get(viewId);
  if (t) return t;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono","Fira Code",monospace',
    fontSize: 14, scrollback: 10_000, cursorBlink: true,
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
   */
  term.attachCustomKeyEventHandler((e) => {
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
  if (epoch !== t.epoch) { t.term.reset(); t.epoch = epoch; t.expect = off; }
  if (t.expect >= 0n && off !== t.expect) {
    // A gap means we lost bytes; a partial repaint would be worse than a reset.
    t.term.reset();
  }
  t.term.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  t.expect = off + BigInt((bytes as Uint8Array).length);
});

/**
 * The ONLY thing that refreshes the UI on its own. There is no polling here on
 * purpose: the daemon already watches Claude's supervisor and pushes `changed`
 * when a session state or a track actually moves, so a timer would just be a
 * second, worse copy of that — one that repaints while you are typing.
 */
window.omi.onEvent((msg) => {
  if (msg?.t === 'changed') { void refresh(); return; }
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
const liveSession = (ref: { externalId: string }) =>
  sessions.find((s) => s.sessionId === sessionIdOf(ref));
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

const railRow = (t: Track) => `
  <div class="titem ${activeTab === t.id ? 'sel' : ''}" data-id="${t.id}">
    <span class="dot ${dotOf(t)}"></span>
    <span class="tname">${esc(t.title)}</span>
    <span class="tago">${ago(t.lastActivityAt)}</span>
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

  const sig = tracks.map((t) => `${t.id}/${t.title}/${dotOf(t)}/${ago(t.lastActivityAt)}`).join(',')
    + `|${activeTab}|${doneOpen}|${closedTracks.map((t) => t.id).join(',')}`;
  if (railSig === sig) return;
  railSig = sig;

  const done = `
    <div class="donehead" id="donetoggle" title="finished tracks">
      <span class="caret">${doneOpen ? '⌄' : '›'}</span>
      <span>done</span>
      <span class="tago">${doneOpen ? closedTracks.length || '' : ''}</span>
    </div>
    ${doneOpen ? closedTracks.map(railRow).join('') || '<div class="pad muted">nothing finished yet</div>' : ''}`;

  $('railbody').innerHTML = tracks.length === 0 && !doneOpen
    ? '<div class="empty">No tracks yet.<br><br>Press <b>+ track</b> to make one.</div>' + done
    : `<div class="railhead">
         <span>${tracks.length} open</span>
         ${needs > 0 ? `<span class="needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : ''}
       </div>
       ${tracks.map(railRow).join('')}
       ${done}`;

  for (const el of document.querySelectorAll<HTMLElement>('.titem')) {
    el.onclick = () => openTrack(Number(el.dataset.id));
  }
  $('donetoggle').onclick = () => { void toggleDone(); };
}

/** Finished tracks are fetched on demand — see `tracks.closed` in the daemon. */
async function toggleDone() {
  doneOpen = !doneOpen;
  if (doneOpen) closedTracks = await window.omi.rpc('tracks.closed').catch(() => []);
  renderRail();
}

function renderTabs() {
  const sig = openTabs
    .map((id) => {
      const t = tracks.find((x) => x.id === id);
      return `${id}/${t?.title ?? ''}/${t ? dotOf(t) : ''}`;
    })
    .join(',') + `|${activeTab}`;
  if (tabsSig === sig) return;
  tabsSig = sig;

  $('tabs').innerHTML = openTabs.map((id) => {
    const t = tracks.find((x) => x.id === id);
    if (!t) return '';
    return `<div class="tab ${activeTab === id ? 'on' : ''}" data-id="${id}">
      <span class="dot ${dotOf(t)}"></span>${esc(t.title)}<span class="x" data-close="${id}">×</span></div>`;
  }).join('');

  for (const el of document.querySelectorAll<HTMLElement>('.tab')) {
    el.onclick = (e) => {
      const close = (e.target as HTMLElement).dataset.close;
      if (close) { closeTab(Number(close)); e.stopPropagation(); return; }
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
  sig: { head: string; sess: string; side: string; time: string };
} | null = null;

const EMPTY_SIG = { head: '', sess: '', side: '', time: '' };

const trackById = (id: number) =>
  tracks.find((x) => x.id === id) ?? closedTracks.find((x) => x.id === id);

const DETAIL_SKELETON = `
  <div class="thead">
    <div class="trow">
      <h2 id="dtitle"></h2>
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
      <div id="scopebar"></div>
      <input id="paste" placeholder="paste a PR / Slack / Jira link, or PAY-123" />
      <div id="sidetop"></div>
      <div class="shead">TIMELINE</div>
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
    if (!t || (t.cwd && sessionRefsOf(t).length > 0)) return;
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
    window.omi.rpc('tracks.addLink', { id, text: el.value, sessionId: session?.externalId ?? '' })
      .then(() => { el.value = ''; return refresh(); })
      .catch((err) => { el.value = ''; el.placeholder = err.message; });
  };

  $<HTMLInputElement>('note').onkeydown = (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const el = e.target as HTMLInputElement;
    void window.omi.rpc('tracks.addNote', { id, text: el.value })
      .then(() => { el.value = ''; return refresh(); });
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
        void window.omi.rpc('tracks.pin', { id, court: v ? v : null, kind: 'hard' })
          .then(() => { pop.hidden = true; return refresh(); });
      };
    }
    for (const b of pop.querySelectorAll<HTMLElement>('[data-life]')) {
      b.onclick = () => {
        void window.omi.rpc('tracks.update', { id, patch: { lifecycle: b.dataset.life } })
          .then(() => { pop.hidden = true; closeTab(id); return refresh(); });
      };
    }
    // Scoped to this popover, and replaced on the next open, so it cannot pile
    // up one listener per poll the way a render-time listener would.
    const away = () => { pop.hidden = true; };
    setTimeout(() => document.addEventListener('click', away, { once: true }), 0);
  };
}

/**
 * Title and folder, on one line. The question and the next action are still on
 * the track, they just do not earn four rows above the terminal — the question
 * rides along as the title's tooltip.
 */
function patchHead(t: Track) {
  const m = mounted as NonNullable<typeof mounted>;
  const sig = `${t.title}|${t.question}|${t.court}|${t.lifecycle}|${t.cwd}|${sessionRefsOf(t).length > 0}`;
  if (m.sig.head === sig) return;
  m.sig.head = sig;

  const title = $('dtitle');
  title.textContent = t.title;
  title.title = t.question ?? t.title;

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
    void window.omi.rpc('tracks.update', {
      id: t.id,
      patch: { lifecycle: closed ? 'open' : 'done' },
    }).then(() => {
      if (!closed) closeTab(t.id);
      return refreshAll();
    });
  };

  const folder = $('folder');
  const fixed = !!t.cwd && sessionRefsOf(t).length > 0;
  folder.className = fixed ? 'folder fixed' : 'folder';
  folder.title = t.cwd
    ? fixed
      ? `${t.cwd} — fixed: this track's sessions run here`
      : `${t.cwd} — click to change`
    : 'no folder set — click to choose one';
  folder.textContent = t.cwd ? shortPath(t.cwd) : 'choose a folder…';
}

/** One chip per session in the track, plus the buttons that add another. */
function patchSessbar(t: Track, session: Ref | undefined) {
  const m = mounted as NonNullable<typeof mounted>;
  const list = sessionRefsOf(t);
  const sig = list
    .map((r) => {
      const held = t.refs.filter((x) => x.kind !== 'claude_session' && x.sessionId === r.externalId).length;
      return `${r.externalId}:${r.label}:${r.state ?? liveSession(r)?.state ?? ''}:${held}`;
    })
    .join(',') + `|${session?.externalId ?? ''}|${starting === t.id}`;
  if (m.sig.sess === sig) return;
  m.sig.sess = sig;

  $('sessbar').innerHTML = `
    ${list.map((r) => {
      const state = r.state ?? liveSession(r)?.state ?? '';
      // An empty session is disposable; one holding refs is not, because they
      // live in its scope and would go with it.
      const holds = t.refs.filter((x) => x.kind !== 'claude_session' && x.sessionId === r.externalId).length;
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
        ${holds === 0
          ? `<span class="x" data-drop="${r.id}" title="remove this session from the track">×</span>`
          : ''}
      </div>`;
    }).join('')}
    <button class="sadd" id="addsess" title="open another session in this track">${starting === t.id ? 'starting…' : '+ session'}</button>
    <button class="sadd" id="attachsess" title="attach a session that is already running">attach…</button>
    <button id="sidetoggle" class="sidetoggle" title="refs">refs ↔</button>`;

  for (const el of document.querySelectorAll<HTMLElement>('.sess')) {
    el.onclick = (e) => {
      const drop = (e.target as HTMLElement).dataset.drop;
      if (drop) {
        e.stopPropagation();
        void window.omi.rpc('tracks.removeRef', { id: t.id, refId: Number(drop) })
          .then(() => {
            // Fall back to whatever session is left.
            delete activeSession[t.id];
            saveTabs();
            return refresh();
          })
          .catch((err) => { el.title = String(err.message); });
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
      ${r.url ? `<a class="go" data-url="${esc(r.url)}">↗</a>` : ''}
      <a class="rm" data-ref="${r.id}" title="unlink">×</a>
    </div>`;

  // The heading names the scope, and the box you type into sits above the list
  // it adds to, so what you add appears under your cursor.
  $('scopebar').innerHTML = session
    ? `<div class="shead">REFS · <b>${esc(session.label ?? shortIdOf(sessionIdOf(session)))}</b></div>`
    : '<div class="shead">REFS</div>';

  $('sidetop').innerHTML = `
    <div id="refs">
      ${refs.length === 0
        ? `<div class="muted pad">nothing linked to ${session ? 'this session' : 'this track'} yet</div>`
        : ''}
      ${refs.map(refRow).join('')}
    </div>`;

  for (const el of document.querySelectorAll<HTMLElement>('.go')) {
    el.onclick = () => window.omi.openExternal(el.dataset.url as string);
  }
  for (const el of document.querySelectorAll<HTMLElement>('.rm')) {
    el.onclick = () => void window.omi.rpc('tracks.removeRef', { id: t.id, refId: Number(el.dataset.ref) })
      .then(refresh)
      .catch((err) => { el.title = String(err.message); });
  }
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

function mountTerminal(t: Track, session: Ref | undefined) {
  const m = mounted as NonNullable<typeof mounted>;
  const attachable = session ? isAttachable(session) : false;
  const viewId = session && attachable ? `claude:${shortIdOf(sessionIdOf(session))}` : null;
  const key = viewId ?? `none:${session?.externalId ?? ''}:${liveSession(session ?? { externalId: '' })?.kind ?? ''}`;
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
    void openPty(shortIdOf(sessionIdOf(session)), viewId, t.cwd);
    // Switching session is a deliberate act, so put the cursor where the user
    // is now looking — unless they are mid-sentence in one of the fields, which
    // focusTerminal() checks for us.
    focusTerminal();
    requestAnimationFrame(() => fitTerm(v));
    return;
  }

  if (session) {
    const live = liveSession(session);
    wrap.innerHTML = `<div class="empty">
      <b>${esc(session.label ?? '')}</b> is ${live ? `an ${esc(live.kind)} session` : 'no longer running'}.<br><br>
      ${live
        ? 'Only background sessions can be attached — an interactive one already belongs to a terminal you opened.'
        : 'Its transcript is kept, so it can be resumed.'}
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="empty">
    No session in this track yet.<br><br>
    <b>+ session</b> starts one in ${t.cwd ? esc(t.cwd) : 'a folder you choose'},
    <b>attach…</b> picks one that is already running.
    </div>`;
}

function patchTimeline(t: Track) {
  void window.omi.rpc('tracks.timeline', { id: t.id }).then((rows: any[]) => {
    const el = document.getElementById('timeline');
    const m = mounted;
    if (!el || !m || m.trackId !== t.id) return;
    const html = rows.map((r) => `
      <div class="ev"><span class="evt">${ago(r.occurred_at)}</span>
      <span class="evb">${esc(r.title)}</span></div>`).join('') || '<div class="muted pad">nothing yet</div>';
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
      resolve, cache: new Map([['~/', root.dirs]]), matches: [], sel: -1, seq: 0,
      away, restore: document.activeElement,
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
  list.innerHTML = p.matches.slice(0, PICKER_ROWS).map((d, i) => `
    <div class="fprow ${i === p.sel ? 'on' : ''}" data-i="${i}">${esc(d)}<span class="muted">/</span></div>`)
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
  if (!r) { setPickerHint(`${typed} is not a folder`); return; }
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
}
let wizard: Wizard | null = null;

function openWizard() {
  const recent = [...new Set(tracks.map((t) => t.cwd).filter((c): c is string => !!c))];
  attachSheet = null;
  wizard = { title: '', cwd: recent[0] ?? null, picked: new Set(), fresh: false, busy: null, focused: false };
  renderWizard();
}

function renderWizard() {
  const w = wizard;
  const host = $('modal');
  if (!w) return;
  host.hidden = false;

  const recent = [...new Set(tracks.map((t) => t.cwd).filter((c): c is string => !!c))].slice(0, 6);
  const here = w.cwd
    ? sessions.filter((s) => s.cwd === w.cwd)
    : [];

  host.innerHTML = `
    <form class="sheet" id="wiz">
      <div class="whead">NEW TRACK</div>

      <label class="wlab">what is the question?</label>
      <input id="wtitle" value="${esc(w.title)}" placeholder="a question works best…" />

      <label class="wlab">folder</label>
      <div class="wrow">
        <button type="button" id="wpick" class="wbtn">${w.cwd ? 'change…' : 'choose a folder…'}</button>
        <span class="wpath">${w.cwd ? esc(w.cwd) : '<span class="muted">none yet</span>'}</span>
      </div>
      ${recent.length > 0 ? `<div class="wrecent">${recent.map((c) => `
        <button type="button" class="chip ${c === w.cwd ? 'on' : ''}" data-cwd="${esc(c)}">${esc(c.split('/').pop() ?? c)}</button>`).join('')}</div>` : ''}

      <label class="wlab">sessions in this folder</label>
      <div class="wsess">
        ${!w.cwd ? '<div class="muted pad">choose a folder first</div>' : ''}
        ${w.cwd && here.length === 0 ? '<div class="muted pad">none running here yet</div>' : ''}
        ${here.map((s) => {
          const bg = s.kind === 'background';
          return `<label class="wopt ${bg ? '' : 'off'}">
            <input type="checkbox" data-sess="${esc(s.sessionId)}" ${bg ? '' : 'disabled'}
                   ${w.picked.has(s.sessionId) ? 'checked' : ''} />
            <span class="dot ${STATE_COURT[s.state] ?? 'PARKED'}"></span>
            <span class="wname">${esc(s.name ?? s.shortId)}</span>
            <span class="sstate">${esc(s.state)}${bg ? '' : ' · interactive, cannot attach'}</span>
          </label>`;
        }).join('')}
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
        <button type="submit" class="wbtn go" ${w.busy ? 'disabled' : ''}>create track</button>
      </div>
    </form>`;

  /**
   * The title is bound to state, not to the DOM: the session list can refresh
   * under the sheet, and a re-render must not drop what was typed. Focus is
   * taken once, for the same reason.
   */
  const title = document.getElementById('wtitle') as HTMLInputElement | null;
  if (title) title.oninput = () => { if (wizard) wizard.title = title.value; };
  if (!w.busy && !w.focused) {
    w.focused = true;
    $('wtitle').focus();
  }

  $('wpick').onclick = async () => {
    const dir = await pickFolder($('wpick'), w.cwd);
    if (!dir || !wizard) return;
    wizard.cwd = dir;
    wizard.picked.clear();
    renderWizard();
  };
  for (const c of document.querySelectorAll<HTMLElement>('.chip')) {
    c.onclick = () => {
      if (!wizard) return;
      wizard.cwd = String(c.dataset.cwd);
      wizard.picked.clear();
      renderWizard();
    };
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
  if (fresh) fresh.onchange = () => {
    if (!wizard) return;
    wizard.fresh = fresh.checked;
    renderWizard();
  };
  $('wcancel').onclick = () => closeModal();
  $<HTMLFormElement>('wiz').onsubmit = (e) => { e.preventDefault(); void createFromWizard(); };
}

async function createFromWizard() {
  const w = wizard;
  if (!w) return;
  const title = w.title.trim();
  if (!title) return;

  w.busy = 'creating…';
  renderWizard();

  const track = await window.omi.rpc('tracks.create', { title, question: title, cwd: w.cwd });
  for (const sessionId of w.picked) {
    await window.omi.rpc('tracks.attachSession', { id: track.id, sessionId }).catch(() => {});
  }
  if (w.fresh) {
    if (wizard) { wizard.busy = 'opening a session…'; renderWizard(); }
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
let attachSheet: { trackId: number; picked: Set<string>; all: boolean; busy: boolean } | null = null;

function openAttachSheet(trackId: number) {
  attachSheet = { trackId, picked: new Set(), all: false, busy: false };
  renderModal();
}

function renderAttachSheet() {
  const a = attachSheet;
  if (!a) return;
  const t = tracks.find((x) => x.id === a.trackId);
  if (!t) { closeModal(); return; }

  const linked = new Set(sessionRefsOf(t).map((r) => sessionIdOf(r)));
  const inFolder = sessions.filter((s) => !t.cwd || a.all || s.cwd === t.cwd);
  const free = inFolder.filter((s) => !linked.has(s.sessionId));
  const hiddenByFolder = sessions.length - inFolder.length;

  $('modal').hidden = false;
  $('modal').innerHTML = `
    <form class="sheet" id="att">
      <div class="whead">ATTACH A SESSION</div>
      <div class="wpath">${t.cwd ? esc(t.cwd) : '<span class="muted">this track has no folder — showing everything</span>'}</div>
      <div class="wsess">
        ${free.length === 0 ? '<div class="muted pad">nothing left to attach here</div>' : ''}
        ${free.map((s) => {
          const bg = s.kind === 'background';
          return `<label class="wopt ${bg ? '' : 'off'}">
            <input type="checkbox" data-sess="${esc(s.sessionId)}" ${bg ? '' : 'disabled'}
                   ${a.picked.has(s.sessionId) ? 'checked' : ''} />
            <span class="dot ${STATE_COURT[s.state] ?? 'PARKED'}"></span>
            <span class="wname">${esc(s.name ?? s.shortId)}</span>
            <span class="sstate">${esc(s.state)}${bg ? '' : ' · interactive, cannot attach'}</span>
          </label>`;
        }).join('')}
      </div>
      ${hiddenByFolder > 0 && !a.all
        ? `<button type="button" id="aall" class="wlink">show ${hiddenByFolder} session(s) from other folders</button>`
        : ''}
      <div class="wacts">
        <button type="button" id="acancel" class="wbtn">cancel</button>
        <button type="submit" class="wbtn go" ${a.busy ? 'disabled' : ''}>attach</button>
      </div>
    </form>`;

  for (const b of document.querySelectorAll<HTMLInputElement>('[data-sess]')) {
    b.onchange = () => {
      if (!attachSheet) return;
      const id = String(b.dataset.sess);
      if (b.checked) attachSheet.picked.add(id);
      else attachSheet.picked.delete(id);
    };
  }
  const all = document.getElementById('aall');
  if (all) all.onclick = () => { if (attachSheet) { attachSheet.all = true; renderModal(); } };
  $('acancel').onclick = () => closeModal();
  $<HTMLFormElement>('att').onsubmit = async (e) => {
    e.preventDefault();
    if (!attachSheet || attachSheet.busy) return;
    attachSheet.busy = true;
    const first = [...attachSheet.picked][0];
    for (const sessionId of attachSheet.picked) {
      await window.omi.rpc('tracks.attachSession', { id: a.trackId, sessionId }).catch(() => {});
    }
    if (first) activeSession[a.trackId] = `claude:${first}`;
    saveTabs();
    closeModal();
    await refresh();
  };
}

/** One host element, one of the two sheets. Escape closes whichever is up. */
function renderModal() {
  if (wizard) renderWizard();
  else if (attachSheet) renderAttachSheet();
  else closeModal();
}
function closeModal() {
  wizard = null;
  attachSheet = null;
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
      shortId, cols: t.term.cols, rows: t.term.rows, cwd,
    });
    t.epoch = info.epoch;
    t.expect = -1n; // accept whatever offset the replay starts at
    // The hub hands back an EXISTING view when one is already open, and that one
    // still carries the size of whoever opened it first. Re-assert ours.
    fitTerm(t);
    void window.omi.rpc('pty.resize', { viewId, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
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

function renderAll() { renderRail(); renderTabs(); renderDetail(); }

/** Both halves of the binary: the open list, and the done section if it is up. */
async function refreshAll() {
  if (doneOpen) closedTracks = await window.omi.rpc('tracks.closed').catch(() => closedTracks);
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
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Innermost first: the picker can sit on top of the new-track sheet.
    if (picker) { e.stopPropagation(); closePicker(null); return; }
    if (wizard || attachSheet) { closeModal(); return; }
    const side = document.getElementById('side');
    if (side?.classList.contains('open')) {
      side.classList.remove('open');
      focusTerminal();
    }
  }, true);

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

  focusTerminal();
}

void boot();
