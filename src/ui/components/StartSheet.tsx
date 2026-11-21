// Folha "Nova atividade": abre pelo botão do meio da barra (Gravar), por cima do mapa na visão de cima.
// Escolhe modalidade e rota e dá INICIAR; só então o mapa passa para a câmera inclinada (RideScreen).
// Rotas: livre (sem trajeto), até um endereço (busca + traçado, só ida ou ida e volta) ou automática (volta
// com a distância pedida, puxando para a névoa). A rota fica enquadrada no mapa acima da folha, e o mapa
// continua livre para arrastar e dar zoom antes de iniciar ("Ver rota" reenquadra).
import { useEffect, useRef, useState } from 'react';
import {
  Animated, BackHandler, Platform, Pressable, StyleSheet, useWindowDimensions, View, type ViewStyle,
} from 'react-native';
import { useGame } from '../../game/store.ts';
import { kickTracker } from '../../game/tracker.ts';
import { player } from '../../game/location.ts';
import { planLoop, planRoute, routeBounds, typicalSpeed } from '../../game/route.ts';
import { formatDistance, type LngLat } from '../../game/geo.ts';
import { sfx } from '../../game/audio.ts';
import { mapController } from '../../map/controller.ts';
import type { Modality, Place, PlannedRoute } from '../../game/types.ts';
import type { IconName } from '../../sprites/icons.ts';
import { GPS_LABEL } from '../screens/gpsLabel.ts';
import { PlaceSearch } from './PlaceSearch.tsx';
import { Icon } from './Sprites.tsx';
import { Arcade, Chip, Hint, Muted, PxBox, PxButton, PxCell, Txt } from './Px.tsx';
import { C, FILL, M, useSafe } from '../theme.ts';

const useNativeDriver = Platform.OS !== 'web';

type RouteKind = 'free' | 'auto' | 'address';
type PlanStatus = 'idle' | 'loading' | 'error' | 'nofix';

const ROUTES: { id: RouteKind; label: string; sub: string; icon: IconName; soon: boolean }[] = [
  { id: 'free', label: 'Livre', sub: 'sem trajeto', icon: 'pin', soon: false },
  { id: 'address', label: 'Até endereço', sub: 'destino', icon: 'flag', soon: false },
  { id: 'auto', label: 'Automática', sub: 'por km', icon: 'target', soon: false },
];

/** Distâncias da volta automática (− e + andam por esta lista). */
const LOOP_KM: Record<Modality, number[]> = {
  bike: [3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100],
  run: [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 25, 30, 42],
};
const LOOP_DEFAULT_KM: Record<Modality, number> = { bike: 10, run: 5 };
/** Espera depois do último toque em −/+ antes de traçar (cada volta custa até 3 pedidos ao OSRM). */
const LOOP_DEBOUNCE_MS = 500;

/** Passo seguinte (dir = ±1) na lista de distâncias; de um valor fora da lista, vai para o vizinho. */
function stepKm(mod: Modality, km: number, dir: 1 | -1): number {
  const list = LOOP_KM[mod];
  if (dir > 0) return list.find((k) => k > km) ?? list[list.length - 1];
  return [...list].reverse().find((k) => k < km) ?? list[0];
}

/** "12 min", "1 h 05 min". */
function formatEta(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Fecha a folha sem iniciar: a rota é descartada e a câmera volta para o jogador (ver sync.ts). */
function closeSheet(): void {
  useGame.getState().setPlanning(false);
}

/** Entrada em degraus, no estilo dos toasts: sobe 24 px e aparece. */
function useSlideIn(): Animated.Value {
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const a = Animated.timing(v, {
      toValue: 1,
      duration: 200,
      easing: (t) => (t >= 1 ? 1 : Math.floor(t * 4) / 4),
      useNativeDriver,
    });
    a.start();
    return () => a.stop();
  }, [v]);
  return v;
}

