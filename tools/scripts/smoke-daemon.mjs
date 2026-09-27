#!/usr/bin/env node
/**
 * End-to-end smoke test for the BUILT daemon: speaks the real wire protocol to a
 * running daemon and checks that the calls the desktop depends on answer.
 *
 * Run by test.sh, which starts the daemon under Electron with XDG_RUNTIME_DIR and
 * XDG_DATA_HOME pointed at a scratch folder — so this talks to a throwaway socket
 * and database, never the user's own. Nothing here starts a Claude session.
 *
 * Exits 0 when every check passes; leaves stopping the daemon to test.sh, which
 * has to clean up even when this fails halfway.
 */
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The real codec, not a copy: a framing change must break this test too.
const { FRAME_CONTROL, FrameDecoder, PROTOCOL_VERSION, encodeControl, socketPath } = await import(
  path.join(ROOT, 'packages/protocol/dist/index.js')
);

const sock = socketPath();
const timeoutMs = Number(process.env.OMI_SMOKE_TIMEOUT_MS ?? 15_000);
const withClaude = process.env.OMI_SMOKE_CLAUDE === '1';
/**
 * Off by default: this one STARTS a real hermes session, which is the only way
 * to prove the tmux substrate end to end. It spends nothing — an idle TUI makes
 * no API call — but it does put a tmux session on the user's machine for a few
 * seconds, so it is opt-in rather than part of every `./test.sh`.
 */
const withHermes = process.env.OMI_SMOKE_HERMES === '1';

const s = net.connect(sock);
const decoder = new FrameDecoder();
let nextId = 1;
let welcome = null;
const waiting = new Map();
let onWelcome;
const welcomed = new Promise((r) => {
  onWelcome = r;
});

s.on('data', (chunk) => {
  for (const f of decoder.push(chunk)) {
    if (f.typ !== FRAME_CONTROL) continue;
    const m = f.msg;
    if (m.t === 'welcome') {
      welcome = m;
      onWelcome(m);
      continue;
    }
    const w = waiting.get(m.id);
    if (!w) continue; // broadcasts such as `changed`
    waiting.delete(m.id);
    if (m.ok) w.resolve(m.data);
    else w.reject(new Error(`${m.code}: ${m.message}`));
  }
});
s.on('error', (err) => fail(`cannot reach the daemon at ${sock}: ${err.message}`));

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    s.write(encodeControl({ t: 'rpc', id, method, ...(params ? { params } : {}) }));
  });

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  process.exit(1);
}

setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs).unref();

await new Promise((r) => s.once('connect', r));
s.write(
  encodeControl({ t: 'hello', protocol: PROTOCOL_VERSION, client: 'smoke', pid: process.pid }),
);

await check('handshake', async () => {
  await welcomed;
  assert(welcome.protocol === PROTOCOL_VERSION, `protocol ${welcome.protocol}`);
  return `daemon v${welcome.daemonVersion}, pid ${welcome.pid}`;
});

await check('daemon.ping', async () => {
  const r = await rpc('daemon.ping');
  assert(r.pong === true, 'no pong');
});

await check('tracks: create, note, list (sqlite under the Electron ABI)', async () => {
  const t = await rpc('tracks.create', { title: 'smoke test track' });
  assert(typeof t.id === 'number', 'no track id');
  await rpc('tracks.addNote', { id: t.id, text: 'written by the smoke test' });
  const notes = await rpc('tracks.notes', { id: t.id });
  assert(
    notes.some((n) => n.body === 'written by the smoke test'),
    'note did not round-trip',
  );
  const open = await rpc('tracks.list');
  assert(
    open.some((x) => x.id === t.id),
    'new track missing from the open list',
  );
  return `track ${t.id}`;
});

await check('unknown methods are refused, not dropped', async () => {
  try {
    await rpc('no.such.method');
  } catch (err) {
    assert(/unknown_method/.test(err.message), err.message);
    return;
  }
  throw new Error('an unknown method succeeded');
});

