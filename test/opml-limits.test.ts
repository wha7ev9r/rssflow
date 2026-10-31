import { describe, expect, test } from 'bun:test';
import { MAX_OPML_BYTES, MAX_OPML_FEEDS, parseOpml } from '../src/opml';

function opml(count: number): string {
  return `<opml><body>${Array.from({ length: count }, (_, i) =>
    `<outline text="Feed ${i}" xmlUrl="https://example.com/${i}" />`).join('')}</body></opml>`;
}

describe('OPML resource limits', () => {
  test('rejects too many outlines before callers can partially import', () => {
    expect(parseOpml(opml(MAX_OPML_FEEDS))).toHaveLength(MAX_OPML_FEEDS);
    expect(() => parseOpml(opml(MAX_OPML_FEEDS + 1))).toThrow('每次最多导入');
  });

  test('limits UTF-8 bytes, not only JavaScript string length', () => {
    expect(() => parseOpml(' '.repeat(MAX_OPML_BYTES + 1))).toThrow('文件过大');
    const unicode = `<opml><head><title>${'订'.repeat(Math.ceil(MAX_OPML_BYTES / 3))}</title></head><body /></opml>`;
    expect(unicode.length).toBeLessThan(MAX_OPML_BYTES);
    expect(() => parseOpml(unicode)).toThrow('文件过大');
  });

  test('rejects pathological folder nesting with a clear error', () => {
    const nested = '<opml><body>' + '<outline text="nested">'.repeat(40) +
      '<outline xmlUrl="https://example.com/feed" />' + '</outline>'.repeat(40) + '</body></opml>';
    expect(() => parseOpml(nested)).toThrow('嵌套过深');
  });
});
