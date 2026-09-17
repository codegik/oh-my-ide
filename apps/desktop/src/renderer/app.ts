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

const COURTS = ['ON_ME', 'ON_CLAUDE', 'ON_SYSTEM', 'ON_THEM', 'PARKED'] as const;
const COURT_LABEL: Record<string, string> = {
  ON_ME: 'ON ME', ON_CLAUDE: 'ON CLAUDE', ON_SYSTEM: 'ON SYSTEM',
  ON_THEM: 'ON THEM', PARKED: 'PARKED',
};

interface Track {
  id: number; title: string; question: string | null; nextAction: string | null;
  court: string; courtReason: string | null; courtRule: string | null; courtSource: string;
  originUrl: string | null; lastActivityAt: number;
  refs: { id: number; kind: string; externalId: string; url: string | null; label: string | null; state: string | null }[];
}

let tracks: Track[] = [];
let openTabs: number[] = [];
let activeTab: number | null = null;

/**
 * Open tabs survive a restart. Closing the window should not cost you the set of
 * things you were working on — that is the same complaint as losing a terminal.
 * localStorage can throw (private windows, blocked site data), so never let it
 * break boot.
 */
function saveTabs() {
  try {
    localStorage.setItem('omi.tabs', JSON.stringify({ openTabs, activeTab }));
  } catch { /* a lost tab set is not worth an error */ }
}
function loadTabs() {
  try {
    const raw = localStorage.getItem('omi.tabs');
    if (!raw) return;
    const v = JSON.parse(raw);
    if (Array.isArray(v.openTabs)) openTabs = v.openTabs.filter((n: unknown) => typeof n === 'number');
    if (typeof v.activeTab === 'number') activeTab = v.activeTab;
  } catch { /* corrupt or unavailable: start clean */ }
}
let sessions: any[] = [];

/**
 * THE ONE NON-OBVIOUS RULE: terminals live outside the view layer, in this map.
 * Re-rendering a tab must never dispose a Terminal — that would throw away
 * scrollback and force a full replay on every tab switch.
 */
const terms = new Map<string, { term: Terminal; fit: FitAddon; el: HTMLDivElement; expect: bigint; epoch: number }>();

