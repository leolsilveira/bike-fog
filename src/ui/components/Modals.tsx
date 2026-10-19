import { useEffect } from 'react';
import { useGame } from '../../game/store.ts';
import { sfx } from '../../game/audio.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration, formatPace, formatSpeed } from '../../game/geo.ts';
import { CHARACTERS } from '../../sprites/characters.ts';
import { POI_INFO, RARITY_INFO } from '../../sprites/items.ts';
import type { ActivitySummary, Capture } from '../../game/types.ts';
import { BadgeImg, CharacterSprite, CoinImg, Icon } from './Sprites.tsx';

function Stars({ n }: { n: number }) {
  return (
    <span className="stars">
      {Array.from({ length: 5 }, (_, i) => (
        <Icon key={i} name="star" size={18} color="#1d1730" accent={i < n ? '#ffc63d' : '#463c72'} />
      ))}
    </span>
  );
}

function CaptureModal({ capture, xp, onClose }: { capture: Capture; xp: number; onClose: () => void }) {
  const r = RARITY_INFO[capture.rarity];
  return (
    <div className="px-box modal">
      <h2>CAPTURADO!</h2>
      <div className="capture-stage">
        <div className="rays" />
        <BadgeImg category={capture.category} state="wild" width={120} />
      </div>
      <p style={{ fontWeight: 700, fontSize: 19 }}>{capture.name}</p>
      <p>
        <span className="rarity-tag" style={{ background: r.color }}>{r.label}</span>{' '}
        <span className="muted">{POI_INFO[capture.category].label}</span>
      </p>
      <Stars n={r.stars} />
      <div className="xp-pop">+{xp} XP</div>
      <div className="actions">
        <button className="px-btn gold block" onClick={onClose}>
          Continuar
        </button>
      </div>
    </div>
  );
}

function LevelUpModal({ level, title, onClose }: { level: number; title: string; onClose: () => void }) {
  const profile = useGame((s) => s.profile);
  useEffect(() => {
    sfx.levelUp();
  }, []);
  return (
    <div className="px-box modal">
      <h2>LEVEL UP!</h2>
      <p className="arcade" style={{ color: 'var(--cream)', fontSize: 13 }}>NV {level}</p>
      <div className="capture-stage">
        <div className="rays" />
        {profile && (
          <CharacterSprite
            characterId={profile.characterId}
            modality={profile.modality}
            facing="down"
            style={{ position: 'relative', width: 120, height: 150 }}
          />
        )}
      </div>
      <p style={{ fontWeight: 700, fontSize: 18 }}>Novo título: {title}</p>
      <p className="muted">Continue explorando para subir mais.</p>
      <div className="actions">
        <button className="px-btn gold block" onClick={onClose}>
          Bora!
        </button>
      </div>
    </div>
  );
}

