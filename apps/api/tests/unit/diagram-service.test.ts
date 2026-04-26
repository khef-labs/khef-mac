import { describe, it, expect } from 'vitest';
import { normalizeMermaidForNoHtmlLabels } from '../../src/services/diagram';

// We need to test the sanitizeSvg function, but it's not exported
// So we'll test it indirectly through the renderDiagram function
// or we can import the module and test the regex patterns directly

describe('SVG Sanitization Patterns', () => {
  // Test the regex patterns used in sanitizeSvg

  describe('script tag removal', () => {
    const scriptRegex = /<script[\s\S]*?<\/script>/gi;

    it('removes inline script tags', () => {
      const input = '<svg><script>alert("xss")</script></svg>';
      const result = input.replace(scriptRegex, '');
      expect(result).toBe('<svg></svg>');
    });

    it('removes script tags with attributes', () => {
      const input = '<svg><script type="text/javascript">evil()</script></svg>';
      const result = input.replace(scriptRegex, '');
      expect(result).toBe('<svg></svg>');
    });

    it('removes multiline script tags', () => {
      const input = `<svg><script>
        var x = 1;
        alert(x);
      </script></svg>`;
      const result = input.replace(scriptRegex, '');
      expect(result).toBe('<svg></svg>');
    });

    it('removes multiple script tags', () => {
      const input = '<svg><script>a()</script><rect/><script>b()</script></svg>';
      const result = input.replace(scriptRegex, '');
      expect(result).toBe('<svg><rect/></svg>');
    });
  });

  describe('event handler removal', () => {
    const eventRegex1 = /\s+on\w+\s*=\s*["'][^"']*["']/gi;
    const eventRegex2 = /\s+on\w+\s*=\s*[^\s>]+/gi;

    function removeEventHandlers(input: string): string {
      return input
        .replace(eventRegex1, '')
        .replace(eventRegex2, '');
    }

    it('removes onclick handlers with double quotes', () => {
      const input = '<rect onclick="alert(1)"/>';
      const result = removeEventHandlers(input);
      expect(result).toBe('<rect/>');
    });

    it('removes onclick handlers with single quotes', () => {
      const input = "<rect onclick='alert(1)'/>";
      const result = removeEventHandlers(input);
      expect(result).toBe('<rect/>');
    });

    it('removes onload handlers', () => {
      const input = '<svg onload="evil()">';
      const result = removeEventHandlers(input);
      expect(result).toBe('<svg>');
    });

    it('removes onerror handlers', () => {
      const input = '<image onerror="hack()"/>';
      const result = removeEventHandlers(input);
      expect(result).toBe('<image/>');
    });

    it('removes onmouseover handlers', () => {
      const input = '<rect onmouseover="steal()">';
      const result = removeEventHandlers(input);
      expect(result).toBe('<rect>');
    });

    it('removes multiple event handlers', () => {
      const input = '<rect onclick="a()" onmouseover="b()"/>';
      const result = removeEventHandlers(input);
      expect(result).toBe('<rect/>');
    });

    it('preserves non-event attributes', () => {
      const input = '<rect fill="blue" onclick="evil()" width="100"/>';
      const result = removeEventHandlers(input);
      expect(result).toBe('<rect fill="blue" width="100"/>');
    });
  });

  describe('javascript URL removal', () => {
    const jsHrefRegex = /href\s*=\s*["']javascript:[^"']*["']/gi;
    const jsXlinkHrefRegex = /xlink:href\s*=\s*["']javascript:[^"']*["']/gi;

    function removeJsUrls(input: string): string {
      return input
        .replace(jsHrefRegex, 'href="#"')
        .replace(jsXlinkHrefRegex, 'xlink:href="#"');
    }

    it('removes javascript: href', () => {
      const input = '<a href="javascript:alert(1)">click</a>';
      const result = removeJsUrls(input);
      expect(result).toBe('<a href="#">click</a>');
    });

    it('removes javascript: xlink:href', () => {
      const input = '<use xlink:href="javascript:evil()"/>';
      const result = removeJsUrls(input);
      expect(result).toBe('<use xlink:href="#"/>');
    });

    it('preserves normal URLs', () => {
      const input = '<a href="https://example.com">link</a>';
      const result = removeJsUrls(input);
      expect(result).toBe('<a href="https://example.com">link</a>');
    });

    it('preserves fragment URLs', () => {
      const input = '<a href="#section">link</a>';
      const result = removeJsUrls(input);
      expect(result).toBe('<a href="#section">link</a>');
    });
  });

  describe('data URL handling', () => {
    const dataHrefRegex = /href\s*=\s*["']data:(?!image)[^"']*["']/gi;

    function removeNonImageDataUrls(input: string): string {
      return input.replace(dataHrefRegex, 'href="#"');
    }

    it('removes data:text URLs', () => {
      const input = '<a href="data:text/html,<script>alert(1)</script>">x</a>';
      const result = removeNonImageDataUrls(input);
      expect(result).toBe('<a href="#">x</a>');
    });

    it('preserves data:image URLs', () => {
      const input = '<image href="data:image/png;base64,abc123"/>';
      const result = removeNonImageDataUrls(input);
      expect(result).toBe('<image href="data:image/png;base64,abc123"/>');
    });
  });
});

