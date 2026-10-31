/**
 * Single-user auth backed by environment secrets.
 *
 * Passwords live only in `ADMIN_PASSWORD`, never in the database: the app is
 * deliberately single-user (FreshRSS-style multi-user is out of scope), which
 * keeps login cheap enough for the Free plan's 10ms CPU budget.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppConfig } from './config';
import type { Db } from './db';
import type { AppEnv, User } from './types';
import { hmacSha256, timingSafeEqual } from './util';

export const SESSION_COOKIE = 'buffy_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function ensureAdmin(db: Db, cfg: AppConfig): Promise<User> {
  await db.execute('insert into users (username) values ($1) on conflict (username) do nothing', [
    cfg.adminUsername,
  ]);
  const row = await db.one<{ id: number; username: string }>(
    'select id::int as id, username from users where username = $1',
    [cfg.adminUsername],
  );
  if (!row) throw new Error('Could not create the admin user');
  return row;
}

/** Compare the submitted credentials with the environment secrets. */
export async function verifyCredentials(
  db: Db,
  cfg: AppConfig,
  username: string,
  password: string,
): Promise<User | null> {
  if (!cfg.adminPassword) return null;
  const userOk = timingSafeEqual(username.trim(), cfg.adminUsername);
  const passOk = timingSafeEqual(password, cfg.adminPassword);
  if (!userOk || !passOk) return null;
  return ensureAdmin(db, cfg);
}

export async function issueSessionToken(cfg: AppConfig, user: User): Promise<string> {
  const expires = Date.now() + SESSION_TTL_MS;
  const signature = await hmacSha256(cfg.authSecret, `session:${user.id}.${expires}`);
  return `v1.${user.id}.${expires}.${signature}`;
}

export async function userFromSessionToken(
  cfg: AppConfig,
  token: string,
): Promise<User | null> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, rawId, rawExpires, signature] = parts;
  const id = Number.parseInt(rawId as string, 10);
  const expires = Number.parseInt(rawExpires as string, 10);
  if (!Number.isFinite(id) || id < 1 || !Number.isFinite(expires)) return null;
  if (expires < Date.now()) return null;
  const expected = await hmacSha256(cfg.authSecret, `session:${id}.${expires}`);
  if (!timingSafeEqual(expected, signature as string)) return null;
  return { id, username: cfg.adminUsername };
}

/** Stateless Auth token returned by ClientLogin; survives Worker restarts. */
export async function issueAuthToken(cfg: AppConfig, user: User): Promise<string> {
  const signature = await hmacSha256(cfg.authSecret, `auth:${user.id}`);
  return `${user.id}_${signature}`;
}

export async function userFromAuthToken(
  cfg: AppConfig,
  token: string,
): Promise<User | null> {
  const separator = token.indexOf('_');
  if (separator <= 0) return null;
  const rawId = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id < 1) return null;
  const expected = await hmacSha256(cfg.authSecret, `auth:${id}`);
  if (!timingSafeEqual(expected, signature)) return null;
  return { id, username: cfg.adminUsername };
}

/** The `T` parameter required by state-changing Google Reader calls. */
export async function actionToken(cfg: AppConfig, user: User): Promise<string> {
  return hmacSha256(cfg.authSecret, `token:${user.id}`);
}

function base64Decode(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function userFromBasicHeader(
  db: Db,
  cfg: AppConfig,
  header: string,
): Promise<User | null> {
  try {
    const decoded = base64Decode(header);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return verifyCredentials(db, cfg, decoded.slice(0, separator), decoded.slice(separator + 1));
  } catch {
    return null;
  }
}

/**
 * Resolve the caller from (in order): GoogleLogin/Bearer token, query token,
 * session cookie, HTTP Basic. Returns null when nothing matches.
 */
export async function authenticate(
  db: Db,
  cfg: AppConfig,
  request: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
    cookie: (name: string) => string | undefined;
  },
): Promise<User | null> {
  const authorization = request.header('authorization') ?? '';
  const googleLogin = /^GoogleLogin\s+auth=(.+)$/i.exec(authorization);
  if (googleLogin) {
    const user = await userFromAuthToken(cfg, googleLogin[1] as string);
    if (user) return user;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) {
    const user = await userFromAuthToken(cfg, bearer[1] as string);
    if (user) return user;
  }
  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  if (basic) {
    const user = await userFromBasicHeader(db, cfg, basic[1] as string);
    if (user) return user;
  }

  const queryToken = request.query('Auth') ?? request.query('auth');
  if (queryToken) {
    const user = await userFromAuthToken(cfg, queryToken);
    if (user) return user;
  }

  const cookieToken = request.cookie(SESSION_COOKIE);
  if (cookieToken) {
    const user = await userFromSessionToken(cfg, cookieToken);
    if (user) return user;
  }
  return null;
}

function isSecureRequest(url: string): boolean {
  return new URL(url).protocol === 'https:';
}

export async function startSession(
  c: { req: { url: string } },
  cfg: AppConfig,
  user: User,
  set: (value: string, options: Record<string, unknown>) => void,
): Promise<void> {
  const token = await issueSessionToken(cfg, user);
  set(token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: isSecureRequest(c.req.url),
  });
}

export function endSession(c: { req: { url: string } }, remove: (options: Record<string, unknown>) => void): void {
  remove({ path: '/', secure: isSecureRequest(c.req.url) });
}

/** Helper for Hono handlers that want to set/clear the cookie directly. */
export function sessionCookieHelpers(c: {
  req: { url: string };
  setCookie: (name: string, value: string, options: Record<string, unknown>) => void;
  deleteCookie: (name: string, options: Record<string, unknown>) => void;
}): {
  set: (value: string) => void;
  clear: () => void;
} {
  return {
    set(value: string) {
      c.setCookie(SESSION_COOKIE, value, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: isSecureRequest(c.req.url),
      });
    },
    clear() {
      c.deleteCookie(SESSION_COOKIE, { path: '/', secure: isSecureRequest(c.req.url) });
    },
  };
}

export { getCookie, setCookie, deleteCookie };

export const requireWebAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = c.get('db');
  const cfg = c.get('cfg');
  const user = await authenticate(db, cfg, {
    header: (name) => c.req.header(name),
    query: (name) => c.req.query(name),
    cookie: (name) => getCookie(c, name),
  });
  if (!user) {
    const url = new URL(c.req.url);
    const next = `${url.pathname}${url.search}`;
    return c.redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  c.set('user', user);
  await next();
};
