/** One physics step's worth of player intent, merged from keyboard, gamepad and touch. */
export interface Controls {
  /** Hold to run behind the cart and push. */
  push: boolean;
  /** -1 = lean/steer left, +1 = right. */
  steer: number;
  /** 0..1 lean back (wheelie when riding, brake when pushing). */
  back: number;
  /** Pressed this step: hop on / jump. */
  jump: boolean;
  /** Jump is being held: hold for a full-height jump, tap for a short one. */
  jumpHeld: boolean;
  /** Pressed this step: reset after a bail. */
  reset: boolean;
  /** Pressed this step: your passenger throws a can. */
  throw: boolean;
  /** Pressed this step: start (or abandon) a race. */
  race: boolean;
  /** Pressed this step: let go of the cart. */
  letGo: boolean;
}

export const NO_CONTROLS: Controls = { push: false, steer: 0, back: 0, jump: false, jumpHeld: false, reset: false, throw: false, race: false, letGo: false };

const DEADZONE = 0.18;

export class Input {
  private keys = new Set<string>();
  private jumpQueued = false;
  private resetQueued = false;
  private throwQueued = false;
  private raceQueued = false;
  private letGoQueued = false;
  private padPrev: boolean[] = [];
  private touch = { push: false, steer: 0, back: 0, jump: false };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpQueued = true;
      if (e.code === 'KeyR') this.resetQueued = true;
      if (e.code === 'KeyF' || e.code === 'KeyE') this.throwQueued = true;
      if (e.code === 'Enter') this.raceQueued = true;
      if (e.code === 'KeyQ') this.letGoQueued = true;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.bindTouch();
  }

  /** Read the current controls. Edge-triggered buttons (jump, reset) are consumed. */
  sample(): Controls {
    const k = this.keys;
    let push = k.has('KeyW') || k.has('ArrowUp') || this.touch.push;
    let steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let back = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    steer += this.touch.steer;
    back = Math.max(back, this.touch.back);

    const pad = this.readGamepad();
    if (pad) {
      push = push || pad.push;
      steer += pad.steer;
      back = Math.max(back, pad.back);
    }

    const out: Controls = {
      push,
      steer: Math.max(-1, Math.min(1, steer)),
      back,
      jump: this.jumpQueued,
      jumpHeld: k.has('Space') || this.touch.jump || (pad?.jump ?? false),
      reset: this.resetQueued,
      throw: this.throwQueued,
      race: this.raceQueued,
      letGo: this.letGoQueued,
    };
    this.letGoQueued = false;
    this.jumpQueued = false;
    this.resetQueued = false;
    this.throwQueued = false;
    this.raceQueued = false;
    return out;
  }

  /** Standard-mapping gamepad: RT or X = push, stick = steer / lean back, A = hop, B = throw, Y = reset, Start = race. */
  private readGamepad(): { push: boolean; steer: number; back: number; jump: boolean } | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (!pad) return null;
    const pressed = pad.buttons.map((b) => b.pressed || b.value > 0.4);
    const edge = (i: number) => pressed[i] && !this.padPrev[i];
    if (edge(0)) this.jumpQueued = true;
    if (edge(1) || edge(5)) this.throwQueued = true;
    if (edge(4)) this.letGoQueued = true;
    if (edge(3)) this.resetQueued = true;
    if (edge(9)) this.raceQueued = true;
    this.padPrev = pressed;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    return {
      push: !!pressed[7] || !!pressed[2],
      jump: !!pressed[0],
      steer: Math.abs(ax) > DEADZONE ? ax : (pressed[15] ? 1 : 0) - (pressed[14] ? 1 : 0),
      back: ay > 0.35 ? ay : pressed[13] ? 1 : 0,
    };
  }

  /** On-screen controls for phones: left pad steers / leans back, right buttons push and hop. */
  private bindTouch(): void {
    const root = document.getElementById('touch');
    if (!root) return;
    const show = () => root.classList.add('on');
    window.addEventListener('touchstart', show, { once: true, passive: true });

    const stick = document.getElementById('stick');
    if (stick) {
      let id = -1;
      let ox = 0;
      let oy = 0;
      const end = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        id = -1;
        this.touch.steer = 0;
        this.touch.back = 0;
      };
      stick.addEventListener('pointerdown', (e) => {
        id = e.pointerId;
        ox = e.clientX;
        oy = e.clientY;
        stick.setPointerCapture(id);
      });
      stick.addEventListener('pointermove', (e) => {
        if (e.pointerId !== id) return;
        this.touch.steer = Math.max(-1, Math.min(1, (e.clientX - ox) / 50));
        this.touch.back = Math.max(0, Math.min(1, (e.clientY - oy) / 45));
      });
      stick.addEventListener('pointerup', end);
      stick.addEventListener('pointercancel', end);
    }

    const hold = (elId: string, down: () => void, up?: () => void) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        down();
      });
      if (up) {
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
      }
    };
    hold('btn-push', () => (this.touch.push = true), () => (this.touch.push = false));
    hold('btn-hop', () => { this.jumpQueued = true; this.touch.jump = true; }, () => (this.touch.jump = false));
    hold('btn-reset', () => (this.resetQueued = true));
    hold('btn-throw', () => (this.throwQueued = true));
    hold('btn-race', () => (this.raceQueued = true));
    hold('btn-letgo', () => (this.letGoQueued = true));
  }
}