function termFor(viewId: string) {
  let t = terms.get(viewId);
  if (t) return t;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono","Fira Code",monospace',
    fontSize: 12, scrollback: 10_000, cursorBlink: true,
    theme: { background: '#0b0d12', foreground: '#e6e9f0' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'termhost';
  term.open(el);
  term.onData((data) => window.omi.ptyInput(viewId, new TextEncoder().encode(data)));
  t = { term, fit, el, expect: -1n, epoch: 0 };
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

window.omi.onEvent((msg) => { if (msg?.t === 'changed') void refresh(); });

// ── rendering ───────────────────────────────────────────────────────────────

function renderRail() {
  const groups = COURTS.map((c) => [c, tracks.filter((t) => t.court === c)] as const)
    .filter(([, list]) => list.length > 0);

  $('railbody').innerHTML = groups.length === 0
    ? '<div class="empty">No tracks yet.<br><br>Press <b>+ new</b> to make one.</div>'
    : groups.map(([court, list]) => `
        <div class="group">
          <div class="ghead"><span>${COURT_LABEL[court]}</span><span>${list.length}</span></div>
          ${list.map((t) => `
            <div class="titem ${activeTab === t.id ? 'sel' : ''}" data-id="${t.id}">
              <span class="dot ${court}"></span>
              <span class="tname">${esc(t.title)}</span>
              <span class="tago">${ago(t.lastActivityAt)}</span>
            </div>`).join('')}
        </div>`).join('');

  for (const el of document.querySelectorAll<HTMLElement>('.titem')) {
    el.onclick = () => openTrack(Number(el.dataset.id));
  }
}

function renderTabs() {
  $('tabs').innerHTML = openTabs.map((id) => {
    const t = tracks.find((x) => x.id === id);
    if (!t) return '';
    return `<div class="tab ${activeTab === id ? 'on' : ''}" data-id="${id}">
      <span class="dot ${t.court}"></span>${esc(t.title)}<span class="x" data-close="${id}">×</span></div>`;
  }).join('');

  for (const el of document.querySelectorAll<HTMLElement>('.tab')) {
    el.onclick = (e) => {
      const close = (e.target as HTMLElement).dataset.close;
      if (close) { closeTab(Number(close)); e.stopPropagation(); return; }
      activeTab = Number(el.dataset.id);
      saveTabs();
      renderAll();
    };
  }
}

const sessionIdOf = (ref: { externalId: string }) => ref.externalId.replace(/^claude:/, '');

/**
 * `claude attach` only works on BACKGROUND jobs. An interactive session is a
 * terminal someone else already owns; there is nothing for us to attach to.
 */
const liveSession = (ref: { externalId: string }) =>
  sessions.find((s) => s.sessionId === sessionIdOf(ref));
const isAttachable = (ref: { externalId: string }) => liveSession(ref)?.kind === 'background';

function renderDetail() {
  const t = tracks.find((x) => x.id === activeTab);
  const host = $('detail');
  if (!t) {
    host.innerHTML = '<div class="empty">Open a track from the list, or create one.</div>';
    return;
  }

  const sessionRefs = t.refs.filter((r) => r.kind === 'claude_session');
  // Prefer one we can actually attach to; fall back to the first so the UI can
  // explain why there is no terminal rather than silently showing nothing.
  const session = sessionRefs.find(isAttachable) ?? sessionRefs[0];
  const attachable = session ? isAttachable(session) : false;
  host.innerHTML = `
    <div class="thead">
      <div class="trow">
        <h2>${esc(t.title)}</h2>
        <span class="court ${t.court}" id="whybtn" title="why?">${COURT_LABEL[t.court] ?? t.court}</span>
      </div>
      ${t.question ? `<div class="q">${esc(t.question)}</div>` : ''}
      <div class="next">→ <input id="next" value="${esc(t.nextAction ?? '')}"
           placeholder="one line: what is the next action?" /></div>
    </div>
    <div class="body">
      <div class="left">
        <div id="termwrap" class="termwrap"></div>
        <div class="termbar">
          ${session
            ? `<span class="muted">${esc(session.label ?? '')} · ${esc(session.state ?? '')}</span>
               <button id="eject">↗ open in my terminal</button>`
            : `<span class="muted">no session attached</span>
               <select id="pick"><option value="">attach a session…</option>
                 ${sessions.map((s) => `<option value="${esc(s.sessionId)}" ${s.kind === 'background' ? '' : 'disabled'}>${esc(s.name ?? s.shortId)} · ${esc(s.state)}${s.kind === 'background' ? '' : ' (interactive — cannot attach)'}</option>`).join('')}
               </select>`}
        </div>
      </div>
      <div class="side">
        <div class="shead">REFS</div>
        <div id="refs">
          ${t.refs.length === 0 ? '<div class="muted pad">nothing linked yet</div>' : ''}
          ${t.refs.map((r) => `
            <div class="ref">
              <span class="rk">${esc(r.kind.replace('_', ' '))}</span>
              <span class="rl">${esc(r.label ?? r.externalId)}</span>
              ${r.state ? `<span class="rs">${esc(r.state)}</span>` : ''}
              ${r.url ? `<a class="go" data-url="${esc(r.url)}">↗</a>` : ''}
              <a class="rm" data-ref="${r.id}">×</a>
            </div>`).join('')}
        </div>
        <input id="paste" placeholder="paste a PR / Slack / Jira link, or PAY-123" />
        <div class="shead">TIMELINE</div>
        <div id="timeline" class="timeline"></div>
        <input id="note" placeholder="add a note…" />
      </div>
    </div>`;

  // Re-attach the persistent terminal element; never recreate the Terminal.
  if (session && attachable) {
    const shortId = sessionIdOf(session).replace(/-/g, '').slice(0, 8);
    const viewId = `claude:${shortId}`;
    const t2 = termFor(viewId);
    $('termwrap').appendChild(t2.el);
    void openPty(shortId, viewId);
    const eject = document.getElementById('eject');
    if (eject) eject.onclick = () => window.omi.rpc('sessions.attachCommand', { shortId })
      .then((c) => navigator.clipboard.writeText(`${c.file} ${c.args.join(' ')}`));
  } else if (session) {
    const live = liveSession(session);
    $('termwrap').innerHTML = `<div class="empty">
      <b>${esc(session.label ?? '')}</b> is ${live ? `an ${esc(live.kind)} session` : 'no longer running'}.<br><br>
      ${live
        ? 'Only background sessions can be attached — an interactive one already belongs to a terminal you opened.'
        : 'Its transcript is kept, so it can be resumed.'}
      </div>`;
  } else {
    const pick = $<HTMLSelectElement>('pick');
    if (pick) pick.onchange = () => {
      if (pick.value) void window.omi.rpc('tracks.attachSession', { id: t.id, sessionId: pick.value }).then(refresh);
    };
  }

  $<HTMLInputElement>('next').onchange = (e) =>
    void window.omi.rpc('tracks.update', { id: t.id, patch: { nextAction: (e.target as HTMLInputElement).value } }).then(refresh);

  $<HTMLInputElement>('paste').onkeydown = (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const el = e.target as HTMLInputElement;
    window.omi.rpc('tracks.addLink', { id: t.id, text: el.value })
      .then(() => { el.value = ''; return refresh(); })
      .catch((err) => { el.value = ''; el.placeholder = err.message; });
  };

  $<HTMLInputElement>('note').onkeydown = (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const el = e.target as HTMLInputElement;
    void window.omi.rpc('tracks.addNote', { id: t.id, text: el.value }).then(() => { el.value = ''; return refresh(); });
  };

  for (const el of document.querySelectorAll<HTMLElement>('.go')) {
    el.onclick = () => window.omi.openExternal(el.dataset.url as string);
  }
  for (const el of document.querySelectorAll<HTMLElement>('.rm')) {
    el.onclick = () => void window.omi.rpc('tracks.removeRef', { id: t.id, refId: Number(el.dataset.ref) }).then(refresh);
  }
  // NEVER alert()/confirm()/prompt() here: a modal dialog blocks the whole
  // renderer, freezing every terminal in every tab until it is dismissed.
  $('whybtn').onclick = (e) => {
    e.stopPropagation();
    const pop = $('why');
    pop.innerHTML = `
      <div class="whyhead">why is this ${esc(COURT_LABEL[t.court] ?? t.court)}?</div>
      <div class="whyrow"><span>rule</span><b>${esc(t.courtRule)}</b></div>
      <div class="whyrow"><span>source</span><b>${esc(t.courtSource)}</b></div>
      <div class="whyreason">${esc(t.courtReason ?? '')}</div>
      <div class="whyacts">
        <button data-pin="ON_THEM">pin ON THEM</button>
        <button data-pin="">unpin</button>
        <button data-life="done">mark done</button>
        <button data-life="dropped">drop</button>
      </div>`;
    pop.hidden = false;
    for (const b of pop.querySelectorAll<HTMLElement>('[data-pin]')) {
      b.onclick = () => {
        const v = b.dataset.pin;
        void window.omi.rpc('tracks.pin', { id: t.id, court: v ? v : null, kind: 'hard' })
          .then(() => { pop.hidden = true; return refresh(); });
      };
    }
    for (const b of pop.querySelectorAll<HTMLElement>('[data-life]')) {
      b.onclick = () => {
        void window.omi.rpc('tracks.update', { id: t.id, patch: { lifecycle: b.dataset.life } })
          .then(() => { pop.hidden = true; closeTab(t.id); return refresh(); });
      };
    }
  };
  document.addEventListener('click', () => { $('why').hidden = true; }, { once: true });

  void window.omi.rpc('tracks.timeline', { id: t.id }).then((rows: any[]) => {
    const el = document.getElementById('timeline');
    if (!el) return;
    el.innerHTML = rows.map((r) => `
      <div class="ev"><span class="evt">${ago(r.occurred_at)}</span>
      <span class="evb">${esc(r.title)}</span></div>`).join('') || '<div class="muted pad">nothing yet</div>';
  });

  requestAnimationFrame(() => {
    for (const [, v] of terms) if (v.el.isConnected) v.fit.fit();
  });
}

const openedPtys = new Set<string>();
async function openPty(shortId: string, viewId: string) {
  if (openedPtys.has(viewId)) return;
  openedPtys.add(viewId);
  const t = termFor(viewId);
  try {
    const info = await window.omi.rpc('pty.open', {
      shortId, cols: t.term.cols, rows: t.term.rows,
    });
    t.epoch = info.epoch;
    t.expect = -1n; // accept whatever offset the replay starts at
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
}
function closeTab(id: number) {
  openTabs = openTabs.filter((x) => x !== id);
  if (activeTab === id) activeTab = openTabs[openTabs.length - 1] ?? null;
  saveTabs();
  renderAll();
}

function renderAll() { renderRail(); renderTabs(); renderDetail(); }

async function refresh() {
  tracks = await window.omi.rpc('tracks.list');
  sessions = await window.omi.rpc('sessions.list').catch(() => []);
  renderAll();
}

async function boot() {
  const w = await window.omi.welcome();
  $('daemon').textContent = w
    ? `daemon v${w.daemonVersion} · claude ${w.claude.cliVersion}`
    : 'daemon starting…';

  // Same reason as the popover: no prompt(). An inline input cannot freeze the app.
  const newInput = $<HTMLInputElement>('newtrack');
  $('new').onclick = () => {
    newInput.hidden = false;
    newInput.focus();
  };
  newInput.onkeydown = async (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Escape') { newInput.hidden = true; newInput.value = ''; return; }
    if (ev.key !== 'Enter' || !newInput.value.trim()) return;
    const title = newInput.value.trim();
    newInput.value = '';
    newInput.hidden = true;
    const t = await window.omi.rpc('tracks.create', { title, question: title });
    await refresh();
    openTrack(t.id);
  };

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
    for (const [, v] of terms) if (v.el.isConnected) v.fit.fit();
  });
  setInterval(refresh, 5000);
}

void boot();
