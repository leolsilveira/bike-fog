// Onboarding em 3 etapas: 1) Modalidade → 2) Customização do avatar → 3) Apelido e início.
import { useEffect, useRef, useState } from 'react';
import {
  BackHandler, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View,
  type TextStyle,
} from 'react-native';
import { DEFAULT_AVATAR, type AvatarConfig } from '../../sprites/avatar.ts';
import type { Modality } from '../../sprites/characters.ts';
import { useGame } from '../../game/store.ts';
import { sfx } from '../../game/audio.ts';
import {
  mapAuthError, suggestUsernameFromName, updateProfileSettings, validateUsername,
} from '../../services/auth.ts';
import { AvatarCustomizer } from '../components/AvatarCustomizer.tsx';
import { CharacterSprite, Icon } from '../components/Sprites.tsx';
import { Arcade, Chip, Inset, PxBox, PxButton, PxOutline, Txt } from '../components/Px.tsx';
import { DuskBackdrop, HeroPlatform } from '../components/Backdrops.tsx';
import { C, FILL, uiFont, useSafe } from '../theme.ts';

/** Mesmo limite do `maxLength` do original. */
const NAME_MAX = 18;

type Step = 0 | 1 | 2;

const STEPS: readonly { id: Step; label: string; title: string }[] = [
  { id: 0, label: 'Modalidade', title: 'COMO VOCÊ VAI EXPLORAR?' },
  { id: 1, label: 'Avatar', title: 'MONTE SEU AVATAR' },
  { id: 2, label: 'Apelido', title: 'COMO TE CHAMAM?' },
];