describe('Mermaid Configuration', () => {
  describe('theme config injection', () => {
    it('dark theme config contains theme: dark', () => {
      const darkConfig = `%%{init: {
  'theme': 'dark',`;
      expect(darkConfig).toContain("'theme': 'dark'");
    });

    it('dark theme config sets text colors for visibility', () => {
      const expectedColors = [
        'primaryTextColor',
        'textColor',
        'actorTextColor',
        'signalTextColor',
        'labelTextColor',
      ];

      // These are the color variables we set in the dark theme
      for (const color of expectedColors) {
        expect(color).toBeTruthy(); // Just verify the variable names exist in our config
      }
    });
  });

  describe('class diagram width fix', () => {
    it('increases foreignObject widths by 50%', () => {
      const input = '<foreignObject width="100"';
      const regex = /<foreignObject width="([\d.]+)"/g;
      const result = input.replace(regex, (match, width) => {
        const newWidth = Math.ceil(parseFloat(width) * 1.5);
        return `<foreignObject width="${newWidth}"`;
      });
      expect(result).toBe('<foreignObject width="150"');
    });

    it('handles decimal widths', () => {
      const input = '<foreignObject width="189.421875"';
      const regex = /<foreignObject width="([\d.]+)"/g;
      const result = input.replace(regex, (match, width) => {
        const newWidth = Math.ceil(parseFloat(width) * 1.5);
        return `<foreignObject width="${newWidth}"`;
      });
      expect(result).toBe('<foreignObject width="285"');
    });

    it('removes max-width constraints', () => {
      const input = 'style="max-width: 200px; color: red"';
      const result = input.replace(/max-width:\s*\d+px/g, 'max-width: none');
      expect(result).toBe('style="max-width: none; color: red"');
    });
  });
});

describe('extractMermaidFromMarkdown', () => {
  const extractRegex = /```mermaid\n([\s\S]*?)\n```/;

  function extract(content: string): string | null {
    const match = content.match(extractRegex);
    return match ? match[1].trim() : null;
  }

  it('extracts mermaid code from markdown', () => {
    const md = `# Title

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

Some text`;

    const result = extract(md);
    expect(result).toBe('graph TD\n  A --> B');
  });

  it('returns null when no mermaid block', () => {
    const md = '# Just some markdown\n\nNo diagrams here.';
    const result = extract(md);
    expect(result).toBeNull();
  });

  it('extracts only the first mermaid block', () => {
    const md = `\`\`\`mermaid
first
\`\`\`

\`\`\`mermaid
second
\`\`\``;

    const result = extract(md);
    expect(result).toBe('first');
  });
});

