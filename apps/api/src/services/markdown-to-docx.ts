/**
 * Markdown-to-DOCX conversion service.
 * Uses the `docx` package to programmatically build a Word document from memory data.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  ExternalHyperlink,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
  convertInchesToTwip,
  WidthType,
  BorderStyle,
  ShadingType,
  TableLayoutType,
} from 'docx';
import type { ParagraphChild } from 'docx';
import { logger } from '../lib/logger';
import type { MemoryExportData } from './memory-to-markdown';
import { query } from '../db/client';
import { readFile } from 'node:fs/promises';

const log = logger.child({ component: 'docx' });
import {
  renderDiagram,
  renderDiagramToPng,
  renderSvgToPngWithPlaywright,
  parsePngDimensions,
  parseSvgDimensions,
  isKrokiAvailable,
  type DiagramType,
} from './diagram';
import { logDebug } from '../utils/debug-log';

const FONT = 'Arial';
const FONT_MONO = 'Courier New';
const SIZE_BODY = 22; // 11pt (half-points)
const SIZE_HEADING = 34; // 17pt (half-points)
const SIZE_CODE = 20; // 10pt
const SIZE_CODE_BLOCK = 19; // 9.5pt
const COLOR_HEADING = '1A1A1A';
const COLOR_BODY = '333333';
const COLOR_CODE = '555555';
const COLOR_CODE_BG = 'F5F5F5';
const COLOR_TABLE_BORDER = 'BFBFBF';
const TABLE_WIDTH_TWIPS = convertInchesToTwip(6.5);

const headingLevels: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

const COLOR_LINK = '0066CC';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FileRecord {
  id: string;
  mime_type: string;
  path: string;
}

type ImageRunType = 'png' | 'jpg' | 'gif' | 'bmp';

interface LoadedImage {
  data: Buffer;
  type: ImageRunType;
  width?: number;
  height?: number;
}

interface ImageReference {
  src: string;
  widthPx?: number;
}

/**
 * Parse inline markdown (bold, italic, code, links) into TextRun/ExternalHyperlink array.
 */
function parseInline(text: string): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  // Pattern matches: [text](url), **bold**, *italic*, `code`
  const pattern = /(\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE_BODY, color: COLOR_BODY }));
    }

    if (match[2] && match[3]) {
      // [text](url) - markdown link
      runs.push(
        new ExternalHyperlink({
          link: match[3],
          children: [
            new TextRun({
              text: match[2],
              font: FONT,
              size: SIZE_BODY,
              color: COLOR_LINK,
              underline: {},
            }),
          ],
        })
      );
    } else if (match[4]) {
      // **bold**
      runs.push(new TextRun({ text: match[4], bold: true, font: FONT, size: SIZE_BODY, color: COLOR_BODY }));
    } else if (match[5]) {
      // *italic*
      runs.push(new TextRun({ text: match[5], italics: true, font: FONT, size: SIZE_BODY, color: COLOR_BODY }));
    } else if (match[6]) {
      // `code`
      runs.push(new TextRun({ text: match[6], font: FONT_MONO, size: SIZE_CODE, color: COLOR_CODE }));
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE_BODY, color: COLOR_BODY }));
  }

  // If no runs were created, add the entire text as plain
  if (runs.length === 0) {
    runs.push(new TextRun({ text, font: FONT, size: SIZE_BODY, color: COLOR_BODY }));
  }

  return runs;
}

function buildCodeRuns(lines: string[]): TextRun[] {
  if (lines.length === 0) {
    return [new TextRun({ text: '', font: FONT_MONO, size: SIZE_CODE_BLOCK, color: COLOR_CODE })];
  }

  return lines.map((line, index) =>
    new TextRun({
      text: line,
      font: FONT_MONO,
      size: SIZE_CODE_BLOCK,
      color: COLOR_CODE,
      break: index === 0 ? undefined : 1,
    })
  );
}

function normalizeTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }
  return /^(\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?)$/.test(trimmed);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && !isTableSeparator(trimmed);
}

function buildTable(
  headerCells: string[],
  bodyRows: string[][]
): Table {
  const columnCount = Math.max(
    headerCells.length,
    ...bodyRows.map((row) => row.length)
  );
  const columnWidth = Math.max(1, Math.floor(TABLE_WIDTH_TWIPS / Math.max(1, columnCount)));
  const normalizedHeader = [...headerCells, ...Array(Math.max(0, columnCount - headerCells.length)).fill('')];
  const normalizedRows = bodyRows.map((row) => [
    ...row,
    ...Array(Math.max(0, columnCount - row.length)).fill(''),
  ]);
  const columnWidths = Array(columnCount).fill(columnWidth);

  const borders = {
    top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
    left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
    right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLOR_TABLE_BORDER },
  };

  const headerRow = new TableRow({
    children: normalizedHeader.map(
      (cell) =>
        new TableCell({
          width: { size: columnWidth, type: WidthType.DXA },
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: cell,
                  bold: true,
                  font: FONT,
                  size: SIZE_BODY,
                  color: COLOR_BODY,
                }),
              ],
            }),
          ],
        })
    ),
  });

  const bodyTableRows = normalizedRows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              width: { size: columnWidth, type: WidthType.DXA },
              children: [new Paragraph({ children: parseInline(cell) })],
            })
        ),
      })
  );

  return new Table({
    width: { size: TABLE_WIDTH_TWIPS, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths,
    borders,
    rows: [headerRow, ...bodyTableRows],
  });
}

// Max display width for embedded diagrams in pixels (at 96 DPI: 576px = 6 inches)
const MAX_DIAGRAM_WIDTH = 576;
const MAX_IMAGE_WIDTH = 576;
// Default scale for diagram rendering (currently affects PNG fallback only)
const DEFAULT_DIAGRAM_SCALE = 2;

const PNG_RENDER_BACKGROUNDS: Record<
  'light' | 'dark' | 'neutral' | 'forest' | 'ocean',
  string
> = {
  light: '#ffffff',
  neutral: '#ffffff',
  forest: '#ffffff',
  ocean: '#ffffff',
  dark: '#1e1b4b',
};

function parseWidthPx(raw?: string): number | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  const pxMatch = value.match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (pxMatch) {
    return Math.max(1, Math.round(Number(pxMatch[1])));
  }

  const percentMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
  if (percentMatch) {
    return Math.max(1, Math.round((Number(percentMatch[1]) / 100) * MAX_IMAGE_WIDTH));
  }

  return undefined;
}

function parseStandaloneImageReference(line: string): ImageReference | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const markdownMatch = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
  if (markdownMatch?.[1]) {
    return { src: markdownMatch[1] };
  }

  const htmlMatch = trimmed.match(/^<img\b([^>]*)\/?>$/i);
  if (!htmlMatch) {
    return null;
  }

  const attrs = htmlMatch[1] || '';
  const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  if (!srcMatch?.[1]) {
    return null;
  }

  const widthMatch = attrs.match(/\bwidth\s*=\s*["']([^"']*)["']/i);
  return {
    src: srcMatch[1],
    widthPx: parseWidthPx(widthMatch?.[1]),
  };
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const blockLength = buffer.readUInt16BE(offset + 2);
    if (blockLength < 2) {
      return null;
    }

    // SOF0/SOF2 hold width/height for baseline/progressive JPEG
    if (marker === 0xc0 || marker === 0xc2) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    offset += 2 + blockLength;
  }
  return null;
}

function mapMimeTypeToImageRunType(mimeType: string): ImageRunType | null {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return null;
  }
}

