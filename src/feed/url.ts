/** URLs that leave the article sandbox must use a safe web protocol. */
import { absoluteUrl, isHttpUrl } from '../util';

export function absoluteFeedUrl(
  href: string | null | undefined,
  base?: string | null,
): string | null {
  const resolved = absoluteUrl(href, base);
  return isHttpUrl(resolved) ? resolved : null;
}
