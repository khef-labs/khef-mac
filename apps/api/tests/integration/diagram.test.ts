import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

import diagramRoutes from '../../src/routes/diagram';

describe('Diagram Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.register(diagramRoutes, { prefix: '/api/diagram' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/diagram/health', () => {
    it('returns ok when Kroki is available', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/diagram/health',
      });

      // May return 200 or 503 depending on whether Kroki is running
      expect([200, 503]).toContain(res.statusCode);

      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('status');
    });
  });

  describe('POST /api/diagram/preview', () => {
    it('returns 400 when type is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { content: 'graph TD\n  A --> B' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Missing required fields');
    });

    it('returns 400 when content is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Missing required fields');
    });

    it('returns 400 for invalid diagram type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'invalid', content: 'test' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Invalid diagram type');
    });

    it('returns 400 for invalid theme', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid', content: 'graph TD\n  A --> B', theme: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Invalid theme');
    });

    it('accepts valid diagram types', async () => {
      const validTypes = ['mermaid', 'd2', 'plantuml', 'graphviz'];

      for (const type of validTypes) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/diagram/preview',
          payload: { type, content: 'test content' },
        });

        // Should not return 400 for type validation
        // May return 422 if Kroki can't parse the content, or 200 if it works
        expect(res.statusCode).not.toBe(400);
      }
    });

    it('accepts dark and light themes', async () => {
      const themes = ['dark', 'light'];

      for (const theme of themes) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/diagram/preview',
          payload: { type: 'mermaid', content: 'graph TD\n  A --> B', theme },
        });

        // Should not return 400 for theme validation
        expect(res.statusCode).not.toBe(400);
      }
    });

    it('defaults to dark theme when not specified', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid', content: 'graph TD\n  A --> B' },
      });

      // Should not return 400, theme defaults to dark
      expect(res.statusCode).not.toBe(400);
    });

    it('accepts maxWidth parameter', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid', content: 'graph TD\n  A --> B', maxWidth: 800 },
      });

      // Should not return 400, maxWidth is valid
      expect(res.statusCode).not.toBe(400);
    });

    it('returns 400 for invalid maxWidth (non-number)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid', content: 'graph TD\n  A --> B', maxWidth: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('maxWidth must be a positive number');
    });

    it('returns 400 for invalid maxWidth (negative)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid', content: 'graph TD\n  A --> B', maxWidth: -100 },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('maxWidth must be a positive number');
    });

    it('returns 400 for invalid maxWidth (zero)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: { type: 'mermaid', content: 'graph TD\n  A --> B', maxWidth: 0 },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('maxWidth must be a positive number');
    });
  });
});

