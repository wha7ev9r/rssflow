/** Google Reader stream identifiers. */

export type Stream =
  | { kind: 'all' }
  | { kind: 'unread' }
  | { kind: 'read' }
  | { kind: 'starred' }
  | { kind: 'feed'; ref: string }
  | { kind: 'label'; label: string };

const STATE_PREFIX = 'state/com.google/';

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accepts Google Reader ids in all the shapes clients send:
 *   user/-/state/com.google/reading-list
 *   user/123/state/com.google/starred
 *   user/-/label/News
 *   feed/https://example.com/rss
 *   feed/42
 */
export function parseStreamId(raw: string | null | undefined): Stream | null {
  if (!raw) return null;
  const id = raw.trim();
  if (!id) return null;

  if (id.startsWith('feed/')) {
    const ref = id.slice('feed/'.length).trim();
    return ref ? { kind: 'feed', ref: decodeComponent(ref) } : null;
  }

  const stateIndex = id.indexOf(STATE_PREFIX);
  if (id.startsWith('user/') && stateIndex >= 0) {
    const state = id.slice(stateIndex + STATE_PREFIX.length);
    switch (state) {
      case 'reading-list':
        return { kind: 'all' };
      case 'unread':
      case 'kept-unread':
        return { kind: 'unread' };
      case 'read':
      case 'tracking-read':
        return { kind: 'read' };
      case 'starred':
        return { kind: 'starred' };
      default:
        return null;
    }
  }

  if (id.startsWith('user/')) {
    const labelIndex = id.indexOf('/label/');
    if (labelIndex >= 0) {
      const label = id.slice(labelIndex + '/label/'.length);
      return label ? { kind: 'label', label: decodeComponent(label) } : null;
    }
  }

  return null;
}

export function feedStreamId(feedUrl: string): string {
  return `feed/${feedUrl}`;
}

export function labelStreamId(label: string): string {
  return `user/-/label/${label}`;
}

export const READING_LIST = 'user/-/state/com.google/reading-list';
export const STARRED = 'user/-/state/com.google/starred';
export const READ = 'user/-/state/com.google/read';
export const KEPT_UNREAD = 'user/-/state/com.google/kept-unread';

/** Build a Stream from the web UI's query parameters. */
export function streamFromQuery(params: {
  stream?: string | null;
  feed?: string | null;
  folder?: string | null;
}): Stream {
  const feedId = params.feed ? Number.parseInt(params.feed, 10) : NaN;
  if (Number.isFinite(feedId) && feedId > 0) return { kind: 'feed', ref: String(feedId) };
  if (params.folder) return { kind: 'label', label: params.folder };
  switch (params.stream) {
    case 'unread':
      return { kind: 'unread' };
    case 'starred':
      return { kind: 'starred' };
    default:
      return { kind: 'all' };
  }
}

/** Describe a stream for page headings and links. */
export function describeStream(stream: Stream, feedTitle?: string | null, folder?: string | null): string {
  switch (stream.kind) {
    case 'unread':
      return '未读';
    case 'starred':
      return '收藏';
    case 'read':
      return '已读';
    case 'feed':
      return feedTitle ?? (folder || '订阅源');
    case 'label':
      return stream.label;
    default:
      return '全部文章';
  }
}
