// Customizador de avatar reutilizável (onboarding + modal de edição no perfil).
// Permite trocar estilo de cabelo e cores de pele, cabelo, camisa, shorts, tênis, capacete e bike.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  AVATAR_PARTS, AVATAR_SWATCHES, HAIR_STYLES, avatarFromCharacter, randomAvatar,
  type AvatarColorKey, type AvatarConfig, type AvatarPart,
} from '../../sprites/avatar.ts';
import { CHARACTERS, type Facing, type HairStyle, type Modality } from '../../sprites/characters.ts';
import { sfx } from '../../game/audio.ts';
import { CharacterSprite, Icon } from './Sprites.tsx';
import { Inset, Muted, PxBox, PxButton, PxOutline, Txt } from './Px.tsx';
import { HeroPlatform } from './Backdrops.tsx';
import { C } from '../theme.ts';

const FACINGS: readonly Facing[] = ['down', 'right', 'up', 'left'];
const FACING_LABEL: Record<Facing, string> = {
  down: 'Frente',
  right: 'Direita',
  up: 'Costas',
  left: 'Esquerda',
};

export interface AvatarCustomizerProps {
  value: AvatarConfig;
  onChange: (next: AvatarConfig) => void;
  modality: Modality;
  /** Layout mais enxuto para o modal de edição. */
  compact?: boolean;
}

