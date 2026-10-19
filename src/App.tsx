import { useEffect, useState } from 'react';
import { initGame } from './game/index.ts';
import { useGame } from './game/store.ts';
import { TitleScreen } from './ui/screens/TitleScreen.tsx';
import { CreateScreen } from './ui/screens/CreateScreen.tsx';
import { MapTab } from './ui/screens/MapTab.tsx';
import { RecordTab } from './ui/screens/RecordTab.tsx';
import { StatsScreen } from './ui/screens/StatsScreen.tsx';
import { MapStage, PoiCard, SimPad, SpeedBanner, TabBar, Toasts } from './ui/components/Hud.tsx';
import { ModalHost } from './ui/components/Modals.tsx';

function Game() {
  const tab = useGame((s) => s.tab);
  return (
    <>
      <MapStage />
      {tab === 'map' && <MapTab />}
      {tab === 'record' && <RecordTab />}
      {tab === 'stats' && <StatsScreen />}
      <SpeedBanner />
      <SimPad />
      {tab !== 'stats' && <PoiCard />}
      <TabBar />
    </>
  );
}

export function App() {
  const hydrated = useGame((s) => s.hydrated);
  const profile = useGame((s) => s.profile);
  const [started, setStarted] = useState(() => new URLSearchParams(location.search).has('skip'));

  useEffect(() => {
    void initGame();
  }, []);

  if (!hydrated) return <div className="loading">CARREGANDO…</div>;

  return (
    <div className="app">
      {!started ? <TitleScreen onStart={() => setStarted(true)} /> : profile ? <Game /> : <CreateScreen />}
      <Toasts />
      <ModalHost />
    </div>
  );
}
