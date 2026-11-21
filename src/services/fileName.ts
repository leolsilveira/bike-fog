// Nome de arquivo a partir de uma chave do armazenamento (ex.: `city-poly:r/123` tem `:` e `/`).

/** Só [A-Za-z0-9-] passa direto; o resto vira `_` + 4 dígitos hex. Injetivo: chaves diferentes, nomes diferentes. */
export function safeFileName(key: string): string {
  return key.replace(/[^A-Za-z0-9-]/g, (c) => '_' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
