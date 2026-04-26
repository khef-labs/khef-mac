import type { DiagramTheme } from './diagram';

// Theme validation
const VALID_THEMES: DiagramTheme[] = ['dark', 'light', 'neutral', 'forest', 'ocean'];

export function normalizeExportImageTheme(
  value: string | null | undefined
): DiagramTheme | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (VALID_THEMES.includes(normalized as DiagramTheme)) {
    return normalized as DiagramTheme;
  }

  return null;
}

export function getValidThemes(): DiagramTheme[] {
  return [...VALID_THEMES];
}

export function resolveExportImageTheme(options: {
  memoryMetadata?: string | null;
  globalSetting?: string | null;
  fallback?: DiagramTheme;
}): DiagramTheme {
  const { memoryMetadata, globalSetting, fallback = 'light' } = options;

  return (
    normalizeExportImageTheme(memoryMetadata) ||
    normalizeExportImageTheme(globalSetting) ||
    fallback
  );
}

// Scale validation
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DEFAULT_SCALE = 2;
const MIN_PERCENT = 10;
const MAX_PERCENT = 300;
const DEFAULT_PERCENT = 100;

export function normalizeExportDiagramScale(
  value: string | null | undefined
): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed) || parsed < MIN_SCALE || parsed > MAX_SCALE) {
    return null;
  }

  return parsed;
}

export function resolveExportDiagramScale(options: {
  memoryMetadata?: string | null;
  globalSetting?: string | null;
  fallback?: number;
}): number {
  const { memoryMetadata, globalSetting, fallback = DEFAULT_SCALE } = options;

  return (
    normalizeExportDiagramScale(memoryMetadata) ||
    normalizeExportDiagramScale(globalSetting) ||
    fallback
  );
}

export function normalizeExportPngRenderScale(
  value: string | null | undefined
): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed) || parsed < MIN_SCALE || parsed > MAX_SCALE) {
    return null;
  }

  return parsed;
}

export function resolveExportPngRenderScale(options: {
  memoryMetadata?: string | null;
  globalSetting?: string | null;
  legacyMetadata?: string | null;
  legacySetting?: string | null;
  fallback?: number;
}): number {
  const {
    memoryMetadata,
    globalSetting,
    legacyMetadata,
    legacySetting,
    fallback = DEFAULT_SCALE,
  } = options;

  return (
    normalizeExportPngRenderScale(memoryMetadata) ||
    normalizeExportPngRenderScale(globalSetting) ||
    normalizeExportDiagramScale(legacyMetadata) ||
    normalizeExportDiagramScale(legacySetting) ||
    fallback
  );
}


export function normalizeExportPngDisplayScalePercent(
  value: string | null | undefined
): number | null {
  if (!value) {
    return null;
  }

  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed) || parsed < MIN_PERCENT || parsed > MAX_PERCENT) {
    return null;
  }

  return parsed;
}

export function resolveExportPngDisplayScalePercent(options: {
  memoryMetadata?: string | null;
  globalSetting?: string | null;
  fallback?: number;
}): number {
  const { memoryMetadata, globalSetting, fallback = DEFAULT_PERCENT } = options;

  return (
    normalizeExportPngDisplayScalePercent(memoryMetadata) ||
    normalizeExportPngDisplayScalePercent(globalSetting) ||
    fallback
  );
}
