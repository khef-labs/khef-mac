import { useSettings } from './useSettings'
import type { DiagramTheme, DiagramScale, ImageQuality } from '../../lib/exportPreferences'
import styles from './SettingsShared.module.css'

export function ExportSection() {
  const { settings, loading, save } = useSettings()

  if (loading || !settings) return <></>

  const imageTheme = settings.export.imageTheme as DiagramTheme
  const diagramScale = settings.export.diagramScale as DiagramScale
  const highQualityRendering = settings.export.highQualityRendering
  const imageQuality = settings.export.pngRenderScale as ImageQuality
  const displaySize = settings.export.pngDisplayScalePercent

  const saveExport = (partial: Partial<typeof settings.export>) => {
    save({ export: { ...settings.export, ...partial } })
  }

  return (
    <div class={styles.section}>
      <div class={styles.field}>
        <label class={styles.label} htmlFor="diagramTheme">Diagram Theme</label>
        <select
          id="diagramTheme"
          class={styles.input}
          value={imageTheme}
          onChange={(e) => saveExport({ imageTheme: (e.target as HTMLSelectElement).value })}
        >
          <option value="neutral">Neutral</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="forest">Forest</option>
          <option value="ocean">Ocean</option>
        </select>
        <p class={styles.description}>
          Theme for Mermaid diagrams when exporting memories to DOCX.
          Per-memory settings override this global preference.
        </p>
      </div>
      <div class={styles.field}>
        <label class={styles.label} htmlFor="highQualityRendering">
          High-Quality Rendering
        </label>
        <div class={styles.toggleRow}>
          <button
            id="highQualityRendering"
            type="button"
            class={`${styles.toggle} ${highQualityRendering ? styles.toggleOn : ''}`}
            onClick={() => saveExport({ highQualityRendering: !highQualityRendering })}
            role="switch"
            aria-checked={highQualityRendering}
          >
            <span class={styles.toggleSlider} />
          </button>
          <span class={styles.toggleLabel}>{highQualityRendering ? 'Enabled' : 'Disabled'}</span>
        </div>
        <p class={styles.description}>
          Use browser-based rendering for sharper diagram images in DOCX exports.
          When disabled, falls back to legacy server-side rendering.
        </p>
      </div>
      {highQualityRendering ? (
        <>
          <div class={styles.field}>
            <label class={styles.label} htmlFor="imageQuality">Image Quality</label>
            <select
              id="imageQuality"
              class={styles.input}
              value={imageQuality}
              onChange={(e) => saveExport({ pngRenderScale: Number((e.target as HTMLSelectElement).value) })}
            >
              <option value="1">Standard</option>
              <option value="2">High</option>
              <option value="3">Very High</option>
              <option value="4">Maximum</option>
            </select>
            <p class={styles.description}>
              Pixel density for diagram images. Higher quality produces sharper images but larger files.
            </p>
          </div>
          <div class={styles.field}>
            <label class={styles.label} htmlFor="displaySize">Display Size</label>
            <div class={styles.rangeRow}>
              <input
                id="displaySize"
                type="range"
                class={styles.range}
                min="10"
                max="300"
                step="10"
                value={displaySize}
                onInput={(e) => saveExport({ pngDisplayScalePercent: Math.max(10, Math.min(300, Number((e.target as HTMLInputElement).value))) })}
              />
              <span class={styles.rangeValue}>{displaySize}%</span>
            </div>
            <p class={styles.description}>
              Scale diagrams in exported documents. 100% uses the original size.
            </p>
          </div>
        </>
      ) : (
        <div class={styles.field}>
          <label class={styles.label} htmlFor="diagramScale">Legacy Image Scale</label>
          <select
            id="diagramScale"
            class={styles.input}
            value={diagramScale}
            onChange={(e) => saveExport({ diagramScale: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value="1">1x (smaller files)</option>
            <option value="2">2x (balanced)</option>
            <option value="3">3x (sharper)</option>
            <option value="4">4x (maximum quality)</option>
          </select>
          <p class={styles.description}>
            Resolution multiplier for diagram images when using legacy server-side rendering.
          </p>
        </div>
      )}
    </div>
  )
}
