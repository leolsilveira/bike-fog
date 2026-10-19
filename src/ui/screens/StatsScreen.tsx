import { useMemo, useState } from 'react';
import { useGame } from '../../game/store.ts';
import { levelFromXp } from '../../game/progression.ts';
import { cityPercent } from '../../game/cities.ts';
import { loadTrack, wipeAll } from '../../game/persist.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration } from '../../game/geo.ts';
import { sfx } from '../../game/audio.ts';
import { CHARACTERS } from '../../sprites/characters.ts';
import { POI_CATEGORIES, POI_INFO, RARITY_INFO } from '../../sprites/items.ts';
import { GAME_NAME } from '../../game/config.ts';
import type { ActivitySummary, Settings } from '../../game/types.ts';
import { BadgeImg, CharacterSprite, CoinImg, Icon, PoiIconImg } from '../components/Sprites.tsx';

async function exportGpx(a: ActivitySummary): Promise<void> {
  const track = await loadTrack(a.id);
  if (!track || track.length < 6) {
    useGame.getState().toast('Esta atividade não tem trilha salva.', 'warn');
    return;
  }
  const pts: string[] = [];
  for (let i = 0; i < track.length; i += 3) {
    pts.push(
      `<trkpt lat="${track[i + 1].toFixed(7)}" lon="${track[i].toFixed(7)}"><time>${new Date(track[i + 2]).toISOString()}</time></trkpt>`,
    );
  }
  const type = a.modality === 'bike' ? 'cycling' : 'running';
  const gpx =
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${GAME_NAME}" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<trk><name>${GAME_NAME} ${new Date(a.startedAt).toLocaleString('pt-BR')}</name><type>${type}</type><trkseg>` +
    pts.join('') +
    `</trkseg></trk></gpx>`;
  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${GAME_NAME.toLowerCase()}-${new Date(a.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.gpx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function Toggle({ k, label, desc }: { k: keyof Settings; label: string; desc: string }) {
  const value = useGame((s) => s.settings[k]);
  const setSetting = useGame((s) => s.setSetting);
  return (
    <div className="setting">
      <div>
        <div style={{ fontWeight: 700 }}>{label}</div>
        <div className="d">{desc}</div>
      </div>
      <button
        className={`switch ${value ? 'on' : ''}`}
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => {
          setSetting(k, !value);
          sfx.click();
        }}
      />
    </div>
  );
}

export function StatsScreen() {
  const profile = useGame((s) => s.profile)!;
  const xp = useGame((s) => s.xp);
  const wallet = useGame((s) => s.wallet);
  const totals = useGame((s) => s.totals);
  const cities = useGame((s) => s.cities);
  const captures = useGame((s) => s.captures);
  const activities = useGame((s) => s.activities);
  const fix = useGame((s) => s.fix);
  const pushModal = useGame((s) => s.pushModal);
  const [showAll, setShowAll] = useState(false);
  const lvl = levelFromXp(xp);
  const def = CHARACTERS.find((c) => c.id === profile.characterId)!;

  const capList = useMemo(() => Object.values(captures).sort((a, b) => b.capturedAt - a.capturedAt), [captures]);
  const byCat = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of capList) m[c.category] = (m[c.category] ?? 0) + 1;
    return m;
  }, [capList]);
  const cityList = Object.values(cities).sort((a, b) => cityPercent(b) - cityPercent(a));
  const areaTotal = totals.cells * cellSizeM(fix?.lat ?? -23.5) ** 2;

  return (
    <div className="screen stats-screen">
      <div className="stats-inner">
        <div className="px-box profile-card">
          <CharacterSprite characterId={profile.characterId} modality={profile.modality} facing="down" />
          <div style={{ minWidth: 0 }}>
            <div className="pname">{profile.name}</div>
            <div className="ptitle">
              Nível {lvl.level} · {lvl.title}
            </div>
            <div className="xpline">
              <span>XP</span>
              <span>
                {lvl.current} / {lvl.needed}
              </span>
            </div>
            <div className="bar">
              <i style={{ width: `${(lvl.current / lvl.needed) * 100}%` }} />
            </div>
            <div className="row">
              <span className="chip">
                <CoinImg size={16} /> {wallet.toLocaleString('pt-BR')}
              </span>
              <span className="chip">
                <Icon name={profile.modality} size={16} /> {def.name}
              </span>
              <button className="px-btn small sky" onClick={() => pushModal({ type: 'characters' })}>
                Trocar herói
              </button>
            </div>
          </div>
        </div>

        <section className="section">
          <h3>
            <Icon name="trophy" size={18} /> TOTAIS
          </h3>
          <div className="totals">
            <div className="px-box total">
              <span className="lbl">Distância</span>
              <span className="val">{formatDistance(totals.distanceM)}</span>
            </div>
            <div className="px-box total">
              <span className="lbl">Em movimento</span>
              <span className="val">{formatDuration(totals.movingS)}</span>
            </div>
            <div className="px-box total">
              <span className="lbl">Atividades</span>
              <span className="val">{totals.activities}</span>
            </div>
            <div className="px-box total">
              <span className="lbl">Área revelada</span>
              <span className="val">{formatArea(areaTotal)}</span>
            </div>
            <div className="px-box total">
              <span className="lbl">Moedas</span>
              <span className="val">{totals.coinsValue.toLocaleString('pt-BR')}</span>
            </div>
            <div className="px-box total">
              <span className="lbl">Capturas</span>
              <span className="val">{totals.captures}</span>
            </div>
          </div>
        </section>

        <section className="section">
          <h3>
            <Icon name="flag" size={18} /> CIDADES DESBLOQUEADAS
          </h3>
          {cityList.length === 0 ? (
            <div className="px-box empty">Grave sua primeira atividade para começar a revelar uma cidade.</div>
          ) : (
            cityList.map((c) => {
              const pct = cityPercent(c);
              return (
                <div key={c.id} className="px-box city">
                  <div className="top">
                    <span className="nm">{c.name}</span>
                    <span className="pct">{pct.toFixed(pct < 1 ? 3 : 2).replace('.', ',')}%</span>
                  </div>
                  <div className="bar mint">
                    <i style={{ width: `${Math.max(pct, pct > 0 ? 0.6 : 0)}%` }} />
                  </div>
                  <div className="meta">
                    {formatArea(c.cells * c.cellAreaM2)} de {formatArea(c.areaM2)}
                    {c.state ? ` · ${c.state}` : ''}
                  </div>
                </div>
              );
            })
          )}
        </section>

        <section className="section">
          <h3>
            <Icon name="star" size={18} /> COLEÇÃO
          </h3>
          <div className="dex">
            {POI_CATEGORIES.map((cat) => {
              const n = byCat[cat] ?? 0;
              return (
                <div key={cat} className={`dex-cell ${n ? '' : 'zero'}`} title={POI_INFO[cat].plural}>
                  <PoiIconImg category={cat} size={36} />
                  <span className="n">{n}</span>
                  <span className="c">{POI_INFO[cat].plural}</span>
                </div>
              );
            })}
          </div>
          {capList.length > 0 && (
            <div className="list">
              {(showAll ? capList : capList.slice(0, 6)).map((c) => (
                <div key={c.id} className="list-item">
                  <BadgeImg category={c.category} state="captured" width={34} />
                  <div className="body">
                    <div className="t">{c.name}</div>
                    <div className="s">
                      <span style={{ color: RARITY_INFO[c.rarity].color }}>{RARITY_INFO[c.rarity].label}</span> ·{' '}
                      {POI_INFO[c.category].label} · {new Date(c.capturedAt).toLocaleDateString('pt-BR')}
                      {c.cityId && cities[c.cityId] ? ` · ${cities[c.cityId].name}` : ''}
                    </div>
                  </div>
                </div>
              ))}
              {capList.length > 6 && (
                <button className="px-btn small ghost" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Mostrar menos' : `Ver todas (${capList.length})`}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="section">
          <h3>
            <Icon name="clock" size={18} /> ATIVIDADES
          </h3>
          {activities.length === 0 ? (
            <div className="px-box empty">Nenhuma atividade ainda. Toque em Gravar e saia por aí!</div>
          ) : (
            <div className="list" style={{ marginTop: 0 }}>
              {activities.slice(0, 30).map((a) => (
                <div key={a.id} className="list-item">
                  <Icon name={a.modality} size={28} />
                  <div className="body">
                    <div className="t">
                      {formatDistance(a.distanceM)} · {formatDuration(a.movingS || a.elapsedS)}
                    </div>
                    <div className="s">
                      {new Date(a.startedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                      {a.coinsValue} moedas · {a.captures.length} capturas · +{a.xp} XP
                    </div>
                  </div>
                  <button className="px-btn small ghost" onClick={() => void exportGpx(a)} aria-label="Exportar GPX" title="Exportar GPX">
                    <Icon name="download" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section">
          <h3>
            <Icon name="gear" size={18} /> AJUSTES
          </h3>
          <div className="px-box settings">
            <Toggle k="sound" label="Sons" desc="Efeitos chiptune ao coletar e capturar." />
            <Toggle k="haptics" label="Vibração" desc="Vibra ao pegar moedas e capturar pontos." />
            <Toggle
              k="simulator"
              label="Modo simulador"
              desc="GPS virtual para testar no computador: joystick, WASD/setas, Shift = turbo, botão direito/toque longo no mapa = teletransporte."
            />
            <div className="setting">
              <div>
                <div style={{ fontWeight: 700 }}>Apagar progresso</div>
                <div className="d">Remove névoa revelada, capturas, moedas e histórico deste aparelho.</div>
              </div>
              <button
                className="px-btn small coral"
                onClick={async () => {
                  if (!confirm('Apagar todo o progresso deste aparelho? Não dá para desfazer.')) return;
                  await wipeAll();
                  useGame.getState().resetProgress();
                }}
              >
                Apagar
              </button>
            </div>
          </div>
        </section>

        <p className="credits">
          {GAME_NAME} · protótipo front-end. Mapa:{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ·{' '}
          <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> · dados ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>. Cidades via
          Nominatim.
        </p>
      </div>
    </div>
  );
}
