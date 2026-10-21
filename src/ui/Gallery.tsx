// Vitrine das primitivas (só na web, com `?gallery`): referência visual para quem monta telas e base dos testes
// de fidelidade (scratchpad/uibase/gallery.mjs injeta o HTML equivalente com as classes do CSS original).
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Arcade, Bar, Chip, Hint, Muted, PxBox, PxButton, PxCell, RarityTag, Txt } from './components/Px.tsx';
import { BadgeImg, CharacterSprite, CoinImg, Icon, PoiIconImg } from './components/Sprites.tsx';
import { C, FILL } from './theme.ts';

function At({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <View style={[styles.row, { left: x, top: y }]}>{children}</View>;
}

export function Gallery() {
  return (
    <View style={styles.screen}>
      <At x={16} y={16}>
        <PxButton>Padrão</PxButton>
        <PxButton variant="gold">Ouro</PxButton>
        <PxButton variant="mint">Menta</PxButton>
        <PxButton variant="coral">Coral</PxButton>
      </At>
      <At x={16} y={76}>
        <PxButton variant="sky">Céu</PxButton>
        <PxButton variant="cream">Creme</PxButton>
        <PxButton variant="ghost">Fantasma</PxButton>
      </At>
      <At x={16} y={136}>
        <PxButton variant="gold" size="small">
          Pequeno
        </PxButton>
        <PxButton variant="ghost" size="small">
          <Icon name="download" size={16} />
        </PxButton>
        <PxButton size="round">
          <Icon name="back" size={22} />
        </PxButton>
        <PxButton variant="sky" size="small">
          <Icon name="joystick" size={16} color={C.ink} accent={C.coral} /> Ativar simulador
        </PxButton>
      </At>
      <At x={16} y={196}>
        <PxButton variant="gold" disabled style={styles.start} fontSize={20}>
          <Icon name="play" size={28} color={C.ink} />
          <Arcade size={15}>INICIAR</Arcade>
        </PxButton>
        <PxButton variant="cream" pressed>
          <Icon name="pause" size={20} color={C.ink} /> Pausar
        </PxButton>
      </At>
      <At x={16} y={290}>
        <Chip>
          <CoinImg size={16} /> 1.234
        </Chip>
        <Chip dot={C.mint}>GPS ok ±5 m</Chip>
        <Chip color={C.muted}>média 12,3 km/h</Chip>
      </At>
      <At x={16} y={340}>
        <Bar percent={60} style={{ width: 120 }} />
        <Bar percent={30} variant="mint" height={14} style={{ width: 100 }} />
        <Bar percent={80} variant="sky" height={7} style={{ width: 110 }} />
      </At>
      <At x={16} y={380}>
        <RarityTag color="#ff5f8f">Lendário</RarityTag>
        <Muted>Museu / Galeria</Muted>
        <Hint>Passe perto dos pontos para capturá-los!</Hint>
      </At>
      <At x={16} y={450}>
        <PxBox light style={styles.pad}>
          <Txt weight={700}>Caixa clara</Txt>
          <Txt size={13}>texto herdado em --ink</Txt>
        </PxBox>
        <PxBox style={styles.pad}>
          <Arcade size={13} color={C.gold}>
            NV 12
          </Arcade>
          <Muted size={13}>caixa escura</Muted>
        </PxBox>
      </At>
      <At x={16} y={560}>
        <PxCell style={styles.cell}>
          <BadgeImg category="museu" state="wild" width={40} />
          <Txt size={12} weight={600}>
            MASP
          </Txt>
        </PxCell>
        <PxCell selected style={styles.cell}>
          <PoiIconImg category="parque" size={36} />
          <Txt size={12} weight={600}>
            Parque
          </Txt>
        </PxCell>
        <BadgeImg category="estadio" state="captured" width={34} />
        <BadgeImg category="arte" state="fog" width={60} />
      </At>
      <At x={16} y={680}>
        <CharacterSprite characterId="dandara" modality="run" facing="right" width={96} />
        <CharacterSprite characterId="lia" modality="bike" facing="down" width={60} />
        <CharacterSprite characterId="teo" modality="run" facing="left" animate={false} width={48} />
      </At>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { ...FILL, backgroundColor: C.panel },
  row: { position: 'absolute', flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  start: { paddingTop: 16, paddingBottom: 20, paddingHorizontal: 20 },
  pad: { padding: 12, gap: 4 },
  cell: { width: 90, alignItems: 'center', gap: 4, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 6 },
});
