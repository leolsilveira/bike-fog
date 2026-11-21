// Armazenamento seguro de sessão no nativo (LargeSecureStore):
// - A chave AES-256 fica no Keychain/Keystore via expo-secure-store (AFTER_FIRST_UNLOCK).
// - O payload da sessão criptografado com AES-256-GCM fica em Documents/desbrava-auth,
//   isolado de `storage.clear()` / `wipeAll()` para não apagar tokens acidentalmente.
import type { SupportedStorage } from '@supabase/supabase-js';
import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { utf8Decode, utf8Encode } from '../game/binary.ts';
import { safeFileName } from './fileName.ts';

const DIR_NAME = 'desbrava-auth';
const ENC_EXT = '.enc';
const TMP_EXT = '.tmp';
const SECURE_KEY_PREFIX = 'desbrava.supabase.aes.';
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

let authDir: Directory | null = null;
const queues = new Map<string, Promise<unknown>>();

function getAuthDir(): Directory {
  if (!authDir) {
    const d = new Directory(Paths.document, DIR_NAME);
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    authDir = d;
  }
  return authDir;
}

function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

function secureKeyName(key: string): string {
  return SECURE_KEY_PREFIX + safeFileName(key);
}

async function writeAtomicBytes(name: string, bytes: Uint8Array): Promise<void> {
  const d = getAuthDir();
  const tmp = new File(d, name + TMP_EXT);
  await tmp.write(bytes);
  await tmp.move(new File(d, name), { overwrite: true });
}

async function readFirstBytes(name: string): Promise<Uint8Array | null> {
  const d = getAuthDir();
  for (const f of [new File(d, name), new File(d, name + TMP_EXT)]) {
    if (!f.exists) continue;
    try {
      return await f.bytes();
    } catch (err) {
      console.warn('[sessionStorage] leitura falhou', f.name, err);
    }
  }
  return null;
}

function deleteIfExists(f: File): void {
  try {
    if (f.exists) f.delete();
  } catch (err) {
    console.warn('[sessionStorage] não consegui apagar', f.name, err);
  }
}

async function getOrCreateAesKey(key: string): Promise<AESEncryptionKey> {
  const sKey = secureKeyName(key);
  const existingHex = await SecureStore.getItemAsync(sKey, SECURE_OPTS);
  if (existingHex && existingHex.length === 64) {
    try {
      return await AESEncryptionKey.import(existingHex, 'hex');
    } catch (err) {
      console.warn('[sessionStorage] chave AES inválida, gerando nova', err);
    }
  }
  const fresh = await AESEncryptionKey.generate(AESKeySize.AES256);
  const hex = await fresh.encoded('hex');
  await SecureStore.setItemAsync(sKey, hex, SECURE_OPTS);
  return fresh;
}

export const sessionStorage: SupportedStorage = {
  getItem(key: string): Promise<string | null> {
    const fileName = safeFileName(key) + ENC_EXT;
    const sKey = secureKeyName(key);
    return serial(key, async () => {
      try {
        const available = await SecureStore.isAvailableAsync();
        if (!available) {
          console.warn('[sessionStorage] SecureStore indisponível no dispositivo');
          return null;
        }
        const hex = await SecureStore.getItemAsync(sKey, SECURE_OPTS);
        if (!hex) return null;
        const combined = await readFirstBytes(fileName);
        if (!combined) return null;

        const aesKey = await AESEncryptionKey.import(hex, 'hex');
        const sealed = AESSealedData.fromCombined(combined);
        const plainBytes = await aesDecryptAsync(sealed, aesKey);
        return utf8Decode(plainBytes);
      } catch (err) {
        console.warn('[sessionStorage] falha ao recuperar sessão criptografada', err);
        return null;
      }
    });
  },

  setItem(key: string, value: string): Promise<void> {
    const fileName = safeFileName(key) + ENC_EXT;
    return serial(key, async () => {
      try {
        const available = await SecureStore.isAvailableAsync();
        if (!available) {
          console.warn('[sessionStorage] SecureStore indisponível para salvar sessão');
          return;
        }
        const aesKey = await getOrCreateAesKey(key);
        const sealed = await aesEncryptAsync(utf8Encode(value), aesKey);
        const combined = await sealed.combined('bytes');
        await writeAtomicBytes(fileName, combined);
      } catch (err) {
        console.warn('[sessionStorage] falha ao salvar sessão criptografada', err);
      }
    });
  },

  removeItem(key: string): Promise<void> {
    const fileName = safeFileName(key) + ENC_EXT;
    const sKey = secureKeyName(key);
    return serial(key, async () => {
      try {
        const d = getAuthDir();
        deleteIfExists(new File(d, fileName));
        deleteIfExists(new File(d, fileName + TMP_EXT));
      } catch (err) {
        console.warn('[sessionStorage] falha ao remover arquivo de sessão', err);
      }
      try {
        const available = await SecureStore.isAvailableAsync();
        if (available) await SecureStore.deleteItemAsync(sKey, SECURE_OPTS);
      } catch (err) {
        console.warn('[sessionStorage] falha ao remover chave do SecureStore', err);
      }
    });
  },
};
