/**
 * Memory-to-Markdown export service.
 * Returns the memory content as-is (no metadata wrapper).
 */

export interface MemoryExportData {
  id: string;
  handle: string;
  title: string;
  content: string;
  type: string;
  status: string;
  project_name: string;
  project_handle: string;
  tags: string[];
  export_image_theme?: 'light' | 'dark' | 'neutral' | 'forest' | 'ocean';
  export_diagram_scale?: number;
  export_png_render_scale?: number;
  export_png_display_scale_percent?: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export function memoryToMarkdown(data: MemoryExportData): string {
  return data.content;
}
