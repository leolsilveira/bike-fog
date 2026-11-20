// Curva de níveis e títulos.

/**
 * XP necessário para ir do nível n para n+1: 100, 170, 250, 350, 470… (cresce em curva, arredondado a 10).
 * Acumulado: nível 2 = 100, 5 = 870, 10 = 4.690, 15 = 13.410, 20 = 29.030.
 */
export function xpToNext(level: number): number {
  const n = level - 1;
  return Math.round((100 + 60 * n + 8 * n * n) / 10) * 10;
}

export interface LevelInfo {
  level: number;
  /** XP acumulado dentro do nível atual. */
  current: number;
  needed: number;
  title: string;
}

const TITLES: [number, string][] = [
  [1, 'Novato de bairro'],
  [3, 'Explorador'],
  [6, 'Desbravador'],
  [10, 'Cartógrafo urbano'],
  [15, 'Guardião da cidade'],
  [22, 'Lenda das ruas'],
  [30, 'Mestre da névoa'],
];

export function titleFor(level: number): string {
  let t = TITLES[0][1];
  for (const [min, name] of TITLES) if (level >= min) t = name;
  return t;
}

export function levelFromXp(xp: number): LevelInfo {
  let level = 1;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return { level, current: rest, needed: xpToNext(level), title: titleFor(level) };
}
