// Parser puro de links de convite (`desbrava://add/<username>`, URLs web e `?add=<username>`).
// Testável diretamente no Node 24 sem depender de react-native ou expo-linking.
import { isValidUsername, normalizeUsername } from './authCore.ts';

function acceptCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const normalized = normalizeUsername(decoded);
  return isValidUsername(normalized) ? normalized : null;
}

export function parseInviteUsername(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);

    // 1. Parâmetro ?add=<username>
    const qAdd = acceptCandidate(parsed.searchParams.get('add'));
    if (qAdd) return qAdd;

    // 2. Esquema customizado `desbrava://add/<username>` -> hostname === 'add', pathname === '/<username>'
    if (parsed.protocol === 'desbrava:' && parsed.hostname.toLowerCase() === 'add') {
      const seg = parsed.pathname.split('/').filter(Boolean)[0];
      const fromHost = acceptCandidate(seg);
      if (fromHost) return fromHost;
    }

    // 3. Caminho `/add/<username>` (desbrava:///add/alice, exp://.../--/add/alice, https://.../add/alice)
    const segments = parsed.pathname.split('/').filter(Boolean);
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i]?.toLowerCase() === 'add') {
        const fromPath = acceptCandidate(segments[i + 1]);
        if (fromPath) return fromPath;
      }
    }
    return null;
  } catch {
    // Fallback para URLs relativas (ex.: `/add/alice` ou `?add=alice`)
    const qMatch = /[?&]add=([^&#]+)/i.exec(trimmed);
    if (qMatch?.[1]) {
      const fromQuery = acceptCandidate(qMatch[1]);
      if (fromQuery) return fromQuery;
    }
    const pMatch = /(?:^|\/)add\/([^/?#]+)/i.exec(trimmed);
    if (pMatch?.[1]) {
      const fromPath = acceptCandidate(pMatch[1]);
      if (fromPath) return fromPath;
    }
    return null;
  }
}
