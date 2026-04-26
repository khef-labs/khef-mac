/**
 * Export preferences — delegates to the backend-backed settings system.
 *
 * Types are defined here for convenience; values come from getSettings().export.
 */

import { getSettings } from './settings'

export type DiagramTheme = 'dark' | 'light' | 'neutral' | 'forest' | 'ocean'
export type DiagramScale = 1 | 2 | 3 | 4
export type ImageQuality = 1 | 2 | 3 | 4

export interface ExportPreferences {
  diagramTheme: DiagramTheme
  diagramScale: DiagramScale
  highQualityRendering: boolean
  imageQuality: ImageQuality
  displaySize: number // 10-300 percent
}

export function getExportPreferences(): ExportPreferences {
  const { export: exp } = getSettings()
  return {
    diagramTheme: exp.imageTheme as DiagramTheme,
    diagramScale: exp.diagramScale as DiagramScale,
    highQualityRendering: exp.highQualityRendering,
    imageQuality: exp.pngRenderScale as ImageQuality,
    displaySize: exp.pngDisplayScalePercent,
  }
}

export function getDiagramTheme(): DiagramTheme {
  return getSettings().export.imageTheme as DiagramTheme
}

export function getDiagramScale(): DiagramScale {
  return getSettings().export.diagramScale as DiagramScale
}

export function getHighQualityRendering(): boolean {
  return getSettings().export.highQualityRendering
}

export function getImageQuality(): ImageQuality {
  return getSettings().export.pngRenderScale as ImageQuality
}

export function getDisplaySize(): number {
  return getSettings().export.pngDisplayScalePercent
}