export function StartSheet() {
  const profile = useGame((s) => s.profile);
  const gps = useGame((s) => s.gps);
  const fix = useGame((s) => s.fix);
  const simulator = useGame((s) => s.settings.simulator);
  const route = useGame((s) => s.route);
  const { safeT, tabbarH } = useSafe();
  const { height: winH } = useWindowDimensions();
  const v = useSlideIn();
  const { setModality, setSetting, setRoute, startActivity } = useGame.getState();

  const [kind, setKind] = useState<RouteKind>(() => (route ? (route.kind === 'loop' ? 'auto' : 'address') : 'free'));
  const [dest, setDest] = useState<Place | null>(() => route?.dest ?? null);
  const [roundTrip, setRoundTrip] = useState(() => route?.roundTrip ?? false);
  const [status, setStatus] = useState<PlanStatus>('idle');
  const [searching, setSearching] = useState(false);
  /** Opções abertas; com a rota traçada a folha encolhe para mostrar o mapa. */
  const [expanded, setExpanded] = useState(() => route == null);
  const [sheetTop, setSheetTop] = useState<number | null>(null);
  const modality = profile?.modality ?? 'bike';
  const [loopKm, setLoopKm] = useState(() => LOOP_DEFAULT_KM[modality]);
  const [variant, setVariant] = useState(0);
  /** Muda para reenquadrar a rota ("Ver rota", depois de arrastar o mapa). */
  const [refit, setRefit] = useState(0);
  const planSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const close = closeSheet;

  // Android: "voltar" fecha a folha
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSheet();
      return true;
    });
    return () => sub.remove();
  }, []);

  /** Descarta traçados pendentes (respostas atrasadas e o −/+ esperando). */
  const cancelPlans = () => {
    planSeq.current++;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = null;
  };

  /** Traça a rota a partir da posição atual; só a resposta do pedido mais recente vale. */
  const runPlan = (make: (from: LngLat) => Promise<PlannedRoute>) => {
    cancelPlans();
    const from = player.display ?? useGame.getState().fix;
    const id = planSeq.current;
    if (!from) {
      setStatus('nofix');
      return;
    }
    setStatus('loading');
    make(from)
      .then((r) => {
        if (id !== planSeq.current) return;
        setRoute(r);
        setStatus('idle');
      })
      .catch((err: unknown) => {
        if (id !== planSeq.current) return;
        console.warn('[rota] traçado falhou', err);
        setRoute(null);
        setStatus('error');
      });
  };

  const plan = (d: Place, rt: boolean, mod: Modality) => runPlan((from) => planRoute(from, d, rt, mod));
  const planAuto = (km: number, vr: number, mod: Modality) =>
    runPlan((from) => planLoop(from, km * 1000, mod, vr));
  /** −/+ em sequência: traça só depois que o dedo para. */
  const planAutoSoon = (km: number, vr: number, mod: Modality) => {
    cancelPlans();
    setStatus('loading');
    debounce.current = setTimeout(() => planAuto(km, vr, mod), LOOP_DEBOUNCE_MS);
  };

  // Enquadra a rota na parte do mapa que a folha deixa livre.
  const coords = route?.coords;
  useEffect(() => {
    if (!coords || sheetTop == null) return;
    // em cima ficam o chip do jogador e o da cidade; à direita, os botões de câmera
    mapController.fit(routeBounds(coords), {
      top: safeT + 130,
      bottom: Math.max(0, winH - sheetTop) + 24,
      left: 32,
      right: 72,
    });
  }, [coords, sheetTop, safeT, winH, refit]);

  if (!profile) return null;
  const bike = modality === 'bike';
  const [gpsText, gpsDot] = GPS_LABEL[gps];
  const gpsDetail = gps === 'ok' || gps === 'weak' ? ` ±${Math.round(fix?.accuracy ?? 0)} m` : '';
  const gpsReady = simulator || gps === 'ok' || gps === 'weak';
  const routeReady = kind === 'free' || (route != null && status === 'idle');
  const canStart = gpsReady && routeReady;
  const noGps = (gps === 'denied' || gps === 'unavailable') && !simulator;

  const pickModality = (m: Modality) => {
    sfx.click();
    setModality(m);
    if (m === modality) return;
    if (kind === 'address' && dest) plan(dest, roundTrip, m);
    if (kind === 'auto') planAuto(loopKm, variant, m);
  };

  const changeKm = (dir: 1 | -1) => {
    sfx.click();
    const km = stepKm(modality, loopKm, dir);
    if (km === loopKm) return;
    setLoopKm(km);
    planAutoSoon(km, variant, modality);
  };

  const anotherLoop = () => {
    sfx.click();
    const vr = variant + 1;
    setVariant(vr);
    planAuto(loopKm, vr, modality);
  };

  const pickTrip = (rt: boolean) => {
    sfx.click();
    setRoundTrip(rt);
    if (dest && rt !== roundTrip) plan(dest, rt, modality);
  };

  const pickKind = (k: RouteKind) => {
    sfx.click();
    if (k === kind) return;
    setKind(k);
    // trocar de tipo descarta a rota anterior
    cancelPlans();
    setRoute(null);
    setStatus('idle');
    if (k === 'free') {
      mapController.recenter();
    } else if (k === 'address') {
      if (!dest) setSearching(true);
      else plan(dest, roundTrip, modality);
    } else {
      setExpanded(false);
      planAuto(loopKm, variant, modality);
    }
  };

  const start = () => {
    sfx.start();
    startActivity();
    kickTracker();
  };

  const slide = {
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
  };

  let hint: string;
  if (!gpsReady) hint = 'Aguardando sinal do GPS…';
  else if (kind === 'address' && !dest) hint = 'Escolha o destino para traçar a rota.';
  else if (kind !== 'free') hint = 'A rota aparece no mapa durante a atividade. Saiu dela? Ela se recalcula sozinha.';
  else hint = 'Moedas novas aparecem a cada atividade. Passe perto dos pontos para capturá-los!';

  return (
    <View style={styles.layer} testID="start-sheet">
      <Animated.View
        style={[styles.wrap, { bottom: tabbarH + 8 }, slide]}
        onLayout={(e) => {
          const top = e.nativeEvent.layout.y;
          setSheetTop((prev) => (prev != null && Math.abs(prev - top) < 24 ? prev : top));
        }}
      >
        <PxBox style={styles.sheet}>
          <View style={styles.head}>
            <Arcade size={14} weight={700} color={C.gold}>
              NOVA ATIVIDADE
            </Arcade>
            <PxButton variant="ghost" size="round" onPress={close} label="Fechar" testID="start-close">
              <Icon name="close" size={16} />
            </PxButton>
          </View>

          {expanded ? (
            <>
              <View style={styles.gpsRow}>
                <Chip dot={gpsDot} testID="gps-pill">
                  {gpsText}
                  {gpsDetail}
                </Chip>
              </View>

              <Label>Modalidade</Label>
              <View style={styles.row}>
                <PxButton
                  size="small"
                  variant={bike ? 'mint' : 'ghost'}
                  style={styles.grow}
                  testID="mode-bike"
                  onPress={() => pickModality('bike')}
                >
                  <Icon name="bike" size={20} color={bike ? C.ink : C.cream} /> Ciclismo
                </PxButton>
                <PxButton
                  size="small"
                  variant={!bike ? 'coral' : 'ghost'}
                  style={styles.grow}
                  testID="mode-run"
                  onPress={() => pickModality('run')}
                >
                  <Icon name="run" size={20} /> Corrida
                </PxButton>
              </View>

              <Label>Rota</Label>
              <View style={styles.row}>
                {ROUTES.map((r) => (
                  <PxCell
                    key={r.id}
                    selected={kind === r.id}
                    style={[styles.grow, styles.routeCell, r.soon && styles.soon]}
                    testID={`route-${r.id}`}
                    onPress={r.soon ? undefined : () => pickKind(r.id)}
                  >
                    <Icon name={r.icon} size={22} color={kind === r.id ? C.gold : C.cream} />
                    <Txt size={13} weight={700} align="center" numberOfLines={1}>
                      {r.label}
                    </Txt>
                    <Txt size={10} weight={600} upper spacing={0.06} color={C.muted} numberOfLines={1}>
                      {r.sub}
                    </Txt>
                  </PxCell>
                ))}
              </View>
            </>
          ) : (
            // prévia da rota: a folha encolhe para o mapa mostrar o trajeto; "Alterar" volta às opções
            <Pressable style={styles.compact} onPress={() => setExpanded(true)} testID="sheet-expand">
              <Chip dot={gpsDot}>{gpsText}</Chip>
              <View style={styles.compactMode}>
                <Icon name={bike ? 'bike' : 'run'} size={18} />
                <Txt size={14} weight={700} numberOfLines={1}>
                  {bike ? 'Ciclismo' : 'Corrida'}
                </Txt>
              </View>
              <Txt size={13} weight={700} color={C.gold}>
                Alterar
              </Txt>
            </Pressable>
          )}

          {kind === 'address' && (
            <View style={styles.dest} testID="route-dest">
              <Pressable style={styles.destRow} onPress={() => setSearching(true)} testID="dest-pick">
                <Icon name="flag" size={22} color={C.gold} />
                <View style={styles.destText}>
                  <Txt weight={700} size={15} numberOfLines={1}>
                    {dest ? dest.name : 'Escolher destino'}
                  </Txt>
                  <Muted size={13} numberOfLines={1}>
                    {dest ? dest.detail || 'Destino' : 'Busque um endereço ou lugar'}
                  </Muted>
                </View>
                <Txt size={13} weight={700} color={C.gold}>
                  {dest ? 'Trocar' : 'Buscar'}
                </Txt>
              </Pressable>
              {dest && (
                <>
                  <View style={styles.row}>
                    <PxButton
                      size="small"
                      variant={!roundTrip ? 'sky' : 'ghost'}
                      style={styles.grow}
                      testID="trip-oneway"
                      onPress={() => pickTrip(false)}
                    >
                      Só ida
                    </PxButton>
                    <PxButton
                      size="small"
                      variant={roundTrip ? 'sky' : 'ghost'}
                      style={styles.grow}
                      testID="trip-round"
                      onPress={() => pickTrip(true)}
                    >
                      Ida e volta
                    </PxButton>
                  </View>
                  <RouteSummary
                    status={status}
                    route={route}
                    speed={typicalSpeed(modality)}
                    onRetry={() => plan(dest, roundTrip, modality)}
                    onShow={() => setRefit((n) => n + 1)}
                  />
                </>
              )}
            </View>
          )}

          {kind === 'auto' && (
            <View style={styles.dest} testID="route-auto">
              <View style={styles.destRow}>
                <Icon name="target" size={22} color={C.gold} />
                <View style={styles.destText}>
                  <Txt weight={700} size={15} numberOfLines={1}>
                    Volta de {String(loopKm).replace('.', ',')} km
                  </Txt>
                  <Muted size={13} numberOfLines={1}>
                    Sai e volta aqui, rumo à névoa
                  </Muted>
                </View>
                <PxButton size="small" variant="ghost" onPress={anotherLoop} testID="loop-next">
                  Outra
                </PxButton>
              </View>
              <View style={styles.row}>
                <PxButton
                  size="small"
                  variant="ghost"
                  style={styles.stepBtn}
                  onPress={() => changeKm(-1)}
                  label="Menos"
                  testID="loop-minus"
                >
                  <Txt size={18} weight={700}>
                    −
                  </Txt>
                </PxButton>
                <View style={styles.kmBox}>
                  <Arcade size={16} spacing={0}>
                    {loopKm}
                  </Arcade>
                  <Arcade size={9} spacing={0} color={C.muted}>
                    km
                  </Arcade>
                </View>
                <PxButton
                  size="small"
                  variant="ghost"
                  style={styles.stepBtn}
                  onPress={() => changeKm(1)}
                  label="Mais"
                  testID="loop-plus"
                >
                  <Txt size={18} weight={700}>
                    +
                  </Txt>
                </PxButton>
              </View>
              <RouteSummary
                status={status}
                route={route}
                speed={typicalSpeed(modality)}
                onRetry={() => planAuto(loopKm, variant, modality)}
                onShow={() => setRefit((n) => n + 1)}
              />
            </View>
          )}

          {noGps && (
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

          <PxButton variant="gold" disabled={!canStart} onPress={start} fontSize={20} style={styles.startBtn} testID="start">
            <Icon name="play" size={28} color={C.ink} />
            <Arcade size={15}>INICIAR</Arcade>
          </PxButton>
          {expanded && <Hint>{hint}</Hint>}
        </PxBox>
      </Animated.View>

      {searching && (
        <PlaceSearch
          onClose={() => {
            setSearching(false);
            if (!dest) setKind('free');
          }}
          onPick={(p) => {
            setSearching(false);
            setDest(p);
            setExpanded(false);
            plan(p, roundTrip, modality);
          }}
        />
      )}
    </View>
  );
}

function RouteSummary({ status, route, speed, onRetry, onShow }: {
  status: PlanStatus;
  route: PlannedRoute | null;
  speed: number;
  onRetry: () => void;
  onShow: () => void;
}) {
  if (status === 'loading') {
    return <Muted size={14}>Traçando rota…</Muted>;
  }
  if (status === 'nofix') {
    return <Muted size={14}>Esperando sua posição para traçar a rota…</Muted>;
  }
  if (status === 'error' || route == null) {
    return (
      <View style={styles.summaryRow}>
        <Txt size={14} color={C.coral} style={styles.grow}>
          Não deu para traçar a rota.
        </Txt>
        <PxButton size="small" variant="ghost" onPress={onRetry} testID="route-retry">
          Tentar de novo
        </PxButton>
      </View>
    );
  }
  return (
    <View style={styles.summaryRow} testID="route-summary">
      <View style={styles.summaryText}>
        <View style={styles.summaryLine}>
          <Arcade size={14} spacing={0}>
            {formatDistance(route.distanceM)}
          </Arcade>
          <Muted size={14}>· ~{formatEta(route.distanceM / speed)}</Muted>
        </View>
        <Muted size={13} numberOfLines={1}>
          {Math.round(route.fogShare * 100)}% do caminho na névoa
        </Muted>
      </View>
      <PxButton size="small" variant="ghost" onPress={onShow} testID="route-show">
        Ver rota
      </PxButton>
    </View>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Txt size={12} weight={700} color={C.muted} upper spacing={0.08} style={styles.label}>
      {children}
    </Txt>
  );
}

const styles = StyleSheet.create({
  layer: { ...FILL, zIndex: 25, pointerEvents: 'box-none' } as ViewStyle,
  wrap: { position: 'absolute', left: M.gutter, right: M.gutter, alignItems: 'center', pointerEvents: 'box-none' },
  sheet: { width: '100%', maxWidth: 520, paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gpsRow: { flexDirection: 'row' },
  compact: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  compactMode: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { marginTop: 2 },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flexGrow: 1, flexBasis: 0 },
  routeCell: { alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 6 },
  soon: { opacity: 0.5 },
  dest: { gap: 10, padding: 10, backgroundColor: C.panel2 },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  destText: { flex: 1, minWidth: 0 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryText: { flex: 1, minWidth: 0, gap: 2 },
  summaryLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  stepBtn: { minWidth: 52 },
  kmBox: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    backgroundColor: C.ink,
  },
  noGps: { padding: 12, alignItems: 'center' },
  noGpsText: { alignSelf: 'stretch', marginBottom: 10 },
  startBtn: { alignSelf: 'stretch', marginTop: 4, paddingTop: 16, paddingHorizontal: 20, paddingBottom: 20 },
});