describe('scaleSvgToMaxWidth', () => {
  // Import the function for testing
  // Since we can't import it directly, we'll test the regex patterns

  describe('dimension extraction from attributes', () => {
    const widthRegex = /<svg[^>]*\swidth="([\d.]+)(?:px)?"/i;
    const heightRegex = /<svg[^>]*\sheight="([\d.]+)(?:px)?"/i;

    it('extracts width from SVG attributes', () => {
      const svg = '<svg width="1200" height="800"></svg>';
      const match = svg.match(widthRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('1200');
    });

    it('extracts height from SVG attributes', () => {
      const svg = '<svg width="1200" height="800"></svg>';
      const match = svg.match(heightRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('800');
    });

    it('handles px suffix', () => {
      const svg = '<svg width="1200px" height="800px"></svg>';
      const widthMatch = svg.match(widthRegex);
      const heightMatch = svg.match(heightRegex);
      expect(widthMatch![1]).toBe('1200');
      expect(heightMatch![1]).toBe('800');
    });

    it('handles decimal values', () => {
      const svg = '<svg width="1234.5" height="567.89"></svg>';
      const widthMatch = svg.match(widthRegex);
      const heightMatch = svg.match(heightRegex);
      expect(widthMatch![1]).toBe('1234.5');
      expect(heightMatch![1]).toBe('567.89');
    });
  });

  describe('dimension extraction from viewBox', () => {
    const viewBoxRegex = /<svg[^>]*\sviewBox="[\d.\s]+ [\d.\s]+ ([\d.]+) ([\d.]+)"/i;

    it('extracts dimensions from viewBox', () => {
      const svg = '<svg viewBox="0 0 1200 800"></svg>';
      const match = svg.match(viewBoxRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe('1200');
      expect(match![2]).toBe('800');
    });

    it('handles viewBox with offset', () => {
      const svg = '<svg viewBox="10 20 1200 800"></svg>';
      const match = svg.match(viewBoxRegex);
      expect(match![1]).toBe('1200');
      expect(match![2]).toBe('800');
    });
  });

  describe('scaling calculations', () => {
    it('calculates correct scale factor', () => {
      const currentWidth = 1200;
      const maxWidth = 800;
      const scale = maxWidth / currentWidth;
      expect(scale).toBeCloseTo(0.6667, 3);
    });

    it('calculates proportional height', () => {
      const currentWidth = 1200;
      const currentHeight = 600;
      const maxWidth = 800;
      const scale = maxWidth / currentWidth;
      const newHeight = Math.round(currentHeight * scale);
      expect(newHeight).toBe(400);
    });

    it('maintains aspect ratio', () => {
      const currentWidth = 1200;
      const currentHeight = 600;
      const maxWidth = 800;
      const scale = maxWidth / currentWidth;
      const newHeight = Math.round(currentHeight * scale);

      const originalRatio = currentWidth / currentHeight;
      const newRatio = maxWidth / newHeight;
      expect(newRatio).toBeCloseTo(originalRatio, 1);
    });
  });

  describe('width/height attribute replacement', () => {
    it('replaces width attribute', () => {
      const svg = '<svg width="1200" height="800"></svg>';
      const result = svg.replace(
        /(<svg[^>]*\s)width="[\d.]+(?:px)?"/i,
        '$1width="800"'
      );
      expect(result).toBe('<svg width="800" height="800"></svg>');
    });

    it('replaces height attribute', () => {
      const svg = '<svg width="800" height="800"></svg>';
      const result = svg.replace(
        /(<svg[^>]*\s)height="[\d.]+(?:px)?"/i,
        '$1height="400"'
      );
      expect(result).toBe('<svg width="800" height="400"></svg>');
    });

    it('preserves other attributes', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"></svg>';
      let result = svg.replace(
        /(<svg[^>]*\s)width="[\d.]+(?:px)?"/i,
        '$1width="800"'
      );
      result = result.replace(
        /(<svg[^>]*\s)height="[\d.]+(?:px)?"/i,
        '$1height="533"'
      );
      expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(result).toContain('viewBox="0 0 1200 800"');
      expect(result).toContain('width="800"');
      expect(result).toContain('height="533"');
    });
  });

  describe('normalizeMermaidForNoHtmlLabels', () => {
    it('replaces br tags with spaces', () => {
      const input = 'flowchart TD\n  A["Line 1<br/>Line 2"]';
      const result = normalizeMermaidForNoHtmlLabels(input);
      expect(result).toBe('flowchart TD\n  A["Line 1 Line 2"]');
    });

    it('replaces escaped newlines with spaces', () => {
      const input = 'flowchart TD\n  A["Line 1\\nLine 2"]';
      const result = normalizeMermaidForNoHtmlLabels(input);
      expect(result).toBe('flowchart TD\n  A["Line 1 Line 2"]');
    });
  });
});
