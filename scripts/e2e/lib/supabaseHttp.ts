import crypto from 'node:crypto';
import { getEnv } from './env.ts';

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  rawText: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
}

export interface ProvisionedUser {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export interface VerifyActivityRequest {
  activityId: string;
  source: 'live' | 'gpx_import';
  modality: 'bike' | 'run';
  startedAt: number;
  endedAt: number;
  trackPath: string;
  clientSummary: {
    distanceM: number;
    movingS: number;
    maxSpeed: number;
    newCells: number;
    coinsCount: number;
    coinsValue: number;
    coinsByKind?: { bronze: number; silver: number; gold: number; gem: number };
    captures: {
      poiId: string;
      name: string;
      category: string;
      rarity: string;
      lat: number;
      lng: number;
    }[];
    cityIds: string[];
  };
  boostUsageIds?: string[];
}

export interface VerifyActivityResponse {
  status: 'verified' | 'flagged';
  reason?: string;
  activity: {
    id: string;
    verificationStatus: 'verified' | 'flagged';
    distanceM: number;
    movingS: number;
    maxSpeed: number;
    xpEarned: number;
    coinsEarned: number;
    newCells: number;
  };
  authoritative: {
    xp: number;
    level: number;
    wallet: number;
    totalDistanceM: number;
    totalMovingS: number;
    totalActivities: number;
    totalCells: number;
    totalCaptures: number;
    achievementsCount: number;
  };
}

async function parseResponse<T>(res: Response): Promise<HttpResponse<T>> {
  const rawText = await res.text();
  let data: unknown = null;
  if (rawText.length > 0) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = rawText;
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    data: data as T,
    rawText,
  };
}

export class SupabaseHttpClient {
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly anonJwt: string;
  readonly serviceRoleKey: string;

  constructor() {
    const env = getEnv();
    this.baseUrl = env.supabaseUrl;
    this.publishableKey = env.supabasePublishableKey;
    this.anonJwt = env.supabaseAnonJwt;
    this.serviceRoleKey = env.serviceRoleKey;
  }

