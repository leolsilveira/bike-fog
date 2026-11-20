// Aba Mapa: HUD do topo (jogador, carteira, cidade, zoom) e o painel "Por perto", que recolhe e expande,
// com a lista horizontal dos POIs ainda não capturados. Port de legacy/src/ui/screens/MapTab.tsx + global.css.
import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, type TextStyle } from 'react-native';
import { useGame } from '../../game/store.ts';
import { pois } from '../../game/pois.ts';
import { player } from '../../game/location.ts';
import { fog } from '../../game/fog.ts';
import { cellOf, formatDistance } from '../../game/geo.ts';
import { POI_NEARBY_M } from '../../game/config.ts';
import { sfx } from '../../game/audio.ts';
import { mapController } from '../../map/controller.ts';
import type { Poi } from '../../game/types.ts';
import { BadgeImg } from '../components/Sprites.tsx';
import { CityChip, PlayerChip, SideButtons, TopHud, useNow, Wallet } from '../components/Hud.tsx';
import { Arcade, Muted, PxBox, PxCell, Txt } from '../components/Px.tsx';
import { C, FILL, FONT, M, useSafe } from '../theme.ts';

// O CityChip mora em Hud.tsx (usado também pela aba Gravar); reexportado aqui como no original.
export { CityChip };

export function MapTab() {
  const poiRev = useGame((s) => s.poiRev);
  const captures = useGame((s) => s.captures);
  const selected = useGame((s) => s.selected);
  const [open, setOpen] = useState(true);
  const tick = useNow(3000);
  const { safeT, tabbarH } = useSafe();

  const nearby = useMemo(() => {
    void poiRev;
    void tick;
    const here = player.display;
    if (!here) return [];
    return pois.nearby(here, POI_NEARBY_M, (p) => !captures[p.id]).slice(0, 12);
  }, [poiRev, captures, tick]);

  return (
    <View style={styles.layer}>
      <TopHud>
        <PlayerChip />
        <Wallet />
      </TopHud>
      <View style={[styles.city, { top: 88 + safeT }]}>
        <CityChip />
      </View>
      <SideButtons showZoom bottom={tabbarH + (!selected && open ? 186 : 74)} />
      {!selected && <Nearby items={nearby} open={open} onToggle={() => setOpen((o) => !o)} />}
    </View>
  );
}

function Nearby({ items, open, onToggle }: {
  items: { poi: Poi; dist: number }[];
  open: boolean;
  onToggle: () => void;
}) {
  const { tabbarH } = useSafe();
  return (
    <View style={[styles.nearbyWrap, { bottom: tabbarH + 14 }]}>
      <PxBox style={styles.nearby} testID="nearby">
        <Pressable
          style={styles.head}
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          testID="nearby-head"
        >
          <Txt weight={700} style={styles.shrink}>
            Por perto{' '}
            <Txt weight={400} color={C.muted}>
              · {items.length ? `${items.length} para capturar` : 'nada ainda'}
            </Txt>
          </Txt>
          <Caret open={open} />
        </Pressable>
        {open &&
          (items.length === 0 ? (
            <View style={styles.list}>
              <Muted size={14} style={styles.empty}>
                Os pontos capturáveis aparecem conforme o mapa carrega. Movimente-se para encontrar mais.
              </Muted>
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.list}
              testID="nearby-list"
            >
              {items.map(({ poi, dist }) => (
                <NearbyItem key={poi.id} poi={poi} dist={dist} />
              ))}
            </ScrollView>
          ))}
      </PxBox>
    </View>
  );
}

function NearbyItem({ poi, dist }: { poi: Poi; dist: number }) {
  const revealed = fog.has(cellOf(poi));
  return (
    <PxCell
      style={styles.item}
      testID={`nearby-${poi.id}`}
      onPress={() => {
        sfx.click();
        useGame.getState().select(poi);
        mapController.focus(poi);
      }}
    >
      <BadgeImg category={poi.category} state={revealed ? 'wild' : 'fog'} width={40} />
      <Txt size={12} lh={1.15} weight={600} align="center" numberOfLines={2} style={[styles.nm, webNormalSpace]}>
        {revealed ? poi.name : '???'}
      </Txt>
      <Arcade size={8} spacing={0} color={C.muted}>
        {formatDistance(dist)}
      </Arcade>
    </PxCell>
  );
}

/**
 * Os glifos ▾/▸ não existem nas fontes pixel: no original o navegador caía na fonte do sistema. Na web vai o
 * mesmo glifo com a mesma pilha de fontes (fica idêntico); no celular, triângulos desenhados com bordas no
 * tamanho e na posição que o glifo tinha (▾ 5×4,5 px, ▸ 4,5×4,5 px, ~9 px abaixo do topo da linha).
 */
function Caret({ open }: { open: boolean }) {
  if (Platform.OS === 'web') {
    return (
      <Txt color={C.muted} style={styles.caretGlyph}>
        {open ? '▾' : '▸'}
      </Txt>
    );
  }
  return (
    <View style={styles.caretBox}>
      <View style={open ? styles.caretDown : styles.caretRight} />
    </View>
  );
}

const LINE = M.fontSize * M.lineHeight;

/**
 * O Text do react-native-web usa `white-space: pre-wrap`, que mantém o espaço antes das reticências do
 * line-clamp ("Assis …"); o original usava o espaço normal ("Assis…").
 */
const webNormalSpace = Platform.OS === 'web' ? ({ whiteSpace: 'normal' } as unknown as TextStyle) : null;

const styles = StyleSheet.create({
  layer: { ...FILL, pointerEvents: 'box-none' },
  city: { position: 'absolute', left: M.gutter, flexDirection: 'row', pointerEvents: 'box-none' },
  shrink: { flexShrink: 1 },

  // .nearby: absoluto acima da barra de abas, até 520 px, centralizado
  nearbyWrap: {
    position: 'absolute',
    left: M.gutter,
    right: M.gutter,
    alignItems: 'center',
    zIndex: 10,
    pointerEvents: 'box-none',
  },
  nearby: { width: '100%', maxWidth: 520, paddingTop: 10, paddingHorizontal: 12, paddingBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  list: { flexDirection: 'row', gap: 8, paddingTop: 10, paddingHorizontal: 2, paddingBottom: 4 },
  empty: { flex: 1, paddingVertical: 6, paddingHorizontal: 2 },
  item: {
    width: 118,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  // -webkit-line-clamp: 2 com min-height 2.3em
  nm: { alignSelf: 'stretch', minHeight: 12 * 2.3 },

  caretGlyph: { flexShrink: 0, fontFamily: `${FONT.ui400}, ui-rounded, system-ui, sans-serif` },
  caretBox: { width: 6, height: LINE, flexShrink: 0 },
  caretDown: {
    position: 'absolute',
    right: 1,
    top: 9.3,
    width: 0,
    height: 0,
    borderLeftWidth: 2.5,
    borderRightWidth: 2.5,
    borderTopWidth: 4.5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: C.muted,
  },
  caretRight: {
    position: 'absolute',
    right: 1,
    top: 8.8,
    width: 0,
    height: 0,
    borderTopWidth: 2.25,
    borderBottomWidth: 2.25,
    borderLeftWidth: 4.5,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: C.muted,
  },
});