export function CreateScreen() {
  const createProfile = useGame((s) => s.createProfile);
  const authUserId = useGame((s) => s.authUserId);
  const { safeT, safeB } = useSafe();
  const [step, setStep] = useState<Step>(0);
  const [modality, setModality] = useState<Modality>('bike');
  const [avatar, setAvatar] = useState<AvatarConfig>(DEFAULT_AVATAR);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [focused, setFocused] = useState<'name' | 'username' | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const scroll = useRef<ScrollView>(null);

  // Com o teclado aberto na etapa final, rola até o campo e botão.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => scroll.current?.scrollToEnd({ animated: true }));
    return () => sub.remove();
  }, []);

  // Android: botão voltar retorna para a etapa anterior do onboarding.
  useEffect(() => {
    if (step === 0) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      sfx.click();
      setStep((s) => (s > 0 ? ((s - 1) as Step) : 0));
      return true;
    });
    return () => sub.remove();
  }, [step]);

  const goTo = (next: Step) => {
    sfx.click();
    setStep(next);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  const pickModality = (m: Modality) => {
    sfx.click();
    setModality(m);
  };

  const suggestedUsername = !username.trim() && name.trim() ? suggestUsernameFromName(name) : '';

  const start = async () => {
    if (submitting) return;
    setUsernameError(null);
    let cleanUsername: string | undefined;
    if (username.trim().length > 0) {
      const check = validateUsername(username);
      if (!check.ok) {
        setUsernameError(check.error);
        return;
      }
      cleanUsername = check.username;
    }

    if (authUserId && cleanUsername) {
      setSubmitting(true);
      try {
        await updateProfileSettings({
          username: cleanUsername,
          displayName: name.trim() || 'Viajante',
        });
      } catch (err) {
        setUsernameError(mapAuthError(err));
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }

    sfx.capture();
    createProfile(name, avatar, modality, 'custom', cleanUsername ? { username: cleanUsername } : undefined);
  };

  const current = STEPS[step];

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
            <View style={styles.stepper} testID="onboarding-stepper">
              {STEPS.map((s) => {
                const active = s.id === step;
                const done = s.id < step;
                return (
                  <Pressable
                    key={s.id}
                    disabled={s.id > step}
                    onPress={() => goTo(s.id)}
                    style={[
                      styles.stepPill,
                      active && styles.stepPillActive,
                      done && styles.stepPillDone,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled: s.id > step }}
                    testID={`step-pill-${s.id}`}
                  >
                    <Arcade size={9} spacing={0} color={active ? C.ink : done ? C.gold : C.muted}>
                      {s.id + 1}
                    </Arcade>
                    <Txt size={12} weight={700} color={active ? C.ink : done ? C.cream : C.muted} numberOfLines={1}>
                      {s.label}
                    </Txt>
                  </Pressable>
                );
              })}
            </View>

            <Arcade
              size={17}
              weight={700}
              spacing={0}
              lh={1.5}
              align="center"
              color={C.gold}
              shadow={{ y: 3 }}
              accessibilityRole="header"
            >
              {current.title}
            </Arcade>

            {step === 0 && (
              <View style={styles.stepBody} testID="onboarding-step-modality">
                <PxBox style={styles.heroBox}>
                  <View style={styles.platform} testID="hero-platform">
                    <HeroPlatform />
                    <CharacterSprite avatar={avatar} modality={modality} facing="down" width={120} />
                  </View>
                  <Txt size={14} color={C.muted} align="center">
                    Você pode trocar a modalidade e o visual quando quiser.
                  </Txt>
                </PxBox>

                <View style={styles.modeCards}>
                  <PxButton
                    variant={modality === 'bike' ? 'mint' : 'default'}
                    onPress={() => pickModality('bike')}
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
                    onPress={() => pickModality('run')}
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

                <PxButton
                  variant="gold"
                  block
                  onPress={() => goTo(1)}
                  style={styles.primaryBtn}
                  testID="step-next-0"
                >
                  <Arcade size={13}>PRÓXIMO</Arcade>
                </PxButton>
              </View>
            )}

            {step === 1 && (
              <View style={styles.stepBody} testID="onboarding-step-avatar">
                <AvatarCustomizer value={avatar} onChange={setAvatar} modality={modality} />

                <View style={styles.navRow}>
                  <PxButton onPress={() => goTo(0)} style={styles.backBtn} testID="step-back-1">
                    <Icon name="back" size={16} />
                    <Txt>Voltar</Txt>
                  </PxButton>
                  <PxButton
                    variant="gold"
                    onPress={() => goTo(2)}
                    style={[styles.nextBtn, styles.primaryBtn]}
                    testID="step-next-1"
                  >
                    <Arcade size={12}>PRÓXIMO</Arcade>
                  </PxButton>
                </View>
              </View>
            )}

            {step === 2 && (
              <View style={styles.stepBody} testID="onboarding-step-name">
                <PxBox style={styles.heroBox}>
                  <View style={styles.platform}>
                    <HeroPlatform />
                    <CharacterSprite avatar={avatar} modality={modality} facing="down" width={120} />
                  </View>
                  <Chip>
                    <Icon name={modality} size={16} /> {modality === 'bike' ? 'Ciclismo' : 'Corrida'}
                  </Chip>
                </PxBox>

                <View style={styles.field}>
                  <Txt weight={700} size={14} spacing={0.05} upper color={C.muted}>
                    Seu apelido
                  </Txt>
                  <View style={styles.inputBox}>
                    <Inset side="top" h={3} color={C.cream2} />
                    <PxOutline color={focused === 'name' ? C.gold : C.ink} />
                    <TextInput
                      value={name}
                      onChangeText={setName}
                      maxLength={NAME_MAX}
                      placeholder="Viajante"
                      placeholderTextColor="#757575"
                      autoComplete="nickname"
                      textContentType="nickname"
                      autoCorrect={false}
                      spellCheck={false}
                      autoCapitalize="words"
                      returnKeyType="next"
                      onFocus={() => setFocused('name')}
                      onBlur={() => setFocused(null)}
                      cursorColor={C.ink}
                      underlineColorAndroid="transparent"
                      accessibilityLabel="Seu apelido"
                      style={styles.input}
                      testID="hero-name"
                    />
                  </View>
                </View>

                <View style={styles.field}>
                  <View style={styles.labelRow}>
                    <Txt weight={700} size={14} spacing={0.05} upper color={C.muted}>
                      @username (opcional)
                    </Txt>
                    {suggestedUsername ? (
                      <Pressable
                        onPress={() => {
                          sfx.click();
                          setUsername(suggestedUsername);
                          setUsernameError(null);
                        }}
                        accessibilityRole="button"
                      >
                        <Txt size={12} weight={700} color={C.sky}>
                          Usar @{suggestedUsername}
                        </Txt>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.inputBox}>
                    <Inset side="top" h={3} color={C.cream2} />
                    <PxOutline color={focused === 'username' ? C.gold : C.ink} />
                    <TextInput
                      value={username}
                      onChangeText={(v) => {
                        setUsername(v);
                        if (usernameError) setUsernameError(null);
                      }}
                      maxLength={24}
                      placeholder={suggestedUsername ? `ex: ${suggestedUsername}` : 'ex: ciclista_sp'}
                      placeholderTextColor="#757575"
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      returnKeyType="go"
                      onSubmitEditing={() => void start()}
                      onFocus={() => setFocused('username')}
                      onBlur={() => setFocused(null)}
                      cursorColor={C.ink}
                      underlineColorAndroid="transparent"
                      accessibilityLabel="Nome de usuário"
                      style={styles.input}
                      testID="create-username"
                    />
                  </View>
                  {usernameError ? (
                    <Txt size={13} weight={700} color={C.coral}>
                      {usernameError}
                    </Txt>
                  ) : (
                    <Txt size={12} color={C.muted}>
                      3 a 24 caracteres (a-z, 0-9 e _). Você pode definir ou alterar depois.
                    </Txt>
                  )}
                </View>

                <View style={styles.navRow}>
                  <PxButton onPress={() => goTo(1)} style={styles.backBtn} disabled={submitting} testID="step-back-2">
                    <Icon name="back" size={16} />
                    <Txt>Voltar</Txt>
                  </PxButton>
                  <PxButton
                    variant="gold"
                    onPress={() => void start()}
                    disabled={submitting}
                    style={[styles.nextBtn, styles.primaryBtn]}
                    testID="create-start"
                  >
                    <Arcade size={11}>{submitting ? 'SALVANDO…' : 'COMEÇAR AVENTURA'}</Arcade>
                  </PxButton>
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...FILL,
    backgroundColor: C.ink,
  },
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, alignItems: 'center' },
  inner: { width: '100%', maxWidth: 460, gap: 16 },
  stepper: {
    flexDirection: 'row',
    gap: 8,
  },
  stepPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 8,
    backgroundColor: C.panel,
    borderWidth: 2,
    borderColor: C.ink,
  },
  stepPillActive: {
    backgroundColor: C.gold,
  },
  stepPillDone: {
    backgroundColor: C.panel2,
    borderColor: C.line,
  },
  stepBody: { gap: 16 },
  heroBox: {
    alignItems: 'center',
    gap: 10,
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 16,
  },
  platform: {
    width: 180,
    height: 170,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 14,
  },
  modeCards: { flexDirection: 'row', gap: 12 },
  modeCard: { flex: 1, flexDirection: 'column', gap: 6, paddingTop: 14, paddingHorizontal: 8, paddingBottom: 16 },
  small: { opacity: 0.85 },
  field: { gap: 8 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  inputBox: { backgroundColor: C.cream },
  input: {
    height: 12 + 18 * 1.35 + 12,
    paddingHorizontal: 14,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
    fontFamily: uiFont(700),
    fontSize: 18,
    color: C.ink,
    textAlignVertical: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  } as TextStyle,
  navRow: { flexDirection: 'row', gap: 10 },
  backBtn: { paddingHorizontal: 14 },
  nextBtn: { flex: 1 },
  primaryBtn: { paddingTop: 14, paddingHorizontal: 14, paddingBottom: 18 },
});
