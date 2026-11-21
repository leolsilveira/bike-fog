// Cabeçalhos das requisições a serviços públicos (Nominatim, OpenFreeMap).
// O Nominatim exige identificar o aplicativo; no celular mandamos um User-Agent próprio.
export const APP_HEADERS: Record<string, string> = {
  'User-Agent': 'Desbrava/0.2 (com.desbrava.app; React Native)',
};
