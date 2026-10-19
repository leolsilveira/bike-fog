import { useMemo, useState } from 'react';
import { useGame } from '../../game/store.ts';
import { pois } from '../../game/pois.ts';
import { player } from '../../game/location.ts';
import { fog } from '../../game/fog.ts';
import { cellOf, formatDistance } from '../../game/geo.ts';
import { cityPercent } from '../../game/cities.ts';
import { POI_NEARBY_M } from '../../game/config.ts';
import { engine } from '../../map/engine.ts';
import { sfx } from '../../game/audio.ts';
import { BadgeImg, Icon } from '../components/Sprites.tsx';
import { PlayerChip, SideButtons, Wallet, useNow } from '../components/Hud.tsx';

export function CityChip() {
  const city = useGame((s) => (s.currentCityId ? s.cities[s.currentCityId] : null));
  if (!city) return null;
  return (
    <span className="chip">
      <Icon name="flag" size={14} />
      {city.name} · {cityPercent(city).toFixed(cityPercent(city) < 1 ? 3 : 2).replace('.', ',')}%
    </span>
  );
}

export function MapTab() {
  const poiRev = useGame((s) => s.poiRev);
  const captures = useGame((s) => s.captures);
  const selected = useGame((s) => s.selected);
  const select = useGame((s) => s.select);
  const [open, setOpen] = useState(true);
  const tick = useNow(3000);

  const nearby = useMemo(() => {
    void poiRev;
    void tick;
    const here = player.display;
    if (!here) return [];
    return pois.nearby(here, POI_NEARBY_M, (p) => !captures[p.id]).slice(0, 12);
  }, [poiRev, captures, tick]);

  return (
    <div className="hud-layer map-tab">
      <div className="top-hud">
        <PlayerChip />
        <Wallet />
      </div>
      <div style={{ position: 'absolute', top: 'calc(88px + var(--safe-t))', left: 12 }}>
        <CityChip />
      </div>
      <SideButtons showZoom />
      {!selected && (
        <div className="px-box nearby">
          <button className="nearby-head" onClick={() => setOpen((o) => !o)}>
            <span>
              Por perto <span className="muted">· {nearby.length ? `${nearby.length} para capturar` : 'nada ainda'}</span>
            </span>
            <span className="muted">{open ? '▾' : '▸'}</span>
          </button>
          {open && (
            <div className="nearby-list">
              {nearby.length === 0 && (
                <div className="muted" style={{ padding: '6px 2px', fontSize: 14 }}>
                  Os pontos capturáveis aparecem conforme o mapa carrega. Movimente-se para encontrar mais.
                </div>
              )}
              {nearby.map(({ poi, dist }) => {
                const revealed = fog.has(cellOf(poi));
                return (
                  <button
                    key={poi.id}
                    className="nearby-item"
                    onClick={() => {
                      sfx.click();
                      select(poi);
                      engine.focus(poi);
                    }}
                  >
                    <BadgeImg category={poi.category} state={revealed ? 'wild' : 'fog'} width={40} />
                    <span className="nm">{revealed ? poi.name : '???'}</span>
                    <span className="dist">{formatDistance(dist)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
