import { describe, expect, it } from 'vitest';
import { transformPlaceholderImages } from './images';

describe('transformPlaceholderImages', () => {
  it('removes a nested placeholder when an HTML notebook output is present', () => {
    const mdast: any = {
      type: 'root',
      children: [
        {
          type: 'container',
          kind: 'figure',
          children: [
            {
              type: 'outputs',
              children: [
                {
                  type: 'output',
                  jupyter_data: {
                    output_type: 'display_data',
                    data: {
                      'text/html': { content_type: 'text/html', content: '<div>plot</div>' },
                    },
                  },
                },
                { type: 'image', placeholder: true, url: 'fallback.svg' },
              ],
            },
          ],
        },
      ],
    };

    transformPlaceholderImages(mdast);

    expect(mdast.children[0].children[0].children).toHaveLength(1);
    expect(mdast.children[0].children[0].children[0].type).toBe('output');
  });

  it('keeps a placeholder when no renderable output is present', () => {
    const mdast: any = {
      type: 'root',
      children: [
        {
          type: 'container',
          kind: 'figure',
          children: [
            {
              type: 'outputs',
              children: [
                { type: 'output', jupyter_data: { output_type: 'display_data', data: {} } },
                { type: 'image', placeholder: true, url: 'fallback.svg' },
              ],
            },
          ],
        },
      ],
    };

    transformPlaceholderImages(mdast);

    expect(mdast.children[0].children[0].children[0].placeholder).toBe(undefined);
  });
});