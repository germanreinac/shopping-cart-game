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
  lap: number;
  laps: number;
  place: number;
  racers: number;
  best: number | null;
  onFoot: boolean;
  /** Which way the racing line bends ahead, in radians (positive = left). */
  turn: number;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const ORDINAL = ['', '1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];

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
  private arrowEl = document.getElementById('arrow')!;
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
      race = `<b>${fmt(h.raceTime)}</b> · ${ORDINAL[h.place]} of ${h.racers} · lap ${h.lap}/${h.laps}`;
    } else if (h.best !== null) {
      race = `best race ${fmt(h.best)}`;
    }
    this.set('race', this.raceEl, race, true);

    // Race arrow: points where the racing line goes next, and swells for sharp corners.
    const racing = h.race === 'running' || h.race === 'countdown';
    const sharp = Math.min(1, Math.abs(h.turn) / 1.2);
    const arrow = racing ? `rotate(${Math.round((-h.turn * 180) / Math.PI / 3) * 3}deg) scale(${(1 + sharp * 0.6).toFixed(1)})` : '';
    if (this.cache.arrow !== arrow) {
      this.arrowEl.style.display = racing ? 'block' : 'none';
      this.arrowEl.style.transform = arrow;
      this.arrowEl.style.color = sharp > 0.45 ? '#ffd166' : '#58ffd0';
      this.cache.arrow = arrow;
    }

    let hint: string;
    if (h.onFoot) hint = 'On foot: <b>W</b> run · <b>A / D</b> turn · run up behind any cart to grab it';
    else if (h.state === 'crashed') hint = 'Ouch';
    else hint = 'Hold <b>W</b> to go · <b>A / D</b> steer, hold to drift · <b>Space</b> jump · in the air <b>S</b> backflip, <b>A / D</b> spin · <b>Q</b> let go';
    if (h.passenger && h.state !== 'crashed') hint += ` · <b>F</b> ${h.passenger} throws`;
    if (h.race === 'idle' && !h.onFoot) hint += ' · <b>Enter</b> race';
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