function SummaryModal({ activity: a, onClose }: { activity: ActivitySummary; onClose: () => void }) {
  const fix = useGame((s) => s.fix);
  const captures = useGame((s) => s.captures);
  const avg = a.movingS > 0 ? a.distanceM / a.movingS : 0;
  const area = a.newCells * cellSizeM(fix?.lat ?? -23.5) ** 2;
  return (
    <div className="px-box modal">
      <h2>FIM DA {a.modality === 'bike' ? 'PEDALADA' : 'CORRIDA'}!</h2>
      <p className="muted">{new Date(a.startedAt).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })}</p>
      <div className="summary-grid">
        <div>
          <div className="lbl">Distância</div>
          <div className="val">{formatDistance(a.distanceM)}</div>
        </div>
        <div>
          <div className="lbl">Tempo</div>
          <div className="val">{formatDuration(a.movingS || a.elapsedS)}</div>
        </div>
        <div>
          <div className="lbl">{a.modality === 'bike' ? 'Vel. média' : 'Pace médio'}</div>
          <div className="val">{a.modality === 'bike' ? `${formatSpeed(avg)} km/h` : `${formatPace(avg)}/km`}</div>
        </div>
        <div>
          <div className="lbl">Área nova</div>
          <div className="val">{formatArea(area)}</div>
        </div>
        <div>
          <div className="lbl">Moedas</div>
          <div className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <CoinImg size={16} /> {a.coinsValue}
          </div>
        </div>
        <div>
          <div className="lbl">XP</div>
          <div className="val" style={{ color: 'var(--mint)' }}>+{a.xp}</div>
        </div>
      </div>
      {a.captures.length > 0 && (
        <div style={{ marginTop: 14, textAlign: 'left' }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>CAPTURAS ({a.captures.length})</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {a.captures.map((id) => captures[id]).filter(Boolean).map((c) => (
              <span key={c.id} title={c.name}>
                <BadgeImg category={c.category} state="captured" width={34} />
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="actions">
        <button className="px-btn gold block" onClick={onClose}>
          Salvar e voltar ao mapa
        </button>
      </div>
    </div>
  );
}

function CharactersModal({ onClose }: { onClose: () => void }) {
  const profile = useGame((s) => s.profile)!;
  const unlocked = useGame((s) => s.unlocked);
  const wallet = useGame((s) => s.wallet);
  const { setCharacter, unlockCharacter, toast } = useGame.getState();
  return (
    <div className="px-box modal">
      <h2>HERÓIS</h2>
      <p className="muted">
        Você tem <CoinImg size={14} /> {wallet} moedas.
      </p>
      <div className="char-grid">
        {CHARACTERS.map((c) => {
          const owned = unlocked.includes(c.id);
          const selected = profile.characterId === c.id;
          return (
            <button
              key={c.id}
              className={`char-cell ${selected ? 'selected' : ''}`}
              onClick={() => {
                if (owned) {
                  sfx.click();
                  setCharacter(c.id);
                } else if (unlockCharacter(c.id)) {
                  sfx.capture();
                  setCharacter(c.id);
                  toast(`${c.name} desbloqueado!`, 'city');
                } else {
                  sfx.warn();
                  toast(`Faltam ${c.price - wallet} moedas para ${c.name}.`, 'warn');
                }
              }}
            >
              <CharacterSprite characterId={c.id} modality={profile.modality} facing="down" animate={selected} />
              <span style={{ fontWeight: 700 }}>{c.name}</span>
              {owned ? (
                <span className="muted" style={{ fontSize: 12 }}>{selected ? 'em uso' : 'liberado'}</span>
              ) : (
                <span className="price">
                  <CoinImg size={12} /> {c.price}
                </span>
              )}
              {!owned && (
                <span style={{ position: 'absolute', top: 6, right: 6 }}>
                  <Icon name="lock" size={16} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="actions">
        <button className="px-btn block" onClick={onClose}>
          Fechar
        </button>
      </div>
    </div>
  );
}

export function ModalHost() {
  const modal = useGame((s) => s.modals[0]);
  const closeModal = useGame((s) => s.closeModal);
  const setTab = useGame((s) => s.setTab);
  const recording = useGame((s) => s.live?.status === 'recording');
  const queued = useGame((s) => s.modals.length);
  // Pedalando/correndo ninguém deve precisar tocar na tela: capturas e níveis somem sozinhos.
  const passive = recording && (modal?.type === 'capture' || modal?.type === 'levelup');
  useEffect(() => {
    if (!passive) return;
    // com fila (várias capturas de uma vez) cada cartão fica menos tempo
    const id = setTimeout(closeModal, queued > 1 ? 2000 : 3600);
    return () => clearTimeout(id);
  }, [modal, passive, closeModal, queued]);
  if (!modal) return null;
  const close = () => {
    sfx.click();
    if (modal.type === 'summary') setTab('map');
    closeModal();
  };
  return (
    <div
      className={`modal-backdrop ${passive ? 'passive' : ''}`}
      onClick={(e) => (passive || e.target === e.currentTarget) && close()}
    >
      {modal.type === 'capture' && <CaptureModal capture={modal.capture} xp={modal.xp} onClose={close} />}
      {modal.type === 'levelup' && <LevelUpModal level={modal.level} title={modal.title} onClose={close} />}
      {modal.type === 'summary' && <SummaryModal activity={modal.activity} onClose={close} />}
      {modal.type === 'characters' && <CharactersModal onClose={close} />}
    </div>
  );
}
