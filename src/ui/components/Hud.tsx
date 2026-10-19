import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from '../../map/engine.ts';
import { useGame } from '../../game/store.ts';
import { levelFromXp } from '../../game/progression.ts';
import { setSimInput, player } from '../../game/location.ts';
import { sfx } from '../../game/audio.ts';
import { formatDistance, haversine } from '../../game/geo.ts';
import { fog } from '../../game/fog.ts';
import { cellOf } from '../../game/geo.ts';
import { POI_INFO, RARITY_INFO } from '../../sprites/items.ts';
import type { Tab } from '../../game/types.ts';
import { BadgeImg, CharacterSprite, CoinImg, Icon } from './Sprites.tsx';

export function MapStage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) engine.mount(ref.current);
    return () => engine.unmount();
  }, []);
  return <div ref={ref} className="map-stage" />;
}

export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useFollowing(): boolean {
  return useSyncExternalStore(engine.subscribe, () => engine.isFollowing);
}

const TABS: { id: Tab; label: string; icon: 'pin' | 'record' | 'stats' }[] = [
  { id: 'map', label: 'Mapa', icon: 'pin' },
  { id: 'record', label: 'Gravar', icon: 'record' },
  { id: 'stats', label: 'Stats', icon: 'stats' },
];

export function TabBar() {
  const tab = useGame((s) => s.tab);
  const setTab = useGame((s) => s.setTab);
  const recording = useGame((s) => s.live?.status === 'recording');
  return (
    <nav className="tabbar">
      {TABS.map((t) => {
        const active = tab === t.id;
        const center = t.id === 'record';
        return (
          <button
            key={t.id}
            className={`tab ${active ? 'active' : ''} ${center ? 'center' : ''} ${center && recording ? 'recording' : ''}`}
            onClick={() => {
              if (tab !== t.id) sfx.click();
              setTab(t.id);
            }}
          >
            {center ? (
              <span className="tab-orb">
                <Icon name={recording ? 'pause' : 'record'} size={30} color="#fff6e0" accent="#fff6e0" />
              </span>
            ) : (
              <Icon name={t.icon} size={30} color={active ? '#ffc63d' : '#b8afd9'} accent={active ? '#fff6e0' : '#8f86c9'} />
            )}
            {recording && center ? 'Gravando' : t.label}
          </button>
        );
      })}
    </nav>
  );
}

export function PlayerChip() {
  const profile = useGame((s) => s.profile);
  const xp = useGame((s) => s.xp);
  if (!profile) return null;
  const lvl = levelFromXp(xp);
  return (
    <div className="px-box player-chip">
      <CharacterSprite className="avatar" characterId={profile.characterId} modality={profile.modality} animate={false} />
      <div className="who">
        <div className="name">{profile.name}</div>
        <div className="lvl">NV {lvl.level}</div>
        <div className="bar">
          <i style={{ width: `${(lvl.current / lvl.needed) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

export function Wallet() {
  const wallet = useGame((s) => s.wallet);
  return (
    <div className="px-box wallet" title="Moedas">
      <CoinImg size={20} />
      {wallet.toLocaleString('pt-BR')}
    </div>
  );
}

export function SideButtons({ showZoom }: { showZoom: boolean }) {
  const following = useFollowing();
  return (
    <div className="side-buttons">
      {!following && (
        <button className="px-btn gold" onClick={() => engine.recenter()} aria-label="Centralizar">
          <Icon name="target" size={24} color="#1d1730" accent="#ff6b5a" />
        </button>
      )}
      {showZoom && (
        <>
          <button className="px-btn ghost" onClick={() => engine.zoomBy(0.8)} aria-label="Aproximar">
            <span className="zoom-label">+</span>
          </button>
          <button className="px-btn ghost" onClick={() => engine.zoomBy(-0.8)} aria-label="Afastar">
            <span className="zoom-label">−</span>
          </button>
        </>
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`px-box toast ${t.kind}`}>
          {t.kind === 'coin' && <CoinImg kind={t.coinKind} size={20} />}
          {t.kind === 'city' && <Icon name="flag" size={20} color="#1d1730" accent="#fff6e0" />}
          {t.kind === 'warn' && <Icon name="bolt" size={20} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function SpeedBanner() {
  const warn = useGame((s) => s.speedWarning);
  if (!warn) return null;
  return (
    <div className="px-box banner">
      <Icon name="bolt" size={22} color="#ffc63d" />
      Rápido demais! Exploração pausada até você voltar ao ritmo de pedal/corrida.
    </div>
  );
}

/** Joystick virtual do modo simulador (também aceita WASD/setas). */
export function SimPad() {
  const sim = useGame((s) => s.settings.simulator);
  const tab = useGame((s) => s.tab);
  const padRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const active = useRef<number | null>(null);
  if (!sim || tab === 'stats') return null;

  const update = (e: React.PointerEvent) => {
    const pad = padRef.current!;
    const r = pad.getBoundingClientRect();
    const max = r.width / 2 - 12;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    knobRef.current!.style.transform = `translate(${dx}px, ${dy}px)`;
    setSimInput(dx / max, -dy / max);
  };
  const end = () => {
    active.current = null;
    if (knobRef.current) knobRef.current.style.transform = '';
    setSimInput(0, 0);
  };

  return (
    <div
      ref={padRef}
      className="simpad"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => active.current === e.pointerId && update(e)}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="tag">SIMULADOR</span>
      <div ref={knobRef} className="knob" />
    </div>
  );
}

export function PoiCard() {
  const selected = useGame((s) => s.selected);
  const select = useGame((s) => s.select);
  const capture = useGame((s) => (s.selected ? s.captures[s.selected.id] : undefined));
  useNow(1000);
  if (!selected) return null;
  const info = POI_INFO[selected.category];
  const rarity = RARITY_INFO[selected.rarity];
  const revealed = !!capture || fog.has(cellOf(selected));
  const here = player.display;
  const dist = here ? haversine(here, selected) : null;
  return (
    <div className="px-box poi-card">
      <BadgeImg className="badge" category={selected.category} state={capture ? 'captured' : revealed ? 'wild' : 'fog'} width={60} />
      <div className="info">
        <h3>{revealed ? selected.name : '??? Ponto misterioso'}</h3>
        <div>
          <span className="rarity-tag" style={{ background: rarity.color }}>{revealed ? rarity.label : '???'}</span>{' '}
          <span className="muted">{revealed ? info.label : 'na névoa'}</span>
        </div>
        <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
          {capture
            ? `Capturado em ${new Date(capture.capturedAt).toLocaleDateString('pt-BR')}`
            : !revealed
              ? 'Explore a névoa para descobrir o que é.'
              : dist != null && dist <= info.radius
                ? 'Você está aqui! Inicie uma atividade para capturar.'
                : `Chegue a ${info.radius} m durante uma atividade para capturar.`}
          {dist != null && !capture && ` · ${formatDistance(dist)}`}
        </div>
      </div>
      <button className="px-btn small ghost close" onClick={() => select(null)} aria-label="Fechar">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
