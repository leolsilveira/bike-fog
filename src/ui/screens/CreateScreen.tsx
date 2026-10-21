// Criação do personagem: carrossel de heróis, modalidade e apelido.
// Port de legacy/src/ui/screens/CreateScreen.tsx + seção .create-screen de global.css.
import { useEffect, useRef, useState } from 'react';
import {
  Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View,
  type TextStyle,
} from 'react-native';
import { CHARACTERS, type Modality } from '../../sprites/characters.ts';
import { useGame } from '../../game/store.ts';
import { sfx } from '../../game/audio.ts';
import { CharacterSprite, Icon } from '../components/Sprites.tsx';
import { Arcade, Inset, PxBox, PxButton, PxOutline, Txt } from '../components/Px.tsx';
import { DuskBackdrop, HeroPlatform } from '../components/Backdrops.tsx';
import { C, FILL, uiFont, useSafe } from '../theme.ts';

/** Mesmo limite do `maxLength` do original. */
const NAME_MAX = 18;

export function CreateScreen() {
  const unlocked = useGame((s) => s.unlocked);
  const createProfile = useGame((s) => s.createProfile);
  const { safeT, safeB } = useSafe();
  const [index, setIndex] = useState(0);
  const [modality, setModality] = useState<Modality>('bike');
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const def = CHARACTERS[index];
  const locked = !unlocked.includes(def.id);

  // Com o teclado aberto o campo e o botão ficam no fim da tela: rola até eles.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => scroll.current?.scrollToEnd({ animated: true }));
    return () => sub.remove();
  }, []);

  const step = (d: number) => {
    sfx.click();
    setIndex((i) => (i + d + CHARACTERS.length) % CHARACTERS.length);
  };
  const pick = (m: Modality) => {
    sfx.click();
    setModality(m);
  };
  const start = () => {
    if (locked) return;
    sfx.capture();
    createProfile(name, def.id, modality);
  };

  return (
    <View style={styles.screen} testID="create-screen">
      <DuskBackdrop />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'web' ? undefined : 'padding'}>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={[styles.content, { paddingTop: 18 + safeT, paddingBottom: 24 + safeB }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.inner}>
            <Arcade
              size={18}
              weight={700}
              spacing={0}
              lh={1.5}
              align="center"
              color={C.gold}
              shadow={{ y: 3 }}
              accessibilityRole="header"
            >
              QUEM VAI EXPLORAR?
            </Arcade>

            <PxBox style={styles.picker}>
              <PxButton size="round" onPress={() => step(-1)} label="Anterior" testID="hero-prev">
                <Icon name="back" size={22} />
              </PxButton>
              <View style={styles.stage}>
                <View style={styles.platform} testID="hero-platform">
                  <HeroPlatform />
                  <CharacterSprite characterId={def.id} modality={modality} facing="down" width={120} />
                  {locked && (
                    <View style={styles.lock}>
                      <Icon name="lock" size={36} />
                      <Arcade size={11} spacing={0} color={C.gold}>
                        {def.price} moedas
                      </Arcade>
                    </View>
                  )}
                </View>
                <Arcade size={15} spacing={0} align="center">
                  {def.name}
                </Arcade>
                <Txt size={14} color={C.muted} align="center" style={styles.tag}>
                  {locked ? 'Desbloqueie com moedas coletadas nas suas atividades.' : def.tagline}
                </Txt>
              </View>
              <PxButton size="round" onPress={() => step(1)} label="Próximo" testID="hero-next">
                <Icon name="back" size={22} style={styles.flip} />
              </PxButton>
            </PxBox>

            <View style={styles.field}>
              <FieldLabel>Modalidade</FieldLabel>
              <View style={styles.modeCards}>
                <PxButton
                  variant={modality === 'bike' ? 'mint' : 'default'}
                  onPress={() => pick('bike')}
                  style={styles.modeCard}
                  testID="mode-bike"
                >
                  <Icon name="bike" size={36} color={modality === 'bike' ? C.ink : C.cream} />
                  <Txt>Ciclismo</Txt>
                  <Txt size={12} weight={400} style={styles.small}>
                    explore mais longe
                  </Txt>
                </PxButton>
                <PxButton
                  variant={modality === 'run' ? 'coral' : 'default'}
                  onPress={() => pick('run')}
                  style={styles.modeCard}
                  testID="mode-run"
                >
                  <Icon name="run" size={36} />
                  <Txt>Corrida</Txt>
                  <Txt size={12} weight={400} style={styles.small}>
                    mais XP por km
                  </Txt>
                </PxButton>
              </View>
            </View>

            <View style={styles.field}>
              <FieldLabel>Como te chamam?</FieldLabel>
              <View style={styles.inputBox}>
                <Inset side="top" h={3} color={C.cream2} />
                <PxOutline color={focused ? C.gold : C.ink} />
                <TextInput
                  value={name}
                  onChangeText={setName}
                  maxLength={NAME_MAX}
                  placeholder="Seu apelido"
                  placeholderTextColor="#757575"
                  autoComplete="nickname"
                  textContentType="nickname"
                  autoCorrect={false}
                  spellCheck={false}
                  autoCapitalize="words"
                  returnKeyType="go"
                  onSubmitEditing={start}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  cursorColor={C.ink}
                  underlineColorAndroid="transparent"
                  accessibilityLabel="Como te chamam?"
                  style={styles.input}
                  testID="hero-name"
                />
              </View>
            </View>

            <PxButton
              variant="gold"
              block
              disabled={locked}
              onPress={start}
              style={styles.startBtn}
              testID="create-start"
            >
              <Arcade size={13}>COMEÇAR AVENTURA</Arcade>
            </PxButton>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** `.field label`: rótulo em caixa alta. */
function FieldLabel({ children }: { children: string }) {
  return (
    <Txt weight={700} size={14} spacing={0.05} upper color={C.muted}>
      {children}
    </Txt>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...FILL,
    backgroundColor: C.ink,
  },
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, alignItems: 'center' },
  inner: { width: '100%', maxWidth: 460, gap: 18 },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 16,
    paddingHorizontal: 12,
    paddingBottom: 14,
  },
  stage: { flex: 1, alignItems: 'center', gap: 8 },
  platform: {
    width: 180,
    height: 170,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 14,
  },
  lock: {
    ...FILL,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(29, 23, 48, 0.55)',
  },
  tag: { minHeight: 14 * 2.6 },
  flip: { transform: [{ scaleX: -1 }] },
  field: { gap: 8 },
  modeCards: { flexDirection: 'row', gap: 12 },
  modeCard: { flex: 1, flexDirection: 'column', gap: 6, paddingTop: 14, paddingHorizontal: 8, paddingBottom: 16 },
  small: { opacity: 0.85 },
  inputBox: { backgroundColor: C.cream },
  input: {
    height: 12 + 18 * 1.35 + 12,
    paddingHorizontal: 14,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    // sem o anel de foco do navegador (`outline: none`); o foco aparece no contorno dourado
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
    fontFamily: uiFont(700),
    fontSize: 18,
    color: C.ink,
    textAlignVertical: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  } as TextStyle,
  startBtn: { paddingTop: 16, paddingHorizontal: 16, paddingBottom: 20 },
});
