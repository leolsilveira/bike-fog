// fetch com tempo limite: no 3G do meio da rua uma requisição pode ficar pendurada por minutos.
import { APP_HEADERS } from '../services/http';

export async function fetchWithTimeout(
  url: string,
  ms: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: { ...APP_HEADERS, ...headers }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