async function loadImageFromApiFilePath(src: string): Promise<LoadedImage | null> {
  const localMatch = src.match(/^\/api\/files\/local\?path=(.+)$/);
  if (localMatch?.[1]) {
    const filePath = decodeURIComponent(localMatch[1]);
    const data = await readFile(filePath);
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.png')) return { data, type: 'png', ...parsePngDimensions(data) };
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      return { data, type: 'jpg', ...(parseJpegDimensions(data) || {}) };
    }
    if (lower.endsWith('.gif')) return { data, type: 'gif' };
    if (lower.endsWith('.bmp')) return { data, type: 'bmp' };
    return null;
  }

  const idMatch = src.match(/^\/api\/files\/([0-9a-f-]{36})$/i);
  if (!idMatch?.[1] || !UUID_RE.test(idMatch[1])) {
    return null;
  }

  const files = await query<FileRecord>(
    'SELECT id, mime_type, path FROM files WHERE id = $1',
    [idMatch[1]]
  );
  if (files.length === 0) return null;
  const file = files[0];
  const type = mapMimeTypeToImageRunType(file.mime_type);
  if (!type) return null;

  const data = await readFile(file.path);
  if (type === 'png') return { data, type, ...parsePngDimensions(data) };
  if (type === 'jpg') return { data, type, ...(parseJpegDimensions(data) || {}) };
  return { data, type };
}

async function loadImage(src: string): Promise<LoadedImage | null> {
  if (src.startsWith('data:image/')) {
    const dataUrlMatch = src.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!dataUrlMatch?.[1] || !dataUrlMatch?.[2]) return null;
    const type = mapMimeTypeToImageRunType(dataUrlMatch[1]);
    if (!type) return null;
    const data = Buffer.from(dataUrlMatch[2], 'base64');
    if (type === 'png') return { data, type, ...parsePngDimensions(data) };
    if (type === 'jpg') return { data, type, ...(parseJpegDimensions(data) || {}) };
    return { data, type };
  }

  try {
    const parsedUrl = new URL(src, 'http://localhost');
    if (parsedUrl.pathname.startsWith('/api/files/')) {
      const apiPath = `${parsedUrl.pathname}${parsedUrl.search}`;
      return await loadImageFromApiFilePath(apiPath);
    }
  } catch {
    // Intentionally ignore malformed URLs; unsupported image references fall back to text.
  }

  return null;
}

async function renderImageReferenceToParagraph(
  imageRef: ImageReference
): Promise<Paragraph | null> {
  try {
    const loaded = await loadImage(imageRef.src);
    if (!loaded) return null;

    const naturalWidth = loaded.width;
    const naturalHeight = loaded.height;
    const requestedWidth = imageRef.widthPx;
    const finalWidth = Math.max(
      1,
      Math.min(MAX_IMAGE_WIDTH, requestedWidth ?? naturalWidth ?? MAX_IMAGE_WIDTH)
    );
    const finalHeight =
      naturalWidth && naturalHeight
        ? Math.max(1, Math.round((naturalHeight / naturalWidth) * finalWidth))
        : Math.max(1, Math.round(finalWidth * 0.6));

    return new Paragraph({
      children: [
        new ImageRun({
          type: loaded.type,
          data: loaded.data,
          transformation: {
            width: finalWidth,
            height: finalHeight,
          },
        }),
      ],
      spacing: { before: 120, after: 120 },
    });
  } catch (error) {
    log.warn({ err: error, imageRef }, 'Failed to embed image in DOCX');
    return null;
  }
}

const DIAGRAM_LANGUAGES = new Set<string>(['mermaid', 'plantuml', 'd2', 'graphviz']);

/**
 * Render a diagram code block to an ImageRun paragraph.
 * Supports mermaid, plantuml, d2, and graphviz via Kroki.
 * Returns null if rendering fails (caller should fall back to code block).
 */
