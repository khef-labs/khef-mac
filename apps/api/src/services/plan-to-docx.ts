/**
 * Plan-to-DOCX conversion service.
 * Simplified version of memoryToDocx for plan exports.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
  convertInchesToTwip,
} from 'docx';
import { parseMarkdownContent } from './markdown-to-docx';
import { isKrokiAvailable } from './diagram';

const FONT = 'Arial';
const SIZE_BODY = 22; // 11pt (half-points)
const COLOR_BODY = '333333';

export interface PlanExportData {
  title: string;
  content: string;
  status: string;
  project_name?: string;
  created_at: Date;
  updated_at: Date;
}

export async function planToDocx(data: PlanExportData): Promise<Buffer> {
  // Check if Kroki is available for diagram rendering
  const krokiAvailable = await isKrokiAvailable();
  const imageTheme = 'dark' as const;
  const diagramScale = 2;
  const pngRenderScale = 2;
  const pngRenderPlaywrightEnabled =
    (process.env.PNG_RENDERING_ENABLED || '').toLowerCase() !== 'false';
  const pngDisplayScalePercent = 100;

  // Content paragraphs (async to handle mermaid rendering)
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
