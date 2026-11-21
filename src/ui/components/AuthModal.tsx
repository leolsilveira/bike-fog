// Modal de autenticação (Entrar, Criar conta e Recuperar senha) em estilo pixel-art.
import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { sfx } from '../../game/audio.ts';
import { useGame } from '../../game/store.ts';
import {
  mapAuthError,
  sendPasswordReset,
  signInWithEmail,
  signUpWithEmail,
  suggestUsernameFromName,
} from '../../services/auth.ts';
import { C, uiFont } from '../theme.ts';
import { Arcade, Chip, Inset, Muted, PxBox, PxButton, PxOutline, Txt } from './Px.tsx';

type AuthMode = 'signin' | 'signup' | 'reset';

export function AuthModal({ onClose }: { onClose: () => void }) {
  const profile = useGame((s) => s.profile);
  const pendingInviteUsername = useGame((s) => s.pendingInviteUsername);
  const toast = useGame((s) => s.toast);

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState(profile?.name ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [focused, setFocused] = useState<'email' | 'password' | 'name' | 'username' | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const switchMode = (next: AuthMode) => {
    sfx.click();
    setMode(next);
    setErrorMsg(null);
    setInfoMsg(null);
  };

  const title =
    mode === 'signin' ? 'ENTRAR' : mode === 'signup' ? 'CRIAR CONTA' : 'RECUPERAR SENHA';

  const subtitle =
    mode === 'signin'
      ? 'Sincronize seu mapa, moedas e conquistas na nuvem.'
      : mode === 'signup'
        ? 'Salve seu progresso na nuvem e conecte-se com outros exploradores.'
        : 'Informe seu e-mail para receber o link de redefinição de senha.';

  const suggestedUsername =
    mode === 'signup' && !username.trim() && name.trim() ? suggestUsernameFromName(name) : '';

  const submit = async () => {
    if (busy) return;
    sfx.click();
    setErrorMsg(null);
    setInfoMsg(null);
    setBusy(true);
    try {
      if (mode === 'reset') {
        await sendPasswordReset(email);
        setInfoMsg('Se este e-mail estiver cadastrado, enviaremos um link para redefinir sua senha.');
        return;
      }

      if (mode === 'signin') {
        const res = await signInWithEmail(email, password);
        toast(
          res.migration === 'conflict'
            ? 'Sessão iniciada! Escolha como resolver os dados.'
            : 'Sessão iniciada!',
          'info',
        );
        onClose();
        return;
      }

      const res = await signUpWithEmail(email, password, {
        ...(name.trim() ? { displayName: name.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
      });
      if (res.needsEmailConfirmation) {
        setInfoMsg(
          'Conta criada! Confirme seu e-mail na caixa de entrada e depois faça login para sincronizar.',
        );
        return;
      }
      toast('Conta criada e conectada!', 'info');
      onClose();
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Arcade
        size={18}
        weight={700}
        spacing={0}
        lh={1.4}
        align="center"
        color={C.gold}
        shadow={{ y: 3 }}
        accessibilityRole="header"
      >
        {title}
      </Arcade>

      <Muted size={14} align="center">
        {subtitle}
      </Muted>

      {pendingInviteUsername && (
        <View style={styles.centerRow}>
          <Chip dot={C.sky}>Convite de @{pendingInviteUsername}</Chip>
        </View>
      )}

      <View style={styles.modeTabs}>
        <PxButton
          size="small"
          variant={mode === 'signin' ? 'gold' : 'default'}
          onPress={() => switchMode('signin')}
          disabled={busy}
          style={styles.modeTabBtn}
          testID="auth-mode-signin"
        >
          Entrar
        </PxButton>
        <PxButton
          size="small"
          variant={mode === 'signup' ? 'gold' : 'default'}
          onPress={() => switchMode('signup')}
          disabled={busy}
          style={styles.modeTabBtn}
          testID="auth-mode-signup"
        >
          Criar conta
        </PxButton>
      </View>

      {mode === 'signup' && !profile && (
        <View style={styles.field}>
          <Txt weight={700} size={13} upper spacing={0.04} color={C.muted}>
            Apelido (opcional)
          </Txt>
          <View style={styles.inputBox}>
            <Inset side="top" h={3} color={C.cream2} />
            <PxOutline color={focused === 'name' ? C.gold : C.ink} />
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={32}
              placeholder="Viajante"
              placeholderTextColor="#757575"
              autoCorrect={false}
              onFocus={() => setFocused('name')}
              onBlur={() => setFocused(null)}
              cursorColor={C.ink}
              underlineColorAndroid="transparent"
              accessibilityLabel="Apelido"
              style={styles.input}
              testID="auth-name-input"
            />
          </View>
        </View>
      )}

      {mode === 'signup' && (
        <View style={styles.field}>
          <Txt weight={700} size={13} upper spacing={0.04} color={C.muted}>
            @username (opcional)
          </Txt>
          <View style={styles.inputBox}>
            <Inset side="top" h={3} color={C.cream2} />
            <PxOutline color={focused === 'username' ? C.gold : C.ink} />
            <TextInput
              value={username}
              onChangeText={setUsername}
              maxLength={24}
              placeholder={suggestedUsername ? `ex: ${suggestedUsername}` : 'ex: ciclista_sp'}
              placeholderTextColor="#757575"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              onFocus={() => setFocused('username')}
              onBlur={() => setFocused(null)}
              cursorColor={C.ink}
              underlineColorAndroid="transparent"
              accessibilityLabel="Nome de usuário"
              style={styles.input}
              testID="auth-username-input"
            />
          </View>
        </View>
      )}

      <View style={styles.field}>
        <Txt weight={700} size={13} upper spacing={0.04} color={C.muted}>
          E-mail
        </Txt>
        <View style={styles.inputBox}>
          <Inset side="top" h={3} color={C.cream2} />
          <PxOutline color={focused === 'email' ? C.gold : C.ink} />
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="voce@exemplo.com"
            placeholderTextColor="#757575"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType={mode === 'reset' ? 'send' : 'next'}
            onSubmitEditing={mode === 'reset' ? () => void submit() : undefined}
            onFocus={() => setFocused('email')}
            onBlur={() => setFocused(null)}
            cursorColor={C.ink}
            underlineColorAndroid="transparent"
            accessibilityLabel="E-mail"
            style={styles.input}
            testID="auth-email-input"
          />
        </View>
      </View>

      {mode !== 'reset' && (
        <View style={styles.field}>
          <Txt weight={700} size={13} upper spacing={0.04} color={C.muted}>
            Senha
          </Txt>
          <View style={styles.inputBox}>
            <Inset side="top" h={3} color={C.cream2} />
            <PxOutline color={focused === 'password' ? C.gold : C.ink} />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Mínimo 6 caracteres"
              placeholderTextColor="#757575"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              textContentType={mode === 'signup' ? 'newPassword' : 'password'}
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
              cursorColor={C.ink}
              underlineColorAndroid="transparent"
              accessibilityLabel="Senha"
              style={styles.input}
              testID="auth-password-input"
            />
          </View>
        </View>
      )}

      {errorMsg && (
        <PxBox bg={C.coral} drop={false} style={styles.banner} testID="auth-error">
          <Txt size={13} weight={700} color={C.cream}>
            {errorMsg}
          </Txt>
        </PxBox>
      )}

      {infoMsg && (
        <PxBox bg={C.panel2} drop={false} style={styles.banner} testID="auth-info">
          <Txt size={13} weight={600} color={C.mint}>
            {infoMsg}
          </Txt>
        </PxBox>
      )}

      <View style={styles.actions}>
        <PxButton
          variant="gold"
          block
          disabled={busy}
          onPress={() => void submit()}
          testID="auth-submit"
        >
          {busy
            ? mode === 'signin'
              ? 'Entrando…'
              : mode === 'signup'
                ? 'Criando conta…'
                : 'Enviando…'
            : mode === 'signin'
              ? 'Entrar'
              : mode === 'signup'
                ? 'Criar conta'
                : 'Enviar link'}
        </PxButton>

        <PxButton
          size="small"
          variant="ghost"
          block
          disabled={busy}
          onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
          testID="auth-toggle-mode"
        >
          {mode === 'signin' ? 'Não tem conta? Criar agora' : 'Já tem conta? Entrar'}
        </PxButton>

        {mode === 'signin' && (
          <PxButton
            size="small"
            variant="ghost"
            block
            disabled={busy}
            onPress={() => switchMode('reset')}
            testID="auth-reset-btn"
          >
            Esqueci minha senha
          </PxButton>
        )}

        <PxButton size="small" variant="default" block disabled={busy} onPress={onClose}>
          Agora não
        </PxButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  centerRow: { alignItems: 'center' },
  modeTabs: { flexDirection: 'row', gap: 10 },
  modeTabBtn: { flex: 1 },
  field: { gap: 6 },
  inputBox: { backgroundColor: C.cream },
  input: {
    height: 44,
    paddingHorizontal: 12,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
    fontFamily: uiFont(700),
    fontSize: 16,
    color: C.ink,
    textAlignVertical: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  } as TextStyle,
  banner: { paddingVertical: 10, paddingHorizontal: 12 },
  actions: { gap: 8, marginTop: 4 },
});
