import { useState } from 'react';
import { CHARACTERS, type Modality } from '../../sprites/characters.ts';
import { useGame } from '../../game/store.ts';
import { sfx } from '../../game/audio.ts';
import { CharacterSprite, Icon } from '../components/Sprites.tsx';

export function CreateScreen() {
  const unlocked = useGame((s) => s.unlocked);
  const createProfile = useGame((s) => s.createProfile);
  const [index, setIndex] = useState(0);
  const [modality, setModality] = useState<Modality>('bike');
  const [name, setName] = useState('');
  const def = CHARACTERS[index];
  const locked = !unlocked.includes(def.id);

  const step = (d: number) => {
    sfx.click();
    setIndex((i) => (i + d + CHARACTERS.length) % CHARACTERS.length);
  };

  return (
    <div className="screen create-screen">
      <div className="create-inner">
        <h1 className="screen-title">QUEM VAI EXPLORAR?</h1>

        <div className="px-box hero-picker">
          <button className="px-btn round" onClick={() => step(-1)} aria-label="Anterior">
            <Icon name="back" size={22} />
          </button>
          <div className="hero-stage">
            <div className="platform">
              <CharacterSprite characterId={def.id} modality={modality} facing="down" />
              {locked && (
                <div className="lock-overlay">
                  <Icon name="lock" size={36} />
                  <span>{def.price} moedas</span>
                </div>
              )}
            </div>
            <div className="hero-name">{def.name}</div>
            <div className="hero-tag">{locked ? 'Desbloqueie com moedas coletadas nas suas atividades.' : def.tagline}</div>
          </div>
          <button className="px-btn round" onClick={() => step(1)} aria-label="Próximo">
            <Icon name="back" size={22} style={{ transform: 'scaleX(-1)' }} />
          </button>
        </div>

        <div className="field">
          <label>Modalidade</label>
          <div className="mode-cards">
            <button
              className={`px-btn mode-card ${modality === 'bike' ? 'mint' : ''}`}
              onClick={() => {
                sfx.click();
                setModality('bike');
              }}
            >
              <Icon name="bike" size={36} color={modality === 'bike' ? '#1d1730' : '#fff6e0'} />
              Ciclismo
              <small>explore mais longe</small>
            </button>
            <button
              className={`px-btn mode-card ${modality === 'run' ? 'coral' : ''}`}
              onClick={() => {
                sfx.click();
                setModality('run');
              }}
            >
              <Icon name="run" size={36} />
              Corrida
              <small>mais XP por km</small>
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="hero-name">Como te chamam?</label>
          <input
            id="hero-name"
            className="px-input"
            maxLength={18}
            placeholder="Seu apelido"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
          />
        </div>

        <button
          className="px-btn gold block"
          disabled={locked}
          onClick={() => {
            sfx.capture();
            createProfile(name, def.id, modality);
          }}
          style={{ padding: '16px 16px 20px' }}
        >
          <span className="arcade" style={{ fontSize: 13 }}>COMEÇAR AVENTURA</span>
        </button>
      </div>
    </div>
  );
}
