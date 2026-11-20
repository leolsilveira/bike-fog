// Aba Gravar: parado (pílula de GPS, modalidade, INICIAR), gravando e pausado (painel ao vivo, chips,
// Pausar/Retomar/Finalizar). Port de legacy/src/ui/screens/RecordTab.tsx + global.css.
// A vinheta e o tilt-shift do modo gravar são desenhados pelo próprio mapa (mensagem `mode`), não aqui.
import { useEffect, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { liveElapsed, useGame } from '../../game/store.ts';
import { player } from '../../game/location.ts';
import { finishAndSaveTrack, kickTracker } from '../../game/tracker.ts';
import { saveNow } from '../../game/persist.ts';
import { sfx } from '../../game/audio.ts';
import { cellSizeM, formatArea, formatDistance, formatDuration, formatPace, formatSpeed } from '../../game/geo.ts';
import type { GpsStatus } from '../../game/types.ts';
import type { IconName } from '../../sprites/icons.ts';
import { CoinImg, Icon, PoiIconImg } from '../components/Sprites.tsx';
import { CityChip, SideButtons, useNow } from '../components/Hud.tsx';
import { Arcade, Chip, Hint, PxBox, PxButton, Txt } from '../components/Px.tsx';
import { C, FILL, M, useSafe } from '../theme.ts';

const GPS_LABEL: Record<GpsStatus, [string, string]> = {
  off: ['GPS desligado', C.coral],
  searching: ['Procurando GPS…', C.gold],
  ok: ['GPS ok', C.mint],
  weak: ['GPS fraco', C.gold],
  denied: ['GPS bloqueado', C.coral],
  unavailable: ['GPS indisponível', C.coral],
  sim: ['Simulador', C.violet],
};

const KEEP_AWAKE_TAG = 'desbrava-gravacao';

/**
 * Tela acesa durante a gravação (expo-keep-awake; na web é a Wake Lock API, como no original).
 * O navegador solta a trava quando a aba fica oculta: na web ela é pedida de novo ao voltar. No celular o
 * módulo nativo já religa sozinho ao voltar para o primeiro plano. As chamadas vão numa fila para o desligar
 * nunca passar na frente de um ligar pendente.
 */
function useKeepAwakeWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let queue: Promise<unknown> = Promise.resolve();
    const run = (fn: () => Promise<unknown>) => {
      queue = queue.then(fn).catch(() => undefined);
    };
    const acquire = (again: boolean) =>
      run(async () => {
        if (!alive) return;
        if (again) await deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      });
    acquire(false);
    const sub =
      Platform.OS === 'web' ? AppState.addEventListener('change', (st) => st === 'active' && acquire(true)) : null;
    return () => {
      alive = false;
      sub?.remove();
      run(() => deactivateKeepAwake(KEEP_AWAKE_TAG));
    };
  }, [active]);
}

/** `clamp(min, vw%, max)` do CSS. */
function clampVw(width: number, min: number, vw: number, max: number): number {
  return Math.min(max, Math.max(min, (width * vw) / 100));
}

