// Busca de endereço da rota "Até endereço": painel no topo da tela (o teclado fica embaixo sem cobrir nada),
// com sugestões enquanto digita (Photon, priorizando o que está perto do jogador).
import { useEffect, useRef, useState } from 'react';
import {
  BackHandler, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type TextStyle, type ViewStyle,
} from 'react-native';
import { searchPlaces } from '../../game/route.ts';
import { player } from '../../game/location.ts';
import { formatDistance, haversine } from '../../game/geo.ts';
import { sfx } from '../../game/audio.ts';
import type { Place } from '../../game/types.ts';
import { Icon } from './Sprites.tsx';
import { Inset, Muted, PxBox, PxButton, PxOutline, Txt } from './Px.tsx';
import { C, FILL, M, uiFont, useSafe } from '../theme.ts';

const MIN_CHARS = 3;
const DEBOUNCE_MS = 350;

type Status = 'idle' | 'loading' | 'done' | 'error';

export function PlaceSearch({ onPick, onClose }: { onPick: (p: Place) => void; onClose: () => void }) {
  const { safeT } = useSafe();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [focused, setFocused] = useState(false);
  const seq = useRef(0);

  // Android: "voltar" fecha só a busca (o handler mais novo é chamado primeiro)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const text = q.trim();
  const active = text.length >= MIN_CHARS;
  const change = (t: string) => {
    setQ(t);
    if (t.trim().length >= MIN_CHARS) setStatus('loading');
  };

  useEffect(() => {
    const id = ++seq.current;
    if (text.length < MIN_CHARS) return;
    const timer = setTimeout(() => {
      searchPlaces(text, player.display)
        .then((found) => {
          if (id !== seq.current) return;
          setResults(found);
          setStatus('done');
        })
        .catch((err: unknown) => {
          if (id !== seq.current) return;
          console.warn('[rota] busca falhou', err);
          setStatus('error');
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const here = player.display;
  const shown = active ? results : [];
  let message: string | null = null;
  if (!active || status === 'idle') message = 'Digite um endereço, bairro ou lugar (ex.: "Parque Ibirapuera").';
  else if (status === 'loading' && shown.length === 0) message = 'Buscando…';
  else if (status === 'error') message = 'Não deu para buscar agora. Confira a internet e tente de novo.';
  else if (status === 'done' && results.length === 0) message = 'Nada encontrado. Tente outro nome ou inclua a cidade.';

  return (
    <View style={styles.layer} testID="place-search">
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Fechar busca" />
      <View style={[styles.wrap, { top: 10 + safeT }]}>
        <PxBox style={styles.panel}>
          <View style={styles.bar}>
            <PxButton variant="ghost" size="round" onPress={onClose} label="Voltar" testID="search-back">
              <Icon name="back" size={16} />
            </PxButton>
            <View style={styles.inputBox}>
              <Inset side="top" h={3} color={C.cream2} />
              <PxOutline color={focused ? C.gold : C.ink} />
              <TextInput
                value={q}
                onChangeText={change}
                autoFocus
                placeholder="Para onde?"
                placeholderTextColor="#757575"
                autoCorrect={false}
                spellCheck={false}
                autoCapitalize="none"
                returnKeyType="search"
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                cursorColor={C.ink}
                underlineColorAndroid="transparent"
                accessibilityLabel="Buscar endereço"
                style={styles.input}
                testID="search-input"
              />
            </View>
          </View>
          {message && (
            <Muted size={14} style={styles.message}>
              {message}
            </Muted>
          )}
          {shown.length > 0 && (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" testID="search-results">
              {shown.map((p, i) => (
                <Pressable
                  key={`${p.lng},${p.lat},${i}`}
                  style={({ pressed }) => [styles.item, i > 0 && styles.itemSep, pressed && styles.itemPressed]}
                  onPress={() => {
                    sfx.click();
                    onPick(p);
                  }}
                  testID={`place-${i}`}
                >
                  <Icon name="pin" size={20} color={C.gold} />
                  <View style={styles.itemText}>
                    <Txt weight={700} size={15} numberOfLines={1}>
                      {p.name}
                    </Txt>
                    {!!p.detail && (
                      <Muted size={13} numberOfLines={1}>
                        {p.detail}
                      </Muted>
                    )}
                  </View>
                  {here && (
                    <Muted size={12} weight={600}>
                      {formatDistance(haversine(here, p))}
                    </Muted>
                  )}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </PxBox>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...FILL, zIndex: 5, pointerEvents: 'box-none' } as ViewStyle,
  scrim: { ...FILL, backgroundColor: C.backdrop },
  wrap: { position: 'absolute', left: M.gutter, right: M.gutter, alignItems: 'center', pointerEvents: 'box-none' },
  panel: { width: '100%', maxWidth: 520, padding: 10, gap: 10 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inputBox: { flex: 1, backgroundColor: C.cream },
  input: {
    height: 44,
    paddingHorizontal: 12,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    // sem o anel de foco do navegador; o foco aparece no contorno dourado
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null),
    fontFamily: uiFont(700),
    fontSize: 17,
    color: C.ink,
    textAlignVertical: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  },
  message: { paddingHorizontal: 4, paddingBottom: 4 },
  list: { maxHeight: 340 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 4 },
  itemSep: { borderTopWidth: 2, borderTopColor: C.panel3 },
  itemPressed: { backgroundColor: C.panel2 },
  itemText: { flex: 1, minWidth: 0 },
});
