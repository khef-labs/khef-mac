import { useState, useCallback, useRef, useMemo } from 'preact/hooks'
import type { RefObject } from 'preact'
import {
  updateMemory,
  uploadFile,
  exportMemory,
  saveMemoryToDrive,
  convertXlsxToCsv,
  deleteMemory,
  setMemoryMetadataField,
  deleteMemoryMetadataField,
} from '../../lib/api'
import {
  getDiagramTheme,
  getDiagramScale,
  getHighQualityRendering,
  getImageQuality,
  getDisplaySize,
  type DiagramTheme,
  type DiagramScale,
  type ImageQuality,
} from '../../lib/exportPreferences'
import { exportTimestamp } from '../../lib/format'
import { getSettings } from '../../lib/settings'
import { getExternalSource, isGoogleDocType } from './lib'
import type { Memory, Project } from '../../types'
import type { HeadingPosition } from './lib'

interface UseMemoryContentEditorOptions {
  memory: Memory | null
  project: Project | null
  isEditingContent: boolean
  setIsEditingContent: (v: boolean) => void
  editContent: string
  setEditContent: (v: string | ((prev: string) => string)) => void
  setContentMode: (v: 'edit' | 'preview') => void
  contentRef: RefObject<HTMLDivElement>
  headingPositions: HeadingPosition[]
  editorTopLine: number
  pendingScrollSlugRef: { current: string | null }
  setError: (e: string | null) => void
  setMemory: (m: Memory | ((prev: Memory | null) => Memory | null)) => void
  setLocation: (path: string) => void
  showToast: (msg: string) => void
  setMetaIsSaving: (v: boolean) => void
}

