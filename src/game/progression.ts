// Curva de níveis e títulos.

/** XP necessário para ir do nível n para n+1. */
export function xpToNext(level: number): number {
  return 120 + (level - 1) * 90;
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