async function renderDiagramToImageParagraph(
  diagramType: DiagramType,
  diagramCode: string,
  theme: 'light' | 'dark' | 'neutral' | 'forest' | 'ocean',
  diagramScale: number,
  pngRenderScale: number,
  pngRenderPlaywrightEnabled: boolean,
  pngDisplayScalePercent: number
): Promise<Paragraph | null> {
  try {
    const svg = await renderDiagram(diagramType, diagramCode, theme);
    const svgDimensions = parseSvgDimensions(svg);

    let pngBuffer: Buffer;
    if (pngRenderPlaywrightEnabled) {
      try {
        pngBuffer = await renderSvgToPngWithPlaywright(svg, {
          scale: pngRenderScale,
          background: PNG_RENDER_BACKGROUNDS[theme],
        });
      } catch (error) {
        log.warn({ err: error, diagramType }, 'Playwright PNG render failed, falling back to Kroki PNG');
        pngBuffer = await renderDiagramToPng(diagramType, diagramCode, theme, diagramScale);
      }
    } else {
      pngBuffer = await renderDiagramToPng(diagramType, diagramCode, theme, diagramScale);
    }

    const fallbackDimensions = parsePngDimensions(pngBuffer);
    const width = svgDimensions?.width ?? fallbackDimensions.width;
    const height = svgDimensions?.height ?? fallbackDimensions.height;
    const displayScale = Math.max(1, pngDisplayScalePercent) / 100;
    const scaledWidth = Math.max(1, Math.round(width * displayScale));
    const scaledHeight = Math.max(1, Math.round(height * displayScale));

    // Scale to max width while preserving aspect ratio
    let finalWidth = scaledWidth;
    let finalHeight = scaledHeight;
    if (scaledWidth > MAX_DIAGRAM_WIDTH) {
      const scale = MAX_DIAGRAM_WIDTH / scaledWidth;
      finalWidth = MAX_DIAGRAM_WIDTH;
      finalHeight = Math.round(scaledHeight * scale);
    }

    return new Paragraph({
      children: [
        new ImageRun({
          type: 'png',
          data: pngBuffer,
          transformation: {
            width: finalWidth,
            height: finalHeight,
          },
        }),
      ],
      spacing: { before: 200, after: 200 },
    });
  } catch (error) {
    // Return null to signal fallback to code block
    log.warn({ err: error, diagramType }, 'Failed to render diagram');
    return null;
  }
}

/**
 * Parse markdown content into an array of docx Paragraphs.
 * Renders diagrams (mermaid, plantuml, d2, graphviz) as embedded images when Kroki is available.
 */