export function useMemoryContentEditor({
  memory,
  project,
  isEditingContent,
  setIsEditingContent,
  editContent,
  setEditContent,
  setContentMode,
  contentRef,
  headingPositions,
  editorTopLine,
  pendingScrollSlugRef,
  setError,
  setMemory,
  setLocation,
  showToast,
  setMetaIsSaving,
}: UseMemoryContentEditorOptions) {
  const [isUploading, setIsUploading] = useState(false)
  const [copiedId, setCopiedId] = useState(false)
  const [copiedContent, setCopiedContent] = useState(false)
  const [copiedSlack, setCopiedSlack] = useState(false)
  const [copiedMarkdown, setCopiedMarkdown] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoFileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const insertAsHtmlRef = useRef(false)

  const contentEditingDisabledReason = useMemo(() => {
    if (!memory) return null
    if (memory.metadata?.['seed-path']) return 'Seeded memory — edit the seed file'
    if (isGoogleDocType(memory) && !!getExternalSource(memory.metadata)) return 'Editing disabled - content synced from Google Doc'
    return null
  }, [memory?.metadata, memory?.type, memory?.parent_type])

  const isContentEditingDisabled = contentEditingDisabledReason !== null

  const isContentDirty = useMemo(() => {
    if (!isEditingContent || !memory) return false
    return editContent !== memory.content
  }, [isEditingContent, memory, editContent])

  const startEditingContent = useCallback(() => {
    if (memory && !isContentEditingDisabled) {
      const scrollY = window.scrollY
      const containerScrollTop = contentRef.current?.scrollTop ?? 0
      setEditContent(memory.content)
      setContentMode('edit')
      setIsEditingContent(true)
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY)
        if (contentRef.current) {
          contentRef.current.scrollTop = containerScrollTop
        }
      })
    }
  }, [memory, isContentEditingDisabled])

  const cancelEditingContent = useCallback(() => {
    if (memory) {
      setEditContent(memory.content)
    }
    let nearestSlug: string | null = null
    for (const h of headingPositions) {
      if (h.line <= editorTopLine) nearestSlug = h.slug
      else break
    }
    pendingScrollSlugRef.current = nearestSlug
    setContentMode('edit')
    setIsEditingContent(false)
  }, [memory, headingPositions, editorTopLine])

  const saveContent = useCallback(async () => {
    if (!memory) return
    const projectId = project?.id || memory.project_id
    if (!projectId) {
      setError('Missing project ID for update')
      return
    }

    setMetaIsSaving(true)
    try {
      const updated = await updateMemory(projectId, memory.id, {
        content: editContent,
      })
      let nearestSlug: string | null = null
      for (const h of headingPositions) {
        if (h.line <= editorTopLine) nearestSlug = h.slug
        else break
      }
      pendingScrollSlugRef.current = nearestSlug
      setMemory({ ...memory, ...updated, content: editContent } as any)
      setIsEditingContent(false)
    } catch (err: any) {
      setError(err.message || 'Failed to save content')
    } finally {
      setMetaIsSaving(false)
    }
  }, [memory, project, editContent, headingPositions, editorTopLine])

  const copyMemoryId = useCallback(async () => {
    if (!memory) return
    try {
      await navigator.clipboard.writeText(memory.id)
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = memory.id
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 2000)
    }
  }, [memory])

  const copyContent = useCallback(async () => {
    if (!memory) return
    try {
      await navigator.clipboard.writeText(memory.content)
      setCopiedContent(true)
      setTimeout(() => setCopiedContent(false), 2000)
    } catch (err) {
      console.error('Failed to copy content:', err)
    }
  }, [memory])

  const handleCopyMarkdown = useCallback(async () => {
    if (!memory) return
    try {
      const result = await exportMemory(memory.id, 'markdown')
      if ('text' in result) {
        await navigator.clipboard.writeText(result.text)
        setCopiedMarkdown(true)
        setTimeout(() => setCopiedMarkdown(false), 2000)
      }
    } catch (err) {
      console.error('Markdown copy failed:', err)
    }
  }, [memory])

  const handleTogglePin = useCallback(async () => {
    if (!memory) return
    try {
      if (memory.is_pinned) {
        await deleteMemoryMetadataField(memory.id, 'is-pinned')
      } else {
        await setMemoryMetadataField(memory.id, 'is-pinned', 'true')
      }
      setMemory({ ...memory, is_pinned: !memory.is_pinned } as any)
      showToast(memory.is_pinned ? 'Unpinned' : 'Pinned')
    } catch (err: any) {
      showToast(err.message || 'Failed to update pin')
    }
  }, [memory])

  const handleExportMarkdown = useCallback(async () => {
    if (!memory) return
    try {
      const result = await exportMemory(memory.id, 'markdown')
      if ('text' in result) {
        const blob = new Blob([result.text], { type: 'text/markdown' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${memory.handle}-${exportTimestamp()}.md`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('Markdown export failed:', err)
    }
  }, [memory])

  const handleExportDocx = useCallback(async () => {
    if (!memory) return
    try {
      const diagramTheme = (memory.metadata?.['export-image-theme'] as DiagramTheme) || getDiagramTheme()
      const scaleStr = memory.metadata?.['export-diagram-scale']
      const diagramScale = scaleStr ? (Number(scaleStr) as DiagramScale) : getDiagramScale()
      const qualityStr = memory.metadata?.['export-png-render-scale']
      const imageQuality = qualityStr ? (Number(qualityStr) as ImageQuality) : (getHighQualityRendering() ? getImageQuality() : undefined)
      const displayStr = memory.metadata?.['export-png-display-scale-percent']
      const displaySize = displayStr ? Number(displayStr) : (getHighQualityRendering() ? getDisplaySize() : undefined)
      const result = await exportMemory(memory.id, 'docx', { diagramTheme, diagramScale, imageQuality, displaySize })
      if ('blob' in result) {
        const url = URL.createObjectURL(result.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${memory.handle}-${exportTimestamp()}.docx`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('DOCX export failed:', err)
    }
  }, [memory])

  const handleExportCsv = useCallback(async () => {
    if (!memory) return
    try {
      const result = await exportMemory(memory.id, 'csv')
      if ('text' in result) {
        const blob = new Blob([result.text], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${memory.handle}-${exportTimestamp()}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('CSV export failed:', err)
    }
  }, [memory])

  const handleExportXlsx = useCallback(async () => {
    if (!memory) return
    try {
      const result = await exportMemory(memory.id, 'xlsx')
      if ('blob' in result) {
        const url = URL.createObjectURL(result.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${memory.handle}-${exportTimestamp()}.xlsx`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('XLSX export failed:', err)
    }
  }, [memory])

  const handleExportHtml = useCallback(async () => {
    if (!memory) return
    try {
      const result = await exportMemory(memory.id, 'html')
      if ('text' in result) {
        const blob = new Blob([result.text], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${memory.handle}-${exportTimestamp()}.html`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('HTML export failed:', err)
    }
  }, [memory])

  const handleSaveToDrive = useCallback(async (format: 'markdown' | 'docx' | 'csv' | 'xlsx' | 'html') => {
    if (!memory) return
    const driveFolder = getSettings().drive.syncFolder
    if (!driveFolder) {
      showToast('Configure a Google Drive folder in Settings first')
      return
    }
    try {
      const diagramTheme = (memory.metadata?.['export-image-theme'] as DiagramTheme) || getDiagramTheme()
      const scaleStr = memory.metadata?.['export-diagram-scale']
      const diagramScale = scaleStr ? (Number(scaleStr) as DiagramScale) : getDiagramScale()
      const qualityStr = memory.metadata?.['export-png-render-scale']
      const imageQuality = qualityStr ? (Number(qualityStr) as ImageQuality) : (getHighQualityRendering() ? getImageQuality() : undefined)
      const displayStr = memory.metadata?.['export-png-display-scale-percent']
      const displaySize = displayStr ? Number(displayStr) : (getHighQualityRendering() ? getDisplaySize() : undefined)
      const result = await saveMemoryToDrive(memory.id, format, { diagramTheme, diagramScale, imageQuality, displaySize })
      showToast(`Saved to ${result.filename}`)
    } catch (err: any) {
      showToast(err.message || 'Failed to save to Drive')
      console.error('Save to Drive failed:', err)
    }
  }, [memory])

  const handleExportSlack = useCallback(async () => {
    if (!memory) return
    try {
      const result = await exportMemory(memory.id, 'slack')
      if ('text' in result) {
        await navigator.clipboard.writeText(result.text)
        setCopiedSlack(true)
        setTimeout(() => setCopiedSlack(false), 2000)
      }
    } catch (err) {
      console.error('Slack export failed:', err)
    }
  }, [memory])

  const exportAsPng = useCallback(async (svgString?: string) => {
    if (!memory) return

    let svgElement: SVGSVGElement | null = null
    let svgSource: string | null = null

    if (svgString) {
      svgSource = svgString
      const parser = new DOMParser()
      const doc = parser.parseFromString(svgString, 'image/svg+xml')
      svgElement = doc.querySelector('svg')
    } else if (contentRef.current) {
      svgElement = contentRef.current.querySelector('svg')
      if (svgElement) {
        const serializer = new XMLSerializer()
        svgSource = serializer.serializeToString(svgElement)
      }
    }

    if (!svgElement || !svgSource) {
      setError('No diagram found to export')
      return
    }

    try {
      const bbox = svgElement.getBoundingClientRect()
      const width = bbox.width || parseFloat(svgElement.getAttribute('width') || '800')
      const height = bbox.height || parseFloat(svgElement.getAttribute('height') || '600')
      const scale = 2

      let finalSvg = svgSource
      if (!finalSvg.includes('xmlns=')) {
        finalSvg = finalSvg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
      }

      finalSvg = finalSvg.replace(/@font-face\s*\{[^}]*\}/gi, '')
      finalSvg = finalSvg.replace(/url\s*\(\s*['"]?https?:\/\/[^)]+\)/gi, 'url()')
      finalSvg = finalSvg.replace(/font-family:\s*["']?[^;"']+["']?/gi, 'font-family: system-ui, -apple-system, sans-serif')
      finalSvg = finalSvg.replace(/<br\s*>/gi, '<br/>')
      finalSvg = finalSvg.replace(/<hr\s*>/gi, '<hr/>')

      const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(finalSvg)))

      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = width * scale
        canvas.height = height * scale
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          setError('Failed to create canvas context')
          return
        }

        ctx.fillStyle = '#161b22'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.scale(scale, scale)
        ctx.drawImage(img, 0, 0)

        canvas.toBlob((blob) => {
          if (!blob) {
            setError('Failed to create PNG blob')
            return
          }
          const pngUrl = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = pngUrl
          a.download = `${memory.handle}.png`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(pngUrl)
        }, 'image/png')
      }
      img.onerror = () => {
        const svgBlob = new Blob([finalSvg], { type: 'image/svg+xml' })
        const svgUrl = URL.createObjectURL(svgBlob)
        const a = document.createElement('a')
        a.href = svgUrl
        a.download = `${memory.handle}.svg`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(svgUrl)
      }
      img.src = svgDataUrl
    } catch (err: any) {
      setError(err.message || 'Failed to export PNG')
    }
  }, [memory])

  const handleFileUpload = useCallback(async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    const projectId = project?.id || memory?.project_id
    if (!projectId) {
      setError('No project ID for upload')
      return
    }

    const isCsvFile = file.name.endsWith('.csv') || file.type === 'text/csv'
    const isXlsxFile = file.name.endsWith('.xlsx') || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

    if ((isCsvFile || isXlsxFile) && memory?.type === 'csv') {
      setIsUploading(true)
      try {
        let csvContent: string
        if (isCsvFile) {
          csvContent = await file.text()
        } else {
          const buffer = await file.arrayBuffer()
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
          csvContent = await convertXlsxToCsv(base64)
        }
        setEditContent(csvContent)
      } catch (err: any) {
        setError(err.message || 'Failed to import file')
      } finally {
        setIsUploading(false)
        input.value = ''
      }
      return
    }

    setIsUploading(true)
    try {
      const response = await uploadFile(projectId, file)
      const isImage = response.mime_type.startsWith('image/')
      let markup: string
      if (insertAsHtmlRef.current && isImage) {
        markup = `<img src="${response.url}" width="" />`
      } else {
        markup = isImage
          ? `![${file.name}](${response.url})`
          : `[${file.name}](${response.url})`
      }
      insertAsHtmlRef.current = false

      if (textareaRef.current) {
        const textarea = textareaRef.current
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const before = editContent.substring(0, start)
        const after = editContent.substring(end)
        const newContent = before + markup + after
        setEditContent(newContent)

        const cursorPos = markup.startsWith('<img ')
          ? start + markup.indexOf('width="') + 'width="'.length
          : start + markup.length
        requestAnimationFrame(() => {
          textarea.focus()
          textarea.setSelectionRange(cursorPos, cursorPos)
        })
      } else {
        setEditContent((prev: string) => prev + '\n\n' + markup)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to upload image')
    } finally {
      setIsUploading(false)
      input.value = ''
    }
  }, [memory, project, editContent])

  const handleVideoUpload = useCallback(async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    const projectId = project?.id || memory?.project_id
    if (!projectId) {
      setError('No project ID for upload')
      return
    }

    setIsUploading(true)
    try {
      const response = await uploadFile(projectId, file)
      const markup = `<video src="${response.url}" controls preload="metadata"></video>`

      if (textareaRef.current) {
        const textarea = textareaRef.current
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const before = editContent.substring(0, start)
        const after = editContent.substring(end)
        setEditContent(before + markup + after)
        requestAnimationFrame(() => {
          textarea.focus()
          textarea.setSelectionRange(start + markup.length, start + markup.length)
        })
      } else {
        setEditContent((prev: string) => prev + '\n\n' + markup)
      }
      showToast('Video uploaded')
    } catch (err: any) {
      setError(err.message || 'Failed to upload video')
    } finally {
      setIsUploading(false)
      input.value = ''
    }
  }, [memory, project, editContent])

  const handlePasteFile = useCallback(async (file: File): Promise<string | null> => {
    const projectId = project?.id || memory?.project_id
    if (!projectId) return null

    try {
      setIsUploading(true)
      const response = await uploadFile(projectId, file)
      const isImage = response.mime_type.startsWith('image/')
      return isImage
        ? `![${file.name || 'pasted-image'}](${response.url})`
        : `[${file.name}](${response.url})`
    } catch (err: any) {
      setError(err.message || 'Failed to upload pasted image')
      return null
    } finally {
      setIsUploading(false)
    }
  }, [memory, project])

  const handleDeleteMemory = useCallback(async () => {
    if (!memory) return
    const projectId = project?.id || memory.project_id
    if (!projectId) {
      setError('Missing project ID for delete')
      return
    }

    setIsDeleting(true)
    try {
      await deleteMemory(projectId, memory.id)
      const lastLocation =
        typeof window !== 'undefined'
          ? window.sessionStorage.getItem('khefLastLocation')
          : null
      if (lastLocation && !lastLocation.startsWith('/memories/')) {
        setLocation(lastLocation)
      } else if (project?.id) {
        setLocation(`/projects/${project.id}`)
      } else {
        setLocation('/search')
      }
    } catch (err: any) {
      setError(err.message || 'Failed to delete memory')
      setIsDeleting(false)
    }
  }, [memory, project])

  return {
    // State
    isUploading,
    copiedId,
    copiedContent,
    copiedSlack,
    copiedMarkdown,
    isDeleting,
    // Refs
    fileInputRef,
    videoFileInputRef,
    textareaRef,
    insertAsHtmlRef,
    // Computed
    isContentEditingDisabled,
    contentEditingDisabledReason,
    isContentDirty,
    // Handlers
    startEditingContent,
    cancelEditingContent,
    saveContent,
    copyMemoryId,
    copyContent,
    handleCopyMarkdown,
    handleTogglePin,
    handleExportMarkdown,
    handleExportDocx,
    handleExportCsv,
    handleExportXlsx,
    handleExportHtml,
    handleSaveToDrive,
    handleExportSlack,
    exportAsPng,
    handleFileUpload,
    handleVideoUpload,
    handlePasteFile,
    handleDeleteMemory,
  }
}
