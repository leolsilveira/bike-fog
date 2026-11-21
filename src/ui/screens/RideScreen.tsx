// Tela da atividade em andamento (gravando ou pausada), por cima da câmera inclinada do mapa: painel de status
// no topo (tempo, distância, velocidade/ritmo, média, máxima, moedas, capturas), chips de área revelada, cidade
// e GPS, e os controles Pausar/Retomar/Finalizar embaixo. A vinheta e o tilt-shift são desenhados pelo mapa.
import type { ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { liveElapsed, useGame } from '../../game/store.ts';
import { player } from '../../game/location.ts';
import { finishAndSaveTrack, kickTracker } from '../../game/tracker.ts';
import { sfx } from '../../game/audio.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration, formatPace, formatSpeed } from '../../game/geo.ts';
import { OFF_ROUTE_M } from '../../game/route.ts';
import type { PlannedRoute, RouteProgress } from '../../game/types.ts';
import type { IconName } from '../../sprites/icons.ts';
import { CoinImg, Icon, PoiIconImg } from '../components/Sprites.tsx';
import { CityChip, SideButtons, useNow } from '../components/Hud.tsx';
import { Arcade, Bar, Chip, Hint, Muted, PxBox, PxButton, Txt } from '../components/Px.tsx';
import { C, FILL, M, useSafe } from '../theme.ts';
import { GPS_LABEL } from './gpsLabel.ts';

/** `clamp(min, vw%, max)` do CSS. */
function clampVw(width: number, min: number, vw: number, max: number): number {
  return Math.min(max, Math.max(min, (width * vw) / 100));
}

export function RideScreen() {
  const live = useGame((s) => s.live);
  const gps = useGame((s) => s.gps);
  const fix = useGame((s) => s.fix);
  const route = useGame((s) => s.route);
  const progress = useGame((s) => s.routeProgress);
  const now = useNow(500);
  const { width } = useWindowDimensions();
  const { safeT, tabbarH } = useSafe();

  if (!live) return null;
  const { pauseActivity, resumeActivity, finishActivity } = useGame.getState();

  const finish = async () => {
    sfx.stop();
    await finishAndSaveTrack();
    finishActivity();
  };

  const paused = live.status === 'paused';
  const elapsed = liveElapsed(live, now);
  const avg = live.movingS > 0 ? live.distanceM / live.movingS : 0;
  const speedNow = paused ? 0 : player.speed;
  const isBike = live.modality === 'bike';
  const area = live.newCells * cellSizeM(fix?.lat ?? -23.5) ** 2;
  const valSize = clampVw(width, 13, 4, 22);
  const bigSize = clampVw(width, 18, 6, 30);
  const miniSize = clampVw(width, 10, 2.8, 14);
  const nCaptures = live.captures.length;
  const gpsBad = gps !== 'ok' && gps !== 'sim';
  const [gpsText, gpsDot] = GPS_LABEL[gps];

  return (
    <View style={styles.layer}>
      <View style={[styles.topWrap, { top: 10 + safeT }]}>
        <View style={styles.top}>
          <PxBox style={styles.panel} testID="rec-stats">
            <View style={styles.row}>
              <Stat icon="clock" label={paused ? 'Pausado' : 'Tempo'} grow={1.25}>
                <Arcade size={bigSize} spacing={0} color={paused ? C.muted : C.gold} style={styles.noShrink}>
                  {formatDuration(elapsed)}
                </Arcade>
              </Stat>
              <Stat icon="flag" label="Distância">
                <Val size={valSize} unit="km">
                  {(live.distanceM / 1000).toFixed(2).replace('.', ',')}
                </Val>
              </Stat>
              <Stat icon={isBike ? 'bolt' : 'run'} label={isBike ? 'Veloc.' : 'Ritmo'}>
                <Val size={valSize} unit={isBike ? 'km/h' : '/km'}>
                  {isBike ? formatSpeed(speedNow) : formatPace(speedNow)}
                </Val>
              </Stat>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Mini label="Média">
                <Val size={miniSize} unit={isBike ? 'km/h' : '/km'}>
                  {isBike ? formatSpeed(avg) : formatPace(avg)}
                </Val>
              </Mini>
              <Mini label={isBike ? 'Máxima' : 'Melhor'}>
                <Val size={miniSize} unit={isBike ? 'km/h' : '/km'}>
                  {isBike ? formatSpeed(live.maxSpeed) : formatPace(live.maxSpeed)}
                </Val>
              </Mini>
              <Mini label="Moedas">
                <View style={styles.iconVal}>
                  <CoinImg size={miniSize + 4} />
                  <Arcade size={miniSize} spacing={0} color={C.gold}>
                    {live.coinsValue}
                  </Arcade>
                </View>
              </Mini>
              <Mini label="Capturas">
                <View style={styles.iconVal}>
                  <PoiIconImg category="atracao" size={miniSize + 4} />
                  <Arcade size={miniSize} spacing={0}>
                    {nCaptures}
                  </Arcade>
                </View>
              </Mini>
            </View>
          </PxBox>
          {route && <RouteBar route={route} progress={progress} />}
          <View style={styles.chips}>
            <Chip>
              <Icon name="cloud" size={16} accent={C.iconMuted} /> +{formatArea(area)} revelados
            </Chip>
            <CityChip />
            {gpsBad && (
              <Chip dot={gpsDot} testID="gps-pill">
                {gpsText}
              </Chip>
            )}
          </View>
        </View>
      </View>
      <SideButtons showZoom={false} />
      <View style={[styles.bottom, { bottom: tabbarH + 16 }]}>
        {paused && <Hint size={15}>Pausado · {formatDistance(live.distanceM)} até agora</Hint>}
        <View style={styles.controls}>
          {!paused ? (
            <PxButton
              variant="cream"
              fontSize={17}
              style={styles.ctrlBtn}
              testID="pause"
              onPress={() => {
                sfx.pause();
                pauseActivity();
              }}
            >
              <Icon name="pause" size={20} color={C.ink} /> Pausar
            </PxButton>
          ) : (
            <>
              <PxButton
                variant="mint"
                fontSize={17}
                style={styles.ctrlBtn}
                testID="resume"
                onPress={() => {
                  sfx.start();
                  resumeActivity();
                  kickTracker();
                }}
              >
                <Icon name="play" size={20} color={C.ink} /> Retomar
              </PxButton>
              <PxButton variant="coral" fontSize={17} style={styles.ctrlBtn} testID="finish" onPress={() => void finish()}>
                <Icon name="stop" size={20} /> Finalizar
              </PxButton>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

/** Faixa da rota planejada: destino, quanto falta e progresso; fora do trajeto, a rota se recalcula sozinha. */
function RouteBar({ route, progress }: { route: PlannedRoute; progress: RouteProgress | null }) {
  const rerouting = useGame((s) => s.rerouting);
  const arrived = progress?.arrived === true;
  const off = !arrived && progress != null && progress.offRouteM > OFF_ROUTE_M;
  const total = progress ? progress.doneM + progress.remainingM : route.distanceM;
  const pct = arrived ? 100 : total > 0 ? ((progress?.doneM ?? 0) / total) * 100 : 0;

  let sub: string;
  let warn = false;
  if (arrived) sub = route.roundTrip || route.kind === 'loop' ? 'Volta completa!' : 'Você chegou!';
  else if (rerouting === 'busy') sub = 'Recalculando rota…';
  else if (off) {
    warn = true;
    sub = rerouting === 'failed' ? 'Fora da rota · sem internet, tentando de novo' : 'Fora da rota';
  } else if (progress) sub = `faltam ${formatDistance(progress.remainingM)}`;
  else sub = `${formatDistance(route.distanceM)} de rota`;
  const back = route.roundTrip && route.stops.length === 1 && !arrived;

  return (
    <PxBox style={styles.route} bg={arrived ? C.mint : undefined} color={arrived ? C.ink : undefined} testID="route-bar">
      <View style={styles.routeHead}>
        <Icon name="flag" size={20} color={arrived ? C.ink : C.gold} />
        <View style={styles.routeText}>
          <Txt weight={700} size={14} numberOfLines={1}>
            {back ? 'Voltando ao início' : route.dest.name}
          </Txt>
          {arrived ? (
            <Txt size={13} weight={600}>
              {sub}
            </Txt>
          ) : (
            <Muted size={13} weight={600} color={warn ? C.coral : C.muted} numberOfLines={1}>
              {sub}
            </Muted>
          )}
        </View>
      </View>
      {!arrived && <Bar percent={pct} height={8} />}
    </PxBox>
  );
}

/** Coluna principal do painel: rótulo pequeno com ícone e valor grande embaixo. */
function Stat({ icon, label, grow = 1, children }: { icon: IconName; label: string; grow?: number; children: ReactNode }) {
  return (
    <View style={[styles.stat, { flexGrow: grow }]}>
      <View style={styles.lbl}>
        <Icon name={icon} size={14} />
        <Txt size={12} weight={600} color={C.muted} upper spacing={0.06} numberOfLines={1}>
          {label}
        </Txt>
      </View>
      {children}
    </View>
  );
}

/** Coluna secundária (linha de baixo do painel): só rótulo e valor menor. */
function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.stat}>
      <Txt size={11} weight={600} color={C.muted} upper spacing={0.06} numberOfLines={1}>
        {label}
      </Txt>
      {children}
    </View>
  );
}

/**
 * Valor em Press Start com a unidade menor (0,55em, muted, 3 px à esquerda) na mesma linha de base.
 * Sem quebra de linha: o que não cabe transborda, não corta.
 */
function Val({ size, unit, children }: { size: number; unit?: string; children: ReactNode }) {
  return (
    <View style={styles.val}>
      <Arcade size={size} spacing={0} style={styles.noShrink}>
        {children}
      </Arcade>
      {unit && (
        <Arcade size={size * 0.55} spacing={0} color={C.muted} style={styles.unit}>
          {unit}
        </Arcade>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...FILL, pointerEvents: 'box-none' },

  // painel no topo, até 560 px, centralizado
  topWrap: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    alignItems: 'center',
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  // o bloco inteiro segura o toque: um toque errado pedalando não mexe no mapa
  top: { width: '100%', maxWidth: 560 },
  panel: { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-end', columnGap: 10 },
  divider: { height: 2, backgroundColor: C.line, marginVertical: 10, opacity: 0.6 },
  stat: { flexGrow: 1, flexBasis: 0, flexShrink: 1, minWidth: 0, gap: 4 },
  lbl: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  val: { flexDirection: 'row', alignItems: 'baseline' },
  iconVal: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  noShrink: { flexShrink: 0 },
  unit: { flexShrink: 0, marginLeft: 3 },
  route: { marginTop: 10, paddingTop: 8, paddingHorizontal: 12, paddingBottom: 10, gap: 8 },
  routeHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  routeText: { flex: 1, minWidth: 0 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginTop: 12,
    pointerEvents: 'box-none',
  },

  bottom: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    alignItems: 'center',
    gap: 12,
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  controls: { flexDirection: 'row', gap: 14, justifyContent: 'center' },
  ctrlBtn: { minWidth: 140, paddingTop: 14, paddingHorizontal: 18, paddingBottom: 18 },
});