export function RecordTab() {
  const live = useGame((s) => s.live);
  const profile = useGame((s) => s.profile);
  const gps = useGame((s) => s.gps);
  const fix = useGame((s) => s.fix);
  const simulator = useGame((s) => s.settings.simulator);
  const now = useNow(500);
  const { width } = useWindowDimensions();
  const { safeT, tabbarH } = useSafe();
  useKeepAwakeWhile(live?.status === 'recording');

  if (!profile) return null;
  const { startActivity, pauseActivity, resumeActivity, finishActivity, setModality, setSetting } = useGame.getState();

  const [gpsText, gpsDot] = GPS_LABEL[gps];
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
    await saveNow();
  };

  const top = { top: 10 + safeT };
  const bottom = { bottom: tabbarH + 16 };

  if (!live) {
    const bike = profile.modality === 'bike';
    return (
      <View style={styles.layer}>
        <View style={[styles.recTopWrap, top]}>
          <View style={[styles.recTop, styles.recTopIdle]}>
            <Chip dot={gpsDot} testID="gps-pill">
              {gpsText}
              {gpsDetail}
            </Chip>
            <CityChip />
          </View>
        </View>
        <SideButtons showZoom={false} />
        <View style={[styles.recBottom, bottom]}>
          {(gps === 'denied' || gps === 'unavailable') && !simulator && (
            <PxBox style={styles.noGps} testID="no-gps">
              <Txt align="center" style={styles.noGpsText}>
                Sem acesso ao GPS. Libere a localização{' '}
                {Platform.OS === 'web' ? 'no navegador' : 'nos ajustes do aparelho'} ou jogue no modo simulador.
              </Txt>
              <PxButton variant="sky" size="small" onPress={() => setSetting('simulator', true)}>
                <Icon name="joystick" size={16} color={C.ink} accent={C.coral} /> Ativar simulador
              </PxButton>
            </PxBox>
          )}
          <View style={styles.modeToggle}>
            <PxButton
              size="small"
              variant={bike ? 'mint' : 'ghost'}
              style={styles.modeBtn}
              testID="mode-bike"
              onPress={() => {
                sfx.click();
                setModality('bike');
              }}
            >
              <Icon name="bike" size={20} color={bike ? C.ink : C.cream} /> Ciclismo
            </PxButton>
            <PxButton
              size="small"
              variant={!bike ? 'coral' : 'ghost'}
              style={styles.modeBtn}
              testID="mode-run"
              onPress={() => {
                sfx.click();
                setModality('run');
              }}
            >
              <Icon name="run" size={20} /> Corrida
            </PxButton>
          </View>
          <PxButton variant="gold" disabled={!canStart} onPress={start} fontSize={20} style={styles.startBtn} testID="start">
            <Icon name="play" size={28} color={C.ink} />
            <Arcade size={15}>INICIAR</Arcade>
          </PxButton>
          <Hint>
            {canStart
              ? 'Moedas novas aparecem a cada atividade. Passe perto dos pontos para capturá-los!'
              : 'Aguardando sinal do GPS…'}
          </Hint>
        </View>
      </View>
    );
  }

  const elapsed = liveElapsed(live, now);
  const avg = live.movingS > 0 ? live.distanceM / live.movingS : 0;
  const speedNow = player.speed;
  const isBike = live.modality === 'bike';
  const area = live.newCells * cellSizeM(fix?.lat ?? -23.5) ** 2;
  const valSize = clampVw(width, 13, 4, 22);
  const bigSize = clampVw(width, 18, 6, 30);
  const nCaptures = live.captures.length;

  return (
    <View style={styles.layer}>
      <View style={[styles.recTopWrap, top]}>
        <View style={styles.recTop}>
          <PxBox style={styles.recStats} testID="rec-stats">
            <Stat icon="clock" label="Tempo" grow={1.25}>
              <Arcade size={bigSize} spacing={0} color={C.gold} style={styles.noShrink}>
                {formatDuration(elapsed)}
              </Arcade>
            </Stat>
            <Stat icon="flag" label="Dist.">
              <Val size={valSize} unit="km">
                {(live.distanceM / 1000).toFixed(2).replace('.', ',')}
              </Val>
            </Stat>
            <Stat icon="bolt" label={isBike ? 'Veloc.' : 'Pace/km'}>
              <Val size={valSize} unit={isBike ? 'km/h' : undefined}>
                {isBike ? formatSpeed(speedNow) : formatPace(speedNow)}
              </Val>
            </Stat>
          </PxBox>
          <View style={styles.recChips}>
            <Chip>
              <CoinImg size={16} /> {live.coinsValue}
            </Chip>
            <Chip>
              <PoiIconImg category="atracao" size={16} /> {nCaptures} {nCaptures === 1 ? 'captura' : 'capturas'}
            </Chip>
            <Chip>
              <Icon name="cloud" size={16} accent={C.iconMuted} /> +{formatArea(area)}
            </Chip>
            <Chip color={C.muted}>média {isBike ? `${formatSpeed(avg)} km/h` : `${formatPace(avg)}/km`}</Chip>
          </View>
        </View>
      </View>
      <SideButtons showZoom={false} />
      <View style={[styles.recBottom, bottom]}>
        {live.status === 'paused' && (
          <Hint size={15}>
            Pausado · {formatDistance(live.distanceM)} até agora
          </Hint>
        )}
        <View style={styles.recControls}>
          {live.status === 'recording' ? (
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

/** Coluna do painel ao vivo (`.rec-stat`): rótulo pequeno com ícone e valor embaixo. */
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

/**
 * Valor em Press Start com a unidade menor (`<small>`: 0,55em, muted, 3 px à esquerda) na mesma linha de base.
 * Sem quebra de linha, como o `white-space: nowrap` do original (o que não cabe transborda, não corta).
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

  // .rec-top: absoluto no topo, até 560 px, centralizado
  recTopWrap: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    alignItems: 'center',
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  // como `.hud-layer > *` no original, o bloco inteiro segura o toque: um toque errado pedalando não mexe no mapa
  recTop: { width: '100%', maxWidth: 560 },
  recTopIdle: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },

  // .rec-stats: grade 1.25fr 1fr 1fr alinhada embaixo
  recStats: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    columnGap: 10,
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  stat: { flexBasis: 0, flexShrink: 1, minWidth: 0, gap: 4 },
  lbl: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  val: { flexDirection: 'row', alignItems: 'baseline' },
  noShrink: { flexShrink: 0 },
  unit: { flexShrink: 0, marginLeft: 3 },
  recChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginTop: 12,
    pointerEvents: 'box-none',
  },

  // .rec-bottom: coluna centralizada acima da barra de abas
  recBottom: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    alignItems: 'center',
    gap: 12,
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  noGps: { padding: 12, maxWidth: 340, alignItems: 'center' },
  noGpsText: { alignSelf: 'stretch', marginBottom: 10 },
  modeToggle: { flexDirection: 'row', gap: 10 },
  modeBtn: { minWidth: 128 },
  startBtn: { width: '100%', maxWidth: 320, paddingTop: 16, paddingHorizontal: 20, paddingBottom: 20 },
  recControls: { flexDirection: 'row', gap: 14, justifyContent: 'center' },
  ctrlBtn: { minWidth: 140, paddingTop: 14, paddingHorizontal: 18, paddingBottom: 18 },
});
