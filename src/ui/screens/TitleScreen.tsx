import { GAME_NAME, GAME_TAGLINE } from '../../game/config.ts';
import { sfx, unlockAudio } from '../../game/audio.ts';
import { useGame } from '../../game/store.ts';
import { CharacterSprite } from '../components/Sprites.tsx';

const CLOUDS = [
  { top: '8%', width: 120, dur: 46, delay: -10 },
  { top: '18%', width: 80, dur: 34, delay: -22 },
  { top: '30%', width: 150, dur: 58, delay: -40 },
  { top: '12%', width: 60, dur: 28, delay: -5 },
];

export function TitleScreen({ onStart }: { onStart: () => void }) {
  const profile = useGame((s) => s.profile);
  const start = () => {
    unlockAudio();
    sfx.start();
    onStart();
  };
  return (
    <div className="screen title-screen" onClick={start}>
      <div className="clouds" aria-hidden>
        {CLOUDS.map((c, i) => (
          <div
            key={i}
            className="cloud"
            style={{ top: c.top, width: c.width, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }}
          />
        ))}
      </div>
      <h1 className="logo">{GAME_NAME.toUpperCase()}</h1>
      <div className="tagline">{GAME_TAGLINE}</div>
      <div className="title-hero" aria-hidden>
        <CharacterSprite characterId="dandara" modality="run" facing="right" />
        <CharacterSprite characterId="lia" modality="bike" facing="right" />
        <CharacterSprite characterId="teo" modality="run" facing="right" />
      </div>
      <button className="px-btn gold press-start" onClick={start}>
        <span className="arcade">{profile ? 'CONTINUAR' : 'COMEÇAR'}</span>
      </button>
      <p className="title-foot">
        Um jogo de exploração para ciclistas e corredores. Revele a névoa da sua cidade, capture pontos turísticos e colete
        moedas a cada pedalada.
      </p>
    </div>
  );
}
