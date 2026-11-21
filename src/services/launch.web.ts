// Parâmetros da URL (?sim=1&lat=&lng=&debug&skip).
let params: URLSearchParams | null = null;

export function launchParam(name: string): string | null {
  try {
    params ??= new URLSearchParams(window.location.search);
    return params.get(name);
  } catch {
    return null;
  }
}
