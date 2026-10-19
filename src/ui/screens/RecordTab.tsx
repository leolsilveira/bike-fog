import { useEffect } from 'react';
import { liveElapsed, useGame } from '../../game/store.ts';
import { player } from '../../game/location.ts';
import { finishAndSaveTrack, kickTracker } from '../../game/tracker.ts';
import { sfx } from '../../game/audio.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration, formatPace, formatSpeed } from '../../game/geo.ts';
import type { GpsStatus } from '../../game/types.ts';
import { CoinImg, Icon, PoiIconImg } from '../components/Sprites.tsx';
import { SideButtons, useNow } from '../components/Hud.tsx';
import { CityChip } from './MapTab.tsx';

const GPS_LABEL: Record<GpsStatus, [string, string]> = {
  off: ['GPS desligado', 'bad'],
  searching: ['Procurando GPS…', 'warn'],
  ok: ['GPS ok', ''],
  weak: ['GPS fraco', 'warn'],
  denied: ['GPS bloqueado', 'bad'],
  unavailable: ['GPS indisponível', 'bad'],
  sim: ['Simulador', 'sim'],
};

function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
        if (cancelled) void lock.release();
      } catch {
        /* negado pelo navegador */
      }
    };
    const onVis = () => document.visibilityState === 'visible' && void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [active]);
}

export function RecordTab() {
  const live = useGame((s) => s.live);
  const profile = useGame((s) => s.profile)!;
  const gps = useGame((s) => s.gps);
  const fix = useGame((s) => s.fix);
  const simulator = useGame((s) => s.settings.simulator);
  const { startActivity, pauseActivity, resumeActivity, finishActivity, setModality, setSetting } = useGame.getState();
  const now = useNow(500);
  useWakeLock(live?.status === 'recording');

  const [gpsText, gpsClass] = GPS_LABEL[gps];
  const gpsDetail = gps === 'ok' || gps === 'weak' ? ` ±${Math.round(fix?.accuracy ?? 0)} m` : '';
  const canStart = simulator || gps === 'ok' || gps === 'weak';

  const start = () => {
    sfx.start();
    startActivity();
    kickTracker();
  };
  const finish = async () => {
    sfx.stop();
    await finishAndSaveTrack();
    finishActivity();
  };

  if (!live) {
    return (
      <div className="hud-layer">
        <div className="vignette" />
        <div className="rec-top" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span className={`chip status-pill ${gpsClass}`}>
            <span className="dot" />
            {gpsText}
            {gpsDetail}
          </span>
          <CityChip />
        </div>
        <SideButtons showZoom={false} />
        <div className="rec-bottom">
          {(gps === 'denied' || gps === 'unavailable') && !simulator && (
            <div className="px-box" style={{ padding: 12, textAlign: 'center', maxWidth: 340 }}>
              <p style={{ margin: '0 0 10px' }}>
                Sem acesso ao GPS. Libere a localização no navegador ou jogue no modo simulador.
              </p>
              <button className="px-btn sky small" onClick={() => setSetting('simulator', true)}>
                <Icon name="joystick" size={16} color="#1d1730" accent="#ff6b5a" /> Ativar simulador
              </button>
            </div>
          )}
          <div className="mode-toggle">
            <button
              className={`px-btn small ${profile.modality === 'bike' ? 'mint' : 'ghost'}`}
              onClick={() => {
                sfx.click();
                setModality('bike');
              }}
            >
              <Icon name="bike" size={20} color={profile.modality === 'bike' ? '#1d1730' : '#fff6e0'} /> Ciclismo
            </button>
            <button
              className={`px-btn small ${profile.modality === 'run' ? 'coral' : 'ghost'}`}
              onClick={() => {
                sfx.click();
                setModality('run');
              }}
            >
              <Icon name="run" size={20} /> Corrida
            </button>
          </div>
          <button className="px-btn gold start-btn" disabled={!canStart} onClick={start}>
            <Icon name="play" size={28} color="#1d1730" />
            <span className="arcade">INICIAR</span>
          </button>
          <div className="hint">
            {canStart
              ? 'Moedas novas aparecem a cada atividade. Passe perto dos pontos para capturá-los!'
              : 'Aguardando sinal do GPS…'}
          </div>
        </div>
      </div>
    );
  }

  const elapsed = liveElapsed(live, now);
  const avg = live.movingS > 0 ? live.distanceM / live.movingS : 0;
  const speedNow = player.speed;
  const isBike = live.modality === 'bike';
  const area = live.newCells * cellSizeM(fix?.lat ?? -23.5) ** 2;

  return (
    <div className="hud-layer">
      <div className="tiltshift" />
      <div className="vignette" />
      <div className="rec-top">
        <div className="px-box rec-stats">
          <div className="rec-stat big">
            <span className="lbl">
              <Icon name="clock" size={14} /> Tempo
            </span>
            <span className="val">{formatDuration(elapsed)}</span>
          </div>
          <div className="rec-stat">
            <span className="lbl">
              <Icon name="flag" size={14} /> Dist.
            </span>
            <span className="val">
              {(live.distanceM / 1000).toFixed(2).replace('.', ',')}
              <small>km</small>
            </span>
          </div>
          <div className="rec-stat">
            <span className="lbl">
              <Icon name="bolt" size={14} /> {isBike ? 'Veloc.' : 'Pace/km'}
            </span>
            <span className="val">
              {isBike ? formatSpeed(speedNow) : formatPace(speedNow)}
              {isBike && <small>km/h</small>}
            </span>
          </div>
        </div>
        <div className="rec-chips">
          <span className="chip">
            <CoinImg size={16} /> {live.coinsValue}
          </span>
          <span className="chip">
            <PoiIconImg category="atracao" size={16} /> {live.captures.length} {live.captures.length === 1 ? 'captura' : 'capturas'}
          </span>
          <span className="chip">
            <Icon name="cloud" size={16} accent="#8f86c9" /> +{formatArea(area)}
          </span>
          <span className="chip muted">
            média {isBike ? `${formatSpeed(avg)} km/h` : `${formatPace(avg)}/km`}
          </span>
        </div>
      </div>
      <SideButtons showZoom={false} />
      <div className="rec-bottom">
        {live.status === 'paused' && (
          <div className="hint" style={{ fontSize: 15 }}>
            Pausado · {formatDistance(live.distanceM)} até agora
          </div>
        )}
        <div className="rec-controls">
          {live.status === 'recording' ? (
            <button
              className="px-btn cream"
              onClick={() => {
                sfx.pause();
                pauseActivity();
              }}
            >
              <Icon name="pause" size={20} color="#1d1730" /> Pausar
            </button>
          ) : (
            <>
              <button
                className="px-btn mint"
                onClick={() => {
                  sfx.start();
                  resumeActivity();
                  kickTracker();
                }}
              >
                <Icon name="play" size={20} color="#1d1730" /> Retomar
              </button>
              <button className="px-btn coral" onClick={finish}>
                <Icon name="stop" size={20} /> Finalizar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