export function AvatarCustomizer({ value, onChange, modality, compact = false }: AvatarCustomizerProps) {
  const [part, setPart] = useState<AvatarPart>('hair');
  const [facingIdx, setFacingIdx] = useState(0);
  const [previewOverride, setPreviewOverride] = useState<Modality | null>(null);

  const previewModality = previewOverride ?? modality;
  const facing = FACINGS[facingIdx];
  const swatches = AVATAR_SWATCHES[part];
  const activeColor = value.colors[part];
  const activeSwatch = swatches.find((s) => s.color.toLowerCase() === activeColor.toLowerCase());

  const rotate = (delta: number) => {
    sfx.click();
    setFacingIdx((i) => (i + delta + FACINGS.length) % FACINGS.length);
  };

  const selectPart = (next: AvatarPart) => {
    sfx.click();
    setPart(next);
    // Capacete e bike só aparecem na pose de ciclismo: alterna a prévia para a mudança ficar visível.
    if ((next === 'helmet' || next === 'bike') && previewModality !== 'bike') {
      setPreviewOverride('bike');
    }
  };

  const setHairStyle = (hair: HairStyle) => {
    sfx.click();
    onChange({ ...value, hair });
  };

  const setColor = (key: AvatarColorKey, color: string) => {
    sfx.click();
    onChange({ ...value, colors: { ...value.colors, [key]: color } });
  };

  const applyPreset = (characterId: string) => {
    sfx.click();
    onChange(avatarFromCharacter(characterId));
  };

  const randomize = () => {
    sfx.click();
    onChange(randomAvatar());
  };

  const togglePreview = (m: Modality) => {
    sfx.click();
    setPreviewOverride(m);
  };

  return (
    <View style={styles.root} testID="avatar-customizer">
      <PxBox style={[styles.stageBox, compact && styles.stageBoxCompact]}>
        <PxButton size="round" onPress={() => rotate(-1)} label="Girar à esquerda" testID="avatar-rot-left">
          <Icon name="back" size={20} />
        </PxButton>
        <View style={styles.stageCenter}>
          <View style={[styles.platform, compact && styles.platformCompact]} testID="avatar-stage">
            {!compact && <HeroPlatform />}
            <CharacterSprite
              avatar={value}
              modality={previewModality}
              facing={facing}
              width={compact ? 92 : 116}
            />
          </View>
          <View style={styles.stageMeta}>
            <Muted size={12}>{FACING_LABEL[facing]}</Muted>
            <View style={styles.previewToggle}>
              <Pressable
                onPress={() => togglePreview('bike')}
                style={[styles.modePill, previewModality === 'bike' && styles.modePillActive]}
                accessibilityRole="button"
                accessibilityLabel="Prévia de ciclismo"
                accessibilityState={{ selected: previewModality === 'bike' }}
                testID="preview-bike"
              >
                <Icon name="bike" size={14} color={previewModality === 'bike' ? C.ink : C.cream} />
                <Txt size={12} weight={700} color={previewModality === 'bike' ? C.ink : C.cream}>
                  Bike
                </Txt>
              </Pressable>
              <Pressable
                onPress={() => togglePreview('run')}
                style={[styles.modePill, previewModality === 'run' && styles.modePillRun]}
                accessibilityRole="button"
                accessibilityLabel="Prévia de corrida"
                accessibilityState={{ selected: previewModality === 'run' }}
                testID="preview-run"
              >
                <Icon name="run" size={14} color={C.cream} />
                <Txt size={12} weight={700} color={C.cream}>
                  Corrida
                </Txt>
              </Pressable>
            </View>
          </View>
        </View>
        <PxButton size="round" onPress={() => rotate(1)} label="Girar à direita" testID="avatar-rot-right">
          <Icon name="back" size={20} style={styles.flip} />
        </PxButton>
      </PxBox>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.quickRow}
      >
        <PxButton size="small" variant="gold" onPress={randomize} testID="avatar-random">
          Aleatório
        </PxButton>
        {CHARACTERS.map((c) => (
          <PxButton
            key={c.id}
            size="small"
            onPress={() => applyPreset(c.id)}
            testID={`preset-${c.id}`}
          >
            {c.name}
          </PxButton>
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.partTabs}
      >
        {AVATAR_PARTS.map((item) => {
          const selected = part === item.id;
          return (
            <Pressable
              key={item.id}
              onPress={() => selectPart(item.id)}
              style={[styles.partTab, selected && styles.partTabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              testID={`part-tab-${item.id}`}
            >
              <PxOutline color={selected ? C.gold : C.ink} />
              <View style={[styles.partDot, { backgroundColor: value.colors[item.id] }]} />
              <Txt size={13} weight={700} color={selected ? C.gold : C.cream}>
                {item.label}
              </Txt>
            </Pressable>
          );
        })}
      </ScrollView>

      <PxBox style={styles.controlsBox}>
        {part === 'hair' && (
          <View style={styles.hairSection}>
            <Txt size={12} weight={700} upper spacing={0.05} color={C.muted}>
              Estilo
            </Txt>
            <View style={styles.hairRow}>
              {HAIR_STYLES.map((styleOpt) => {
                const selected = value.hair === styleOpt.id;
                return (
                  <PxButton
                    key={styleOpt.id}
                    size="small"
                    variant={selected ? 'sky' : 'default'}
                    onPress={() => setHairStyle(styleOpt.id)}
                    style={styles.hairBtn}
                    testID={`hair-${styleOpt.id}`}
                  >
                    {styleOpt.label}
                  </PxButton>
                );
              })}
            </View>
          </View>
        )}

        <View style={styles.colorHeader}>
          <Txt size={12} weight={700} upper spacing={0.05} color={C.muted}>
            Cor
          </Txt>
          {activeSwatch && (
            <Txt size={12} weight={600} color={C.cream}>
              {activeSwatch.name}
            </Txt>
          )}
        </View>

        <View style={styles.swatchGrid}>
          {swatches.map((swatch) => {
            const selected = swatch.color.toLowerCase() === activeColor.toLowerCase();
            return (
              <Pressable
                key={swatch.id}
                onPress={() => setColor(part, swatch.color)}
                style={[styles.swatch, { backgroundColor: swatch.color }]}
                accessibilityRole="button"
                accessibilityLabel={swatch.name}
                accessibilityState={{ selected }}
                testID={`swatch-${part}-${swatch.id}`}
              >
                <Inset side="bottom" h={4} color="rgba(0, 0, 0, 0.22)" />
                <PxOutline color={selected ? C.gold : C.ink} />
                {selected && <View style={styles.swatchDot} />}
              </Pressable>
            );
          })}
        </View>
      </PxBox>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  stageBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 12,
    paddingHorizontal: 10,
    paddingBottom: 12,
  },
  stageBoxCompact: {
    paddingTop: 8,
    paddingBottom: 8,
  },
  stageCenter: { flex: 1, alignItems: 'center', gap: 6 },
  platform: {
    width: 180,
    height: 158,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 12,
  },
  platformCompact: {
    width: 140,
    height: 122,
    justifyContent: 'center',
    paddingBottom: 0,
  },
  stageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  previewToggle: {
    flexDirection: 'row',
    gap: 6,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: C.panel3,
    borderWidth: 2,
    borderColor: C.ink,
  },
  modePillActive: {
    backgroundColor: C.mint,
  },
  modePillRun: {
    backgroundColor: C.coral,
  },
  flip: { transform: [{ scaleX: -1 }] },
  quickRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 3,
  },
  partTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 3,
  },
  partTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    backgroundColor: C.panel2,
  },
  partTabActive: {
    backgroundColor: C.panel3,
  },
  partDot: {
    width: 11,
    height: 11,
    borderWidth: 1.5,
    borderColor: C.ink,
  },
  controlsBox: {
    padding: 12,
    gap: 10,
  },
  hairSection: {
    gap: 6,
  },
  hairRow: {
    flexDirection: 'row',
    gap: 8,
  },
  hairBtn: {
    flex: 1,
  },
  colorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  swatchGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingVertical: 3,
    paddingHorizontal: 3,
  },
  swatch: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchDot: {
    width: 10,
    height: 10,
    backgroundColor: C.cream,
    borderWidth: 2,
    borderColor: C.ink,
  },
});