  private authHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: this.publishableKey,
      ...extra,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else if (this.anonJwt) {
      headers.Authorization = `Bearer ${this.anonJwt}`;
    }
    return headers;
  }

  private serviceHeaders(extra?: Record<string, string>): Record<string, string> {
    if (!this.serviceRoleKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for admin operations');
    }
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      ...extra,
    };
  }

  async getAuthSettings(): Promise<HttpResponse<Record<string, unknown>>> {
    const res = await fetch(`${this.baseUrl}/auth/v1/settings`, {
      headers: { apikey: this.publishableKey },
    });
    return parseResponse(res);
  }

  // NOTE: /auth/v1/signup, /auth/v1/recover, and /auth/v1/resend are intentionally NOT exposed
  // against live Supabase to avoid bounced emails on lugwebngeyadfrqoapsg. Use adminCreateUser({ emailConfirm: true }).

  async signInWithPassword(email: string, password: string): Promise<HttpResponse<AuthSession>> {
    const res = await fetch(`${this.baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    return parseResponse(res);
  }

  async refreshToken(refreshToken: string): Promise<HttpResponse<AuthSession>> {
    const res = await fetch(`${this.baseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return parseResponse(res);
  }

  async adminCreateUser(opts: {
    email: string;
    password: string;
    emailConfirm?: boolean;
    userMetadata?: Record<string, unknown>;
  }): Promise<HttpResponse<{ id: string; email: string }>> {
    const res = await fetch(`${this.baseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: this.serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        email: opts.email,
        password: opts.password,
        email_confirm: opts.emailConfirm ?? true,
        user_metadata: opts.userMetadata ?? {},
      }),
    });
    return parseResponse(res);
  }

  async adminDeleteUser(userId: string): Promise<HttpResponse<unknown>> {
    const res = await fetch(`${this.baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: this.serviceHeaders(),
    });
    return parseResponse(res);
  }

  async rest<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathAndQuery: string,
    opts?: {
      token?: string;
      useServiceRole?: boolean;
      body?: unknown;
      prefer?: string;
      rawBearer?: string;
    },
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = opts?.useServiceRole
      ? this.serviceHeaders()
      : this.authHeaders(opts?.token);

    if (opts?.rawBearer !== undefined) {
      headers.Authorization = `Bearer ${opts.rawBearer}`;
    }
    if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts?.prefer) {
      headers.Prefer = opts.prefer;
    }

    const res = await fetch(`${this.baseUrl}/rest/v1/${pathAndQuery}`, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    return parseResponse<T>(res);
  }

  async rpc<T = unknown>(
    fnName: string,
    params: Record<string, unknown>,
    opts?: { token?: string; useServiceRole?: boolean; rawBearer?: string },
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = opts?.useServiceRole
      ? this.serviceHeaders({ 'Content-Type': 'application/json' })
      : this.authHeaders(opts?.token, { 'Content-Type': 'application/json' });
    if (opts?.rawBearer !== undefined) {
      headers.Authorization = `Bearer ${opts.rawBearer}`;
    }
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    return parseResponse<T>(res);
  }

  async storageUpload(
    bucket: string,
    objectPath: string,
    bytes: Uint8Array,
    opts?: {
      token?: string;
      useServiceRole?: boolean;
      contentType?: string;
      upsert?: boolean;
    },
  ): Promise<HttpResponse<Record<string, unknown>>> {
    const headers: Record<string, string> = opts?.useServiceRole
      ? this.serviceHeaders()
      : this.authHeaders(opts?.token);
    headers['Content-Type'] = opts?.contentType ?? 'application/octet-stream';
    if (opts?.upsert ?? true) {
      headers['x-upsert'] = 'true';
    }
    const cleanPath = objectPath.replace(/^\/+/, '');
    const res = await fetch(`${this.baseUrl}/storage/v1/object/${bucket}/${cleanPath}`, {
      method: 'POST',
      headers,
      body: Buffer.from(bytes),
    });
    return parseResponse(res);
  }

  async storageDownload(
    bucket: string,
    objectPath: string,
    opts?: { token?: string; useServiceRole?: boolean },
  ): Promise<{ status: number; ok: boolean; bytes: Uint8Array; text: string }> {
    const headers: Record<string, string> = opts?.useServiceRole
      ? this.serviceHeaders()
      : this.authHeaders(opts?.token);
    const cleanPath = objectPath.replace(/^\/+/, '');
    const res = await fetch(
      `${this.baseUrl}/storage/v1/object/authenticated/${bucket}/${cleanPath}`,
      { headers },
    );
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const text = res.ok ? '' : new TextDecoder().decode(bytes);
    return { status: res.status, ok: res.ok, bytes, text };
  }

  async storageList(
    bucket: string,
    prefix: string,
    opts?: { token?: string; useServiceRole?: boolean },
  ): Promise<HttpResponse<{ name: string; id?: string | null }[]>> {
    const headers: Record<string, string> = opts?.useServiceRole
      ? this.serviceHeaders({ 'Content-Type': 'application/json' })
      : this.authHeaders(opts?.token, { 'Content-Type': 'application/json' });
    const res = await fetch(`${this.baseUrl}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    return parseResponse(res);
  }

  async storageDeleteObjects(
    bucket: string,
    prefixes: string[],
    opts?: { token?: string; useServiceRole?: boolean },
  ): Promise<HttpResponse<unknown>> {
    if (prefixes.length === 0) {
      return { status: 200, ok: true, headers: new Headers(), data: [], rawText: '[]' };
    }
    const headers: Record<string, string> = opts?.useServiceRole
      ? this.serviceHeaders({ 'Content-Type': 'application/json' })
      : this.authHeaders(opts?.token, { 'Content-Type': 'application/json' });
    const res = await fetch(`${this.baseUrl}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ prefixes }),
    });
    return parseResponse(res);
  }

  async invokeVerifyActivity(
    payload: VerifyActivityRequest | Record<string, unknown>,
    opts?: { token?: string; rawBearer?: string; omitAuth?: boolean },
  ): Promise<HttpResponse<VerifyActivityResponse>> {
    const headers: Record<string, string> = {
      apikey: this.publishableKey,
      'Content-Type': 'application/json',
    };
    if (!opts?.omitAuth) {
      if (opts?.rawBearer !== undefined) {
        headers.Authorization = `Bearer ${opts.rawBearer}`;
      } else if (opts?.token) {
        headers.Authorization = `Bearer ${opts.token}`;
      }
    }
    const res = await fetch(`${this.baseUrl}/functions/v1/verify-activity`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return parseResponse<VerifyActivityResponse>(res);
  }
}

export class TestUserRegistry {
  private readonly client: SupabaseHttpClient;
  private readonly users: ProvisionedUser[] = [];
  private readonly runId: string;