if (withClaude) {
  // Read-only: `claude agents` and a version probe. Never starts a session.
  await check('claude.compat', async () => {
    const c = await rpc('claude.compat');
    assert(c.tier !== 'unsupported', `tier ${c.tier}`);
    return `claude ${c.cliVersion}, ${c.tier}`;
  });
  await check('sessions.list', async () => {
    const list = await rpc('sessions.list');
    assert(Array.isArray(list), 'not a list');
    return `${list.length} session${list.length === 1 ? '' : 's'}`;
  });
} else {
  console.log('  skip  claude.compat, sessions.list (no claude CLI)');
}

await check('agents.list names every agent and whether it can run here', async () => {
  const agents = await rpc('agents.list');
  assert(Array.isArray(agents), 'not a list');
  const ids = agents.map((a) => a.agent).sort();
  assert(ids.join(',') === 'claude,hermes', `agents: ${ids.join(',')}`);
  for (const a of agents) {
    assert(typeof a.available === 'boolean', `${a.agent} has no availability`);
    // An unavailable agent MUST say why: the wizard shows the reason under a
    // disabled option, and an empty one reads as a bug in the app.
    assert(a.available || a.notes.length > 0, `${a.agent} is unavailable with no reason given`);
  }
  return agents
    .map((a) => `${a.agent} ${a.cliVersion}${a.available ? '' : ' (unavailable)'}`)
    .join(', ');
});

if (withHermes) {
  const cwd = process.env.OMI_SMOKE_CWD ?? ROOT;
  let track;
  let started;

  await check('hermes: a track can be created on it', async () => {
    const agents = await rpc('agents.list');
    const h = agents.find((a) => a.agent === 'hermes');
    assert(h?.available, `hermes is not available: ${h?.notes.join('; ')}`);
    track = await rpc('tracks.create', { title: 'smoke hermes', cwd, agent: 'hermes' });
    assert(track.agent === 'hermes', `agent ${track.agent}`);
    return `track ${track.id}`;
  });

  await check('hermes: a session starts, under a key of ours', async () => {
    const r = await rpc('tracks.startSession', { id: track.id });
    started = r.session;
    assert(started.agent === 'hermes', `agent ${started.agent}`);
    assert(/^[0-9a-f]{12}$/.test(started.sessionId), `key ${started.sessionId}`);
    const ref = r.track.refs.find((x) => x.externalId === `hermes:${started.sessionId}`);
    assert(ref, 'the session was not linked to its track');
    return started.sessionId;
  });

  await check('hermes: the session is listed, attachable, in the right folder', async () => {
    let found;
    for (let i = 0; i < 40 && !found; i++) {
      const list = await rpc('sessions.list');
      found = list.find((x) => x.agent === 'hermes' && x.sessionId === started.sessionId);
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }
    assert(found, 'the session never appeared in the listing');
    assert(found.kind === 'background', `kind ${found.kind}`);
    assert(found.cwd === cwd, `cwd ${found.cwd}`);
    return `${found.state} · ${found.confidence}`;
  });

  await check('hermes: a pty view opens onto it', async () => {
    const info = await rpc('pty.open', {
      shortId: started.sessionId,
      agent: 'hermes',
      cwd,
      cols: 100,
      rows: 30,
    });
    assert(info.viewId === `hermes:${started.sessionId}`, `viewId ${info.viewId}`);
    return info.viewId;
  });

  await check('hermes: finishing the track stops the session', async () => {
    await rpc('tracks.update', { id: track.id, patch: { lifecycle: 'done' } });
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      const list = await rpc('sessions.list');
      gone = !list.some((x) => x.agent === 'hermes' && x.sessionId === started.sessionId);
      if (!gone) await new Promise((r) => setTimeout(r, 250));
    }
    assert(gone, 'the session is still running after its track was finished');
  });
} else {
  console.log('  skip  hermes session lifecycle (set OMI_SMOKE_HERMES=1)');
}

s.destroy();
process.exit(failed > 0 ? 1 : 0);
