/** Small, dependency-free helpers shared by the Worker and tests. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

/** Strip tags and decode the handful of entities that matter for list previews. */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const n = parseInt(code, 16);
      return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function preview(html: string | null | undefined, max = 220): string {
  // Bound the regex work: list pages render many items on a 10ms CPU budget.
  return truncate(stripHtml((html ?? '').slice(0, 5000)), max);
}

export function timeAgo(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(ms);
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function b64urlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function b64urlDecodeText(input: string): string {
  return decoder.decode(b64urlDecode(input));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

/** Length-independent constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] as number) ^ (right[i] as number);
  return diff === 0;
}

export function intFrom(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function boolFrom(value: unknown, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

export function absoluteUrl(href: string | null | undefined, base: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, base ?? undefined).toString();
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
