import type { Ask } from '@omi/core';

/**
 * WHAT THE TRAY SAYS, worked out without an Electron display anywhere near it.
 *
 * Wording and ordering are the part of a notifier that is actually easy to get
 * wrong — an unreadable row, a truncation that drops the urgent one — and they
 * are exactly the part a running app is slowest to test. So they live here,
 * pure, and `attention.ts` does nothing but hand the result to the OS.
 */

export interface TrayItem {
  label: string;
  ask: Ask;
}

export interface TrayModel {
  /** Which icon to fly, and whether the dock/taskbar badge shows a number. */
  attention: boolean;
  count: number;
  /** The one line a hover gets. */
  tooltip: string;
  /** The disabled first row of the menu, which says the same thing in words. */
  header: string;
  items: TrayItem[];
}

/**
 * A tray menu is not a list view: past about eight rows it stops being
 * scannable and starts being a wall, and the rail is right there for the rest.
 */
const MENU_LIMIT = 8;
/** Menus lay out to their widest row, so one long title must not stretch it. */
const LABEL_MAX = 64;

const clip = (s: string, n = LABEL_MAX) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function trayModel(asks: Ask[], limit = MENU_LIMIT): TrayModel {
  const count = asks.length;
  const header = count === 0 ? 'nothing is waiting' : `${count} need${count === 1 ? 's' : ''} you`;
  return {
    attention: count > 0,
    count,
    tooltip: `oh-my-ide — ${header}`,
    header,
    // Already sorted most urgent first, so a truncated menu keeps the ones that
    // matter rather than whichever happen to sort early by id.
    items: asks.slice(0, limit).map((a) => ({
      label: clip(`${a.trackTitle} — ${a.says}`),
      ask: a,
    })),
  };
}

/**
 * How loudly to say it. Electron's Linux default is `low`, which some daemons
 * render as a notification nobody sees — so `normal` is set explicitly, and the
 * one ask that has a session frozen in front of a prompt gets `critical`, which
 * is the difference between "come back when you can" and "nothing moves until
 * you answer".
 */
export const urgencyOf = (a: Ask): 'normal' | 'critical' =>
  a.rule === 'claude.needs_permission' ? 'critical' : 'normal';