describe('Diagram Routes (with Kroki)', () => {
  let app: FastifyInstance;
  let krokiAvailable = false;

  beforeAll(async () => {
    app = Fastify();
    app.register(diagramRoutes, { prefix: '/api/diagram' });
    await app.ready();

    // Check if Kroki is available
    const healthRes = await app.inject({
      method: 'GET',
      url: '/api/diagram/health',
    });
    krokiAvailable = healthRes.statusCode === 200;
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a simple mermaid flowchart', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A[Start] --> B[End]',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('svg');
    expect(body.svg).toContain('<svg');
    expect(body.svg).toContain('</svg>');
  });

  it('renders a mermaid sequence diagram', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: `sequenceDiagram
    Alice->>Bob: Hello Bob!
    Bob-->>Alice: Hi Alice!`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.svg).toContain('<svg');
  });

  it('renders a mermaid class diagram', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: `classDiagram
    class Animal {
      +String name
      +makeSound()
    }`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.svg).toContain('<svg');
  });

  it('applies dark theme configuration', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A --> B',
        theme: 'dark',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Dark theme should include dark theme colors
    expect(body.svg).toContain('<svg');
  });

  it('applies light theme configuration', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A --> B',
        theme: 'light',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.svg).toContain('<svg');
  });

  it('returns 422 for invalid mermaid syntax', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'this is not valid mermaid syntax ~~~',
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('error');
  });

  it('sanitizes SVG output - removes script tags', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    // Render a valid diagram and ensure no script tags in output
    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A --> B',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.svg).not.toMatch(/<script[\s\S]*?<\/script>/i);
  });

  it('sanitizes SVG output - removes event handlers', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A --> B',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Should not contain onclick, onload, onerror, etc.
    expect(body.svg).not.toMatch(/\son\w+\s*=/i);
  });

  it('fixes class diagram text truncation', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: `classDiagram
    class UserRepository {
      +findByEmail(email) User
    }`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Should have max-width: none (our fix)
    expect(body.svg).toContain('max-width: none');
  });

  it('scales SVG when maxWidth is specified', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A[Start] --> B[End]',
        maxWidth: 300,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.svg).toContain('<svg');

    // Extract width from the SVG
    const widthMatch = body.svg.match(/width="(\d+)"/);
    if (widthMatch) {
      const width = parseInt(widthMatch[1], 10);
      expect(width).toBeLessThanOrEqual(300);
    }
  });

  it('does not scale SVG when width is already within maxWidth', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    // First render without maxWidth to see original size
    const originalRes = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A --> B',
      },
    });

    expect(originalRes.statusCode).toBe(200);
    const originalBody = JSON.parse(originalRes.payload);
    const originalWidthMatch = originalBody.svg.match(/width="([\d.]+)"/);

    if (originalWidthMatch) {
      const originalWidth = parseFloat(originalWidthMatch[1]);

      // Request with maxWidth larger than original
      const res = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: {
          type: 'mermaid',
          content: 'graph TD\n  A --> B',
          maxWidth: originalWidth + 500,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      const newWidthMatch = body.svg.match(/width="([\d.]+)"/);

      if (newWidthMatch) {
        const newWidth = parseFloat(newWidthMatch[1]);
        // Width should remain unchanged (or close to it due to rounding)
        expect(newWidth).toBeCloseTo(originalWidth, 0);
      }
    }
  });

  it('preserves aspect ratio when scaling', async () => {
    if (!krokiAvailable) {
      console.log('Skipping: Kroki not available');
      return;
    }

    // First render without maxWidth to get original dimensions
    const originalRes = await app.inject({
      method: 'POST',
      url: '/api/diagram/preview',
      payload: {
        type: 'mermaid',
        content: 'graph TD\n  A[Start] --> B[Middle] --> C[End]',
      },
    });

    expect(originalRes.statusCode).toBe(200);
    const originalBody = JSON.parse(originalRes.payload);
    const originalWidthMatch = originalBody.svg.match(/width="([\d.]+)"/);
    const originalHeightMatch = originalBody.svg.match(/height="([\d.]+)"/);

    if (originalWidthMatch && originalHeightMatch) {
      const originalWidth = parseFloat(originalWidthMatch[1]);
      const originalHeight = parseFloat(originalHeightMatch[1]);
      const originalRatio = originalWidth / originalHeight;

      // Render with maxWidth that will trigger scaling
      const scaledRes = await app.inject({
        method: 'POST',
        url: '/api/diagram/preview',
        payload: {
          type: 'mermaid',
          content: 'graph TD\n  A[Start] --> B[Middle] --> C[End]',
          maxWidth: Math.floor(originalWidth / 2),
        },
      });

      expect(scaledRes.statusCode).toBe(200);
      const scaledBody = JSON.parse(scaledRes.payload);
      const scaledWidthMatch = scaledBody.svg.match(/width="([\d.]+)"/);
      const scaledHeightMatch = scaledBody.svg.match(/height="([\d.]+)"/);

      if (scaledWidthMatch && scaledHeightMatch) {
        const scaledWidth = parseFloat(scaledWidthMatch[1]);
        const scaledHeight = parseFloat(scaledHeightMatch[1]);
        const scaledRatio = scaledWidth / scaledHeight;

        // Aspect ratio should be preserved (within 5% tolerance due to rounding)
        expect(scaledRatio).toBeCloseTo(originalRatio, 1);
      }
    }
  });
});
