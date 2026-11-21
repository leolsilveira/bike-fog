// Regras puras de autenticação, validação de @username e mapeamento de erros para pt-BR (testável no Node 24).
// Não importa react-native, expo-* nem módulos com variante por plataforma (.web.ts).

export const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}

export function validateUsername(
  raw: string,
): { ok: true; username: string } | { ok: false; error: string } {
  const u = normalizeUsername(raw);
  if (!u) {
    return { ok: false, error: 'Digite um @username.' };
  }
  if (u.length < 3) {
    return { ok: false, error: 'O @username deve ter pelo menos 3 caracteres.' };
  }
  if (u.length > 24) {
    return { ok: false, error: 'O @username deve ter no máximo 24 caracteres.' };
  }
  if (!USERNAME_REGEX.test(u)) {
    return { ok: false, error: 'Use apenas letras minúsculas (a-z), números (0-9) e underscore (_).' };
  }
  return { ok: true, username: u };
}

export function suggestUsernameFromName(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  let slug = ascii
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/g, '');

  if (slug.length >= 3 && isValidUsername(slug)) return slug;
  if (slug.length >= 1) {
    const padded = `${slug}_br`.slice(0, 24);
    if (isValidUsername(padded)) return padded;
  }
  return '';
}

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  error_description?: unknown;
}

export function mapAuthError(err: unknown): string {
  const obj = (typeof err === 'object' && err !== null ? err : null) as ErrorLike | null;
  const rawMsg =
    typeof err === 'string'
      ? err
      : typeof obj?.message === 'string'
        ? obj.message
        : typeof obj?.error_description === 'string'
          ? obj.error_description
          : err instanceof Error
            ? err.message
            : '';
  const code = typeof obj?.code === 'string' ? obj.code.trim() : '';
  const status = typeof obj?.status === 'number' ? obj.status : undefined;
  const m = rawMsg.toLowerCase();

  if (code === '23505' || m.includes('profiles_username_key') || m.includes('duplicate key')) {
    return 'Esse @username já está em uso. Escolha outro.';
  }
  if (code === '23514' || m.includes('profiles_username_format')) {
    return 'O @username deve ter entre 3 e 24 caracteres (a-z, 0-9 e _).';
  }
  if (
    code === 'invalid_credentials' ||
    m.includes('invalid login credentials') ||
    m.includes('invalid_credentials')
  ) {
    return 'E-mail ou senha incorretos.';
  }
  if (code === 'email_not_confirmed' || m.includes('email not confirmed')) {
    return 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.';
  }
  if (
    code === 'user_already_exists' ||
    code === 'email_exists' ||
    m.includes('user already registered') ||
    m.includes('already been registered')
  ) {
    return 'Já existe uma conta cadastrada com este e-mail.';
  }
  if (
    code === 'weak_password' ||
    m.includes('password should be at least') ||
    m.includes('weak password')
  ) {
    return 'A senha deve ter pelo menos 6 caracteres.';
  }
  if (
    m.includes('unable to validate email address') ||
    m.includes('invalid format') ||
    (m.includes('validation_failed') && m.includes('email')) ||
    m.includes('valid email')
  ) {
    return 'Digite um endereço de e-mail válido.';
  }
  if (
    status === 429 ||
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('for security purposes, you can only request this after')
  ) {
    return 'Muitas tentativas seguidas. Aguarde um momento e tente novamente.';
  }
  if (
    m.includes('network request failed') ||
    m.includes('failed to fetch') ||
    m.includes('fetch failed') ||
    m.includes('networkerror') ||
    m.includes('econnrefused')
  ) {
    return 'Sem conexão com o servidor. Confira sua internet.';
  }
  if (code === 'signup_disabled' || m.includes('signup is disabled')) {
    return 'Cadastro por e-mail indisponível no momento.';
  }
  if (code === 'user_not_found' || m.includes('user not found')) {
    return 'Conta não encontrada.';
  }
  if (code === 'same_password' || m.includes('new password should be different')) {
    return 'A nova senha deve ser diferente da atual.';
  }
  if (
    rawMsg &&
    /^(Digite|Escolha|O @username|Use apenas|A senha|Supabase|Não foi|Esse @username|Já existe|E-mail|Confirme|Sem conexão|Muitas tentativas)/.test(
      rawMsg.trim(),
    )
  ) {
    return rawMsg.trim();
  }
  return 'Não foi possível concluir a operação. Tente novamente.';
}
