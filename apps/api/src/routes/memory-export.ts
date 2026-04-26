import { FastifyPluginAsync } from 'fastify';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../db/client';
import { Memory, TagRef } from '../types';
import { memoryToMarkdown, MemoryExportData } from '../services/memory-to-markdown';
import { markdownToSlack } from '../services/markdown-to-slack';
import { memoryToDocx } from '../services/markdown-to-docx';
import { csvToXlsx, xlsxToCsv } from '../services/csv-to-xlsx';
import {
  resolveExportImageTheme,
  resolveExportDiagramScale,
  resolveExportPngRenderScale,
  resolveExportPngDisplayScalePercent,
} from '../services/export-image-theme';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Format current time as MM-DD-YYYY-HH-MM for export filenames. */
function exportTimestamp(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${mm}-${dd}-${yyyy}-${hh}-${min}`;
}
const VALID_FORMATS = ['markdown', 'docx', 'slack', 'csv', 'xlsx', 'html'] as const;
type ExportFormat = (typeof VALID_FORMATS)[number];

/** Build MemoryExportData for a given memory ID. Returns null if not found. */
async function buildExportData(memoryId: string): Promise<MemoryExportData | null> {
  const rows = await query<
    Memory & {
      type: string;
      parent_type?: string;
      status: string;
      project_handle: string;
      project_name: string;
    }
  >(
    `SELECT m.id, m.project_id, m.handle, m.title, m.content, m.memory_type_id, m.status_id,
            m.status_updated_at, m.created_at, m.updated_at,
            mt.name as type, mt_parent.name as parent_type,
            mts.status_value as status,
            p.handle as project_handle, p.display_name as project_name
     FROM memories m
     INNER JOIN memory_types mt ON m.memory_type_id = mt.id
     LEFT JOIN memory_types mt_parent ON mt.parent_id = mt_parent.id
     INNER JOIN projects p ON m.project_id = p.id
     LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
     WHERE m.id = $1`,
    [memoryId]
  );

  if (rows.length === 0) return null;
  const memory = rows[0];

  const tagRows = await query<TagRef>(
    `SELECT t.id, t.name FROM tags t
     JOIN memory_tags mt ON t.id = mt.tag_id
     WHERE mt.memory_id = $1`,
    [memoryId]
  );

  const settingsRows = await query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('export.imageTheme', 'export.diagramScale', 'export.pngRenderScale', 'export.pngDisplayScalePercent')"
  );
  const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]));

  const metadataRows = await query<{ field: string; value: string }>(
    `SELECT md.field, mm.value
     FROM memory_metadata mm
     JOIN metadata md ON mm.metadata_id = md.id
     WHERE mm.memory_id = $1
       AND md.entity_type = 'memory'
       AND md.field IN ('export-image-theme', 'export-diagram-scale', 'export-png-render-scale', 'export-png-display-scale-percent')`,
    [memoryId]
  );
  const metadataMap = new Map(metadataRows.map((r) => [r.field, r.value]));

  return {
    id: memory.id,
    handle: memory.handle,
    title: memory.title,
    content: memory.content,
    type: memory.type,
    status: memory.status || 'unknown',
    project_name: memory.project_name,
    project_handle: memory.project_handle,
    tags: tagRows.map((t) => t.name),
    export_image_theme: resolveExportImageTheme({
      memoryMetadata: metadataMap.get('export-image-theme'),
      globalSetting: settingsMap.get('export.imageTheme'),
    }),
    export_diagram_scale: resolveExportDiagramScale({
      memoryMetadata: metadataMap.get('export-diagram-scale'),
      globalSetting: settingsMap.get('export.diagramScale'),
    }),
    export_png_render_scale: resolveExportPngRenderScale({
      memoryMetadata: metadataMap.get('export-png-render-scale'),
      globalSetting: settingsMap.get('export.pngRenderScale'),
      legacyMetadata: metadataMap.get('export-diagram-scale'),
      legacySetting: settingsMap.get('export.diagramScale'),
    }),
    export_png_display_scale_percent: resolveExportPngDisplayScalePercent({
      memoryMetadata: metadataMap.get('export-png-display-scale-percent'),
      globalSetting: settingsMap.get('export.pngDisplayScalePercent'),
    }),
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  };
}

/** Convert a string to kebab-case suitable for filenames. */
function toKebabFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const memoryExportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/:memoryId/export', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { format } = request.query as { format?: string };

    if (!UUID_RE.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    if (!format || !VALID_FORMATS.includes(format as ExportFormat)) {
      return reply.code(400).send({
        error: `format query parameter required. Must be one of: ${VALID_FORMATS.join(', ')}`,
      });
    }

    const exportData = await buildExportData(memoryId);
    if (!exportData) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const ts = exportTimestamp();
    const base = `${exportData.handle}-${ts}`;

    switch (format as ExportFormat) {
      case 'markdown': {
        const md = memoryToMarkdown(exportData);
        return reply
          .header('Content-Type', 'text/markdown; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${base}.md"`)
          .send(md);
      }
      case 'docx': {
        const buffer = await memoryToDocx(exportData);
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          )
          .header('Content-Disposition', `attachment; filename="${base}.docx"`)
          .header('X-Download-Options', 'noopen')
          .send(buffer);
      }
      case 'slack': {
        const md = memoryToMarkdown(exportData);
        const slackText = markdownToSlack(md);
        return reply.header('Content-Type', 'text/plain; charset=utf-8').send(slackText);
      }
      case 'csv': {
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${base}.csv"`)
          .send(exportData.content);
      }
      case 'xlsx': {
        const xlsxBuffer = await csvToXlsx(exportData.content, {
          title: exportData.title,
          sheetName: exportData.title?.substring(0, 31) || 'Sheet1',
        });
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header('Content-Disposition', `attachment; filename="${base}.xlsx"`)
          .header('X-Download-Options', 'noopen')
          .send(xlsxBuffer);
      }
      case 'html': {
        return reply
          .header('Content-Type', 'text/html; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${base}.html"`)
          .send(exportData.content);
      }
    }
  });

  fastify.post('/:memoryId/save-to-drive', async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const { subfolder, format: rawFormat } = request.query as {
      subfolder?: string;
      format?: string;
    };

    if (!UUID_RE.test(memoryId)) {
      return reply.code(400).send({ error: 'memoryId must be a UUID' });
    }

    const DRIVE_FORMATS = ['markdown', 'docx', 'csv', 'xlsx', 'html'] as const;
    type DriveFormat = (typeof DRIVE_FORMATS)[number];
    const format: DriveFormat = DRIVE_FORMATS.includes(rawFormat as DriveFormat)
      ? (rawFormat as DriveFormat)
      : 'markdown';

    if (rawFormat && !DRIVE_FORMATS.includes(rawFormat as DriveFormat)) {
      return reply.code(400).send({
        error: `Invalid format. Must be one of: ${DRIVE_FORMATS.join(', ')}`,
      });
    }

    // Check per-memory drive-export-folder metadata first, fall back to global setting
    const metaRows = await query<{ value: string }>(
      `SELECT mm.value FROM memory_metadata mm
       JOIN metadata md ON mm.metadata_id = md.id
       WHERE mm.memory_id = $1 AND md.entity_type = 'memory' AND md.field = 'drive-export-folder'`,
      [memoryId]
    );
    let driveFolder = metaRows.length > 0 && metaRows[0].value ? metaRows[0].value : '';

    if (!driveFolder) {
      const settingRows = await query<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'drive.syncFolder'"
      );
      driveFolder = settingRows.length > 0 ? settingRows[0].value : '';
    }

    if (!driveFolder) {
      return reply.code(400).send({ error: 'drive.syncFolder not configured' });
    }

    // Ensure the folder exists (create if needed)
    await mkdir(driveFolder, { recursive: true });

    const exportData = await buildExportData(memoryId);
    if (!exportData) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    const baseName = `${toKebabFilename(exportData.handle || exportData.title)}-${exportTimestamp()}`;
    let fileContent: Buffer | string;
    let filename: string;

    if (format === 'docx') {
      fileContent = await memoryToDocx(exportData);
      filename = `${baseName}.docx`;
    } else if (format === 'csv') {
      fileContent = exportData.content;
      filename = `${baseName}.csv`;
    } else if (format === 'xlsx') {
      fileContent = await csvToXlsx(exportData.content, {
        title: exportData.title,
        sheetName: exportData.title?.substring(0, 31) || 'Sheet1',
      });
      filename = `${baseName}.xlsx`;
    } else if (format === 'html') {
      fileContent = exportData.content;
      filename = `${baseName}.html`;
    } else {
      fileContent = memoryToMarkdown(exportData);
      filename = `${baseName}.md`;
    }

    // Build target directory, optionally with subfolder
    let targetDir = driveFolder;
    if (subfolder) {
      // Prevent path traversal
      const cleaned = subfolder.replace(/\.\./g, '').replace(/^\/+/, '');
      if (!cleaned) {
        return reply.code(400).send({ error: 'Invalid subfolder' });
      }
      targetDir = join(driveFolder, cleaned);
      await mkdir(targetDir, { recursive: true });
    }

    const filePath = join(targetDir, filename);
    await writeFile(filePath, fileContent);

    return reply.send({ path: filePath, filename });
  });

  // Convert XLSX to CSV (accepts base64-encoded XLSX in JSON body)
  fastify.post('/convert/xlsx-to-csv', async (request, reply) => {
    const { data } = request.body as { data?: string };
    if (!data) {
      return reply.code(400).send({ error: 'Request body must contain "data" field with base64-encoded XLSX' });
    }

    try {
      const buffer = Buffer.from(data, 'base64');
      const csv = await xlsxToCsv(buffer);
      return reply.send({ csv });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'Failed to parse XLSX file' });
    }
  });
};

export default memoryExportRoutes;