export async function parseMarkdownContent(
  content: string,
  krokiAvailable: boolean,
  imageTheme: 'light' | 'dark' | 'neutral' | 'forest' | 'ocean',
  diagramScale: number,
  pngRenderScale: number,
  pngRenderPlaywrightEnabled: boolean,
  pngDisplayScalePercent: number
): Promise<(Paragraph | Table)[]> {
  const blocks: (Paragraph | Table)[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeBlockLang = '';
  const codeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Toggle code blocks
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        // End code block — check if it's a diagram language
        if (DIAGRAM_LANGUAGES.has(codeBlockLang) && krokiAvailable) {
          const diagramCode = codeLines.join('\n');
          const imageParagraph = await renderDiagramToImageParagraph(
            codeBlockLang as DiagramType,
            diagramCode,
            imageTheme,
            diagramScale,
            pngRenderScale,
            pngRenderPlaywrightEnabled,
            pngDisplayScalePercent
          );
          if (imageParagraph) {
            blocks.push(imageParagraph);
          } else {
            // Fallback to code block on render failure
            blocks.push(
              new Paragraph({
                children: buildCodeRuns(codeLines),
                shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_CODE_BG },
                indent: { left: convertInchesToTwip(0.15), right: convertInchesToTwip(0.15) },
                spacing: { before: 120, after: 120 },
              })
            );
          }
        } else {
          // Regular code block
          blocks.push(
            new Paragraph({
              children: buildCodeRuns(codeLines),
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_CODE_BG },
              indent: { left: convertInchesToTwip(0.15), right: convertInchesToTwip(0.15) },
              spacing: { before: 120, after: 120 },
            })
          );
        }
        codeLines.length = 0;
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        // Start code block — extract language
        const langMatch = line.trimStart().match(/^```(\w*)/);
        codeBlockLang = langMatch ? langMatch[1].toLowerCase() : '';
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Standalone images (markdown or HTML) are embedded as actual DOCX images.
    const imageRef = parseStandaloneImageReference(line);
    if (imageRef) {
      const imageParagraph = await renderImageReferenceToParagraph(imageRef);
      if (imageParagraph) {
        blocks.push(imageParagraph);
        continue;
      }
    }

    // Tables
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = normalizeTableRow(line);
      const bodyRows: string[][] = [];
      let cursor = i + 2;
      while (cursor < lines.length && isTableRow(lines[cursor])) {
        bodyRows.push(normalizeTableRow(lines[cursor]));
        cursor += 1;
      }

      blocks.push(buildTable(headerCells, bodyRows));
      i = cursor - 1;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      blocks.push(new Paragraph({ children: [] }));
      continue;
    }

    // Horizontal rule (exactly "---") — skip silently
    if (line.trim() === '---') {
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        new Paragraph({
          heading: headingLevels[level] || HeadingLevel.HEADING_6,
          spacing: { before: level <= 2 ? 240 : 160, after: 80 },
          children: [new TextRun({
            text: headingMatch[2],
            bold: true,
            font: FONT,
            size: SIZE_HEADING,
            color: COLOR_HEADING,
          })],
        })
      );
      continue;
    }

    // Bullet list items
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      blocks.push(
        new Paragraph({
          bullet: { level: 0 },
          children: parseInline(bulletMatch[2]),
        })
      );
      continue;
    }

    // Numbered list items
    const numberedMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (numberedMatch) {
      blocks.push(
        new Paragraph({
          numbering: { reference: 'default-numbering', level: 0 },
          children: parseInline(numberedMatch[2]),
        })
      );
      continue;
    }

    // Regular paragraph
    blocks.push(
      new Paragraph({
        children: parseInline(line),
      })
    );
  }

  // Flush any remaining code block
  if (codeLines.length > 0) {
    blocks.push(
      new Paragraph({
        children: buildCodeRuns(codeLines),
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR_CODE_BG },
        indent: { left: convertInchesToTwip(0.15), right: convertInchesToTwip(0.15) },
        spacing: { before: 120, after: 120 },
      })
    );
  }

  return blocks;
}

export async function memoryToDocx(data: MemoryExportData): Promise<Buffer> {
  // Check if Kroki is available for diagram rendering
  const krokiAvailable = await isKrokiAvailable();
  const imageTheme = data.export_image_theme ?? 'dark';
  const diagramScale = data.export_diagram_scale ?? DEFAULT_DIAGRAM_SCALE;
  const pngRenderScale = data.export_png_render_scale ?? diagramScale;
  const pngRenderPlaywrightEnabled =
    (process.env.PNG_RENDERING_ENABLED || '').toLowerCase() !== 'false';
  const pngDisplayScalePercent = data.export_png_display_scale_percent ?? 100;
  logDebug(`DOCX export settings: kroki=${krokiAvailable} pngRenderPlaywrightEnabled=${pngRenderPlaywrightEnabled} pngRenderScale=${pngRenderScale} pngDisplayScalePercent=${pngDisplayScalePercent} theme=${imageTheme} playwrightPath=${process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ''}`);

  // Content paragraphs (async to handle diagram rendering)
  const contentParagraphs = await parseMarkdownContent(
    data.content,
    krokiAvailable,
    imageTheme,
    diagramScale,
    pngRenderScale,
    pngRenderPlaywrightEnabled,
    pngDisplayScalePercent
  );

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: SIZE_BODY,
            color: COLOR_BODY,
          },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: {
                run: { font: FONT, size: SIZE_BODY, color: COLOR_BODY },
                paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: contentParagraphs,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
