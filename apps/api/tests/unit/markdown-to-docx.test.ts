import { describe, it, expect } from 'vitest';
import { parseMarkdownContent } from '../../src/services/markdown-to-docx';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+f4QAAAAASUVORK5CYII=';

describe('markdown-to-docx image parsing', () => {
  it('embeds standalone markdown image references as ImageRun blocks', async () => {
    const blocks = await parseMarkdownContent(
      `![tiny](data:image/png;base64,${ONE_BY_ONE_PNG_BASE64})`,
      false,
      'dark',
      2,
      2,
      false,
      100
    );

    expect(blocks).toHaveLength(1);
    const first = blocks[0] as any;
    expect(first?.root?.[1]?.constructor?.name).toBe('ImageRun');
  });

  it('respects HTML <img> width attribute when embedding', async () => {
    const blocks = await parseMarkdownContent(
      `<img src="data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}" width="200" />`,
      false,
      'dark',
      2,
      2,
      false,
      100
    );

    const imageRun = (blocks[0] as any)?.root?.[1];
    expect(imageRun?.constructor?.name).toBe('ImageRun');
    expect(imageRun?.imageData?.transformation?.pixels?.x).toBe(200);
  });
});
