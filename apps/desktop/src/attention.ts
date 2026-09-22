import path from 'node:path';
import { type Ask, type NotifyMemo, toNotify } from '@omi/core';
import { Menu, Notification, Tray } from 'electron';
import { type TrayModel, trayModel, urgencyOf } from './tray.js';

/**
 * The app's ambient voice: a tray icon that says whether anything is waiting,
 * and a notification when something starts to.
 *
 * Why it exists at all: the point of running many sessions is that you are not
 * watching them. A session that finishes its turn while you are in a meeting is
 * only useful if something tells you — and the window you closed cannot. So the
 * tray outlives the window, and both surfaces end in the same place: the track
 * and the session that is actually asking, on screen, focused.
 */

export interface AttentionUiOptions {
  /** Directory holding tray-idle.png and tray-attention.png. */
  assets: string;
  /** Put this ask on screen: raise the window and select its track and session. */
  onOpen: (ask: Ask) => void;
  /** Raise the window with nothing in particular selected. */
  onShow: () => void;
  onQuit: () => void;
  /** Whether notifications start muted; the tray's own checkbox changes it. */
  muted?: boolean;
  onMuteChange?: (muted: boolean) => void;
}

export class AttentionUi {
  private readonly tray: Tray;
  private readonly opts: AttentionUiOptions;
  private muted: boolean;
  /** The previous poll's asks, which is what makes a notification an edge. */
  private last: Ask[] = [];
  private memo = new Map<string, NotifyMemo>();
  private flying: 'idle' | 'attention' | null = null;
  private menuSig = '';
  /** Keeps shown notifications from being GC'd before the user can click them. */
  private live = new Set<Notification>();

  constructor(opts: AttentionUiOptions) {
    this.opts = opts;
    this.muted = opts.muted ?? false;
    this.tray = new Tray(this.icon('idle'));
    // Linux app indicators do not report a plain click — the menu is the whole
    // interface there. Elsewhere clicking the icon goes straight to the most
    // urgent thing, which is what a badge asking for attention should do.
    this.tray.on('click', () => {
      const first = this.last[0];
      if (first) this.opts.onOpen(first);
      else this.opts.onShow();
    });
    this.render(trayModel([]));
  }

  private icon(state: 'idle' | 'attention'): string {
    return path.join(this.opts.assets, `tray-${state}.png`);
  }

  /**
   * The one entry point: hand it what is asking right now and it settles the
   * icon, the menu and any notification that is owed.
   */
  update(asks: Ask[]): void {
    const model = trayModel(asks);
    this.render(model);
    this.notify(asks);
    this.last = asks;
  }

  private render(model: TrayModel): void {
    const want = model.attention ? 'attention' : 'idle';
    // setImage rewrites a temp file on Linux, so only touch it on a real change.
    if (this.flying !== want) {
      this.tray.setImage(this.icon(want));
      this.flying = want;
    }
    this.tray.setToolTip(model.tooltip);

    // Rebuilding a menu while it is open closes it under the user's cursor.
    const sig = `${model.header}|${this.muted}|${model.items.map((i) => i.label).join('|')}`;
    if (this.menuSig === sig) return;
    this.menuSig = sig;

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: model.header, enabled: false },
        ...(model.items.length > 0 ? [{ type: 'separator' as const }] : []),
        ...model.items.map((i) => ({ label: i.label, click: () => this.opts.onOpen(i.ask) })),
        { type: 'separator' },
        { label: 'Open oh-my-ide', click: () => this.opts.onShow() },
        {
          label: 'Notify me',
          type: 'checkbox',
          checked: !this.muted,
          click: (item) => this.setMuted(!item.checked),
        },
        { type: 'separator' },
        { label: 'Quit oh-my-ide', click: () => this.opts.onQuit() },
      ]),
    );
  }

  private setMuted(muted: boolean): void {
    this.muted = muted;
    this.menuSig = ''; // the checkbox moved, so the menu has to be rebuilt
    this.opts.onMuteChange?.(muted);
    this.render(trayModel(this.last));
  }

  private notify(asks: Ask[]): void {
    const { fire, memo } = toNotify(this.last, asks, this.memo, Date.now());
    this.memo = memo;
    // Muted still runs the diff above: coming back from muted must not dump
    // every ask that piled up while it was off, it must pick up from now.
    if (this.muted || !Notification.isSupported()) return;

    for (const ask of fire) {
      const n = new Notification({
        title: ask.trackTitle,
        body: ask.says,
        icon: path.join(this.opts.assets, 'icon.png'),
        urgency: urgencyOf(ask),
      });
      n.on('click', () => this.opts.onOpen(ask));
      n.on('close', () => this.live.delete(n));
      this.live.add(n);
      n.show();
    }
  }

  /** Only for a real quit: a disposed tray icon vanishes from the panel. */
  destroy(): void {
    this.tray.destroy();
  }
}
