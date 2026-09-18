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

s.destroy();
process.exit(failed > 0 ? 1 : 0);