  constructor(client?: SupabaseHttpClient) {
    this.client = client ?? new SupabaseHttpClient();
    this.runId = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  }

  async provisionUser(
    tag: string,
    opts?: {
      displayName?: string;
      username?: string;
      isPublic?: boolean;
      modality?: 'bike' | 'run';
      ensureProfile?: boolean;
    },
  ): Promise<ProvisionedUser> {
    const safeTag = tag.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const suffix = crypto.randomBytes(3).toString('hex');
    const email = `e2e+${this.runId}+${safeTag}+${suffix}@desbrava-e2e.test`;
    const password = `E2e!${crypto.randomBytes(12).toString('base64url')}`;
    const displayName = opts?.displayName ?? `E2E ${tag}`;

    const created = await this.client.adminCreateUser({
      email,
      password,
      emailConfirm: true,
      userMetadata: { display_name: displayName },
    });
    if (!created.ok || !created.data?.id) {
      throw new Error(
        `adminCreateUser failed (${created.status}): ${created.rawText}`,
      );
    }

    const signedIn = await this.client.signInWithPassword(email, password);
    if (!signedIn.ok || !signedIn.data?.access_token) {
      await this.client.adminDeleteUser(created.data.id).catch(() => undefined);
      throw new Error(
        `signInWithPassword failed (${signedIn.status}): ${signedIn.rawText}`,
      );
    }

    const user: ProvisionedUser = {
      userId: created.data.id,
      email,
      password,
      accessToken: signedIn.data.access_token,
      refreshToken: signedIn.data.refresh_token,
    };
    this.users.push(user);

    if (opts?.ensureProfile !== false) {
      const existing = await this.client.rest<{ id: string }[]>(
        'GET',
        `profiles?id=eq.${user.userId}&select=id`,
        { token: user.accessToken },
      );
      if (existing.ok && Array.isArray(existing.data) && existing.data.length === 0) {
        const ins = await this.client.rest(
          'POST',
          'profiles',
          {
            token: user.accessToken,
            prefer: 'return=minimal',
            body: {
              id: user.userId,
              display_name: displayName,
              modality: opts?.modality ?? 'bike',
              is_public: opts?.isPublic ?? true,
              ...(opts?.username ? { username: opts.username } : {}),
            },
          },
        );
        if (!ins.ok) {
          throw new Error(`provisionUser profile INSERT failed (${ins.status}): ${ins.rawText}`);
        }
      } else if (
        opts?.username !== undefined ||
        opts?.isPublic !== undefined ||
        opts?.displayName !== undefined ||
        opts?.modality !== undefined
      ) {
        const patch: Record<string, unknown> = {};
        if (opts?.displayName !== undefined) patch.display_name = opts.displayName;
        if (opts?.username !== undefined) patch.username = opts.username;
        if (opts?.isPublic !== undefined) patch.is_public = opts.isPublic;
        if (opts?.modality !== undefined) patch.modality = opts.modality;
        const upd = await this.client.rest('PATCH', `profiles?id=eq.${user.userId}`, {
          token: user.accessToken,
          prefer: 'return=minimal',
          body: patch,
        });
        if (!upd.ok) {
          throw new Error(`provisionUser profile PATCH failed (${upd.status}): ${upd.rawText}`);
        }
      }
    }

    return user;
  }

  private async deleteFolderRecursive(bucket: string, prefix: string): Promise<void> {
    const listed = await this.client.storageList(bucket, prefix, { useServiceRole: true });
    if (!listed.ok || !Array.isArray(listed.data)) return;
    const files: string[] = [];
    for (const item of listed.data) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null || item.id === undefined) {
        await this.deleteFolderRecursive(bucket, fullPath);
      } else {
        files.push(fullPath);
      }
    }
    if (files.length > 0) {
      await this.client.storageDeleteObjects(bucket, files, { useServiceRole: true });
    }
  }

  async cleanup(): Promise<void> {
    const env = getEnv();
    if (env.keepData) return;
    const list = this.users.splice(0, this.users.length).reverse();
    for (const u of list) {
      await this.deleteFolderRecursive('activity-tracks', u.userId).catch(() => undefined);
      await this.deleteFolderRecursive('fog-snapshots', u.userId).catch(() => undefined);
      await this.client.adminDeleteUser(u.userId).catch(() => undefined);
    }
  }
}
