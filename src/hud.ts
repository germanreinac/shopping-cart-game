import type { CartState } from './cart';
import type { RaceState } from './race';

export interface HudState {
  state: CartState;
  score: number;
  speed: number;
  pendingLabel: string;
  pendingPoints: number;
  stamina: number;
  staminaMax: number;
  sprinting: boolean;
  passenger: string;
  race: RaceState;
  raceTime: number;
  checkpoint: number;
  checkpoints: number;
  place: number;
  racers: number;
  best: number | null;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const ORDINAL = ['', '1ST', '2ND', '3RD', '4TH'];

/** DOM overlay: score, speed, cigarettes, race status, trick popups and a context hint. */
export class Hud {
  private scoreEl = document.getElementById('score')!;
  private speedEl = document.getElementById('speed')!;
  private pendingEl = document.getElementById('pending')!;
  private hintEl = document.getElementById('hint')!;
  private popups = document.getElementById('popups')!;
  private raceEl = document.getElementById('race')!;
  private staminaEl = document.getElementById('stamina')!;
  private throwBtn = document.getElementById('btn-throw');
  private cigs: HTMLElement[] = [];
  private cache: Record<string, string> = {};

  constructor(staminaMax: number) {
    for (let i = 0; i < staminaMax; i++) {
      const cig = document.createElement('div');
      cig.className = 'cig';
      cig.innerHTML = '<i class="filter"></i><i class="paper"><i class="left"></i></i>';
      this.staminaEl.appendChild(cig);
      this.cigs.push(cig.querySelector('.left') as HTMLElement);
    }
  }

  update(h: HudState): void {
    this.set('score', this.scoreEl, String(h.score));
    this.set('speed', this.speedEl, String(Math.round(h.speed * 3.6)));
    this.set('pending', this.pendingEl, h.pendingPoints > 0 ? `${h.pendingLabel} ${h.pendingPoints}` : '');

    // Each cigarette burns down from the tip; the one being smoked glows.
    this.cigs.forEach((el, i) => {
      const left = Math.max(0, Math.min(1, h.stamina - i));
      const pct = `${Math.round(left * 20) * 5}%`;
      if (this.cache[`cig${i}`] !== pct) {
        el.style.width = pct;
        this.cache[`cig${i}`] = pct;
      }
    });
    const burning = h.sprinting ? 'burning' : '';
    if (this.cache.burning !== burning) {
      this.staminaEl.className = burning;
      this.cache.burning = burning;
    }

    let race = '';
    if (h.race === 'running' || h.race === 'countdown') {
      race = `<b>${fmt(h.raceTime)}</b> · ${ORDINAL[h.place]} of ${h.racers} · checkpoint ${h.checkpoint}/${h.checkpoints}`;
    } else if (h.best !== null) {
      race = `best lap ${fmt(h.best)}`;
    }
    this.set('race', this.raceEl, race, true);

    let hint: string;
    if (h.state === 'crashed') hint = 'Press <b>R</b> to get back up';
    else if (h.state === 'riding') hint = '<b>A / D</b> lean and drift · <b>W</b> kick-push · tap <b>S</b> wheelie · <b>Space</b> hop';
    else hint = 'Hold <b>W</b> to run (sprinting burns cigarettes) · <b>A / D</b> steer · <b>Space</b> hop on';
    if (h.passenger && h.state !== 'crashed') hint += ` · <b>F</b> ${h.passenger} throws`;
    if (h.race === 'idle') hint += ' · <b>Enter</b> race';
    this.set('hint', this.hintEl, hint, true);

    if (this.throwBtn) {
      const show = h.passenger ? 'grid' : 'none';
      if (this.cache.throwBtn !== show) {
        this.throwBtn.style.display = show;
        this.cache.throwBtn = show;
      }
    }
  }

  popup(text: string, kind: 'trick' | 'bail' | 'info' | 'big' = 'trick'): void {
    const el = document.createElement('div');
    el.className = `popup ${kind}`;
    el.textContent = text;
    this.popups.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    while (this.popups.children.length > 4) this.popups.firstElementChild!.remove();
  }

  private set(key: string, el: HTMLElement, value: string, html = false): void {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    if (html) el.innerHTML = value;
    else el.textContent = value;
  }
}

export { fmt as formatTime, ORDINAL };
