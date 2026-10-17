import fs from 'node:fs';

/** The parent of a process, from `/proc/<pid>/stat`; null once it is gone. */
function parentOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `pid (comm) state ppid …` — comm can hold spaces and parens, so read past
    // the LAST `)`.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` runs under `ancestor` — a hermes turn's process under the tmux
 * pane we started. The depth cap only guards against a loop in bad data: the
 * real chain (pane → hermes → node TUI → python gateway) is three hops.
 */
export function descendsFrom(pid: number, ancestor: number): boolean {
  let p: number | null = pid;
  for (let hops = 0; p !== null && hops < 16; hops++) {
    if (p === ancestor) return true;
    p = parentOf(p);
  }
  return false;
}
