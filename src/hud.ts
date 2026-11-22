import type { CartState } from './cart';

const HINTS: Record<CartState, string> = {
  pushing: 'Hold <b>W</b> to run and push · <b>A / D</b> steer · <b>Space</b> hop on',
  riding: '<b>A / D</b> lean · tap <b>S</b> to wheelie · <b>Space</b> kerb hop',
  crashed: 'Press <b>R</b> to get back up',
};

/** DOM overlay: score, speed, trick popups and a context hint. */
export class Hud {
  private scoreEl = document.getElementById('score')!;
  private speedEl = document.getElementById('speed')!;
  private pendingEl = document.getElementById('pending')!;
  private hintEl = document.getElementById('hint')!;
  private popups = document.getElementById('popups')!;
  private lastState: CartState | null = null;
  private lastScore = -1;
  private lastSpeed = -1;
  private lastPending = -1;

  update(state: CartState, score: number, speed: number, pending: number): void {
    if (state !== this.lastState) {
      this.hintEl.innerHTML = HINTS[state];
      this.lastState = state;
    }
    if (score !== this.lastScore) {
      this.scoreEl.textContent = String(score);
      this.lastScore = score;
    }
    const kmh = Math.round(speed * 3.6);
    if (kmh !== this.lastSpeed) {
      this.speedEl.textContent = String(kmh);
      this.lastSpeed = kmh;
    }
    if (pending !== this.lastPending) {
      this.pendingEl.textContent = pending > 0 ? `WHEELIE ${pending}` : '';
      this.lastPending = pending;
    }
  }

  popup(text: string, kind: 'trick' | 'bail' | 'info' = 'trick'): void {
    const el = document.createElement('div');
    el.className = `popup ${kind}`;
    el.textContent = text;
    this.popups.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    while (this.popups.children.length > 4) this.popups.firstElementChild!.remove();
  }
}
