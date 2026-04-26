import { useState } from 'preact/hooks'
import { Upload, Loader, Check, FileText, ClipboardPaste, AlertTriangle } from 'lucide-preact'
import clsx from 'clsx'
import { ingestSlack, getSlackDocument } from '../../lib/api'
import type { EmbedHealth } from '../../types'
import styles from './EmbedForm.module.css'

type InputMode = 'paste' | 'file'

interface ExistingDoc {
  chunk_count: number
  updated_at: string
  file_size: number
}

interface Props {
  embedHealth: EmbedHealth | null
  onError: (message: string) => void
  onIngested?: () => void
}

export function SlackEmbedForm({ embedHealth, onError, onIngested }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>('file')
  const [documentId, setDocumentId] = useState('')
  const [content, setContent] = useState('')
  const [filePath, setFilePath] = useState('')
  const [channel, setChannel] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [dateRange, setDateRange] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [result, setResult] = useState<{ chunks_created: number } | null>(null)
  const [existingDoc, setExistingDoc] = useState<ExistingDoc | null>(null)
  const [showConflict, setShowConflict] = useState(false)

  const buildMetadata = () => {
    const metadata: Record<string, string> = {}
    if (channel.trim()) metadata.channel = channel.trim()
    if (workspace.trim()) metadata.workspace = workspace.trim()
    if (dateRange.trim()) metadata.date_range = dateRange.trim()
    return Object.keys(metadata).length > 0 ? metadata : undefined
  }

  const doIngest = async (mode?: 'replace' | 'append') => {
    setIngesting(true)
    setResult(null)
    setShowConflict(false)
    try {
      const body: Parameters<typeof ingestSlack>[0] = {
        document_id: documentId.trim(),
        metadata: buildMetadata(),
        mode,
      }
      if (inputMode === 'paste') {
        body.content = content.trim()
      } else {
        body.path = filePath.trim()
      }

      const data = await ingestSlack(body)
      setResult({ chunks_created: data.chunks_created })
      onIngested?.()
    } catch (err: any) {
      onError(err?.message || 'Failed to ingest Slack content')
    } finally {
      setIngesting(false)
    }
  }

  const handleIngest = async () => {
    const hasInput = inputMode === 'paste' ? content.trim() : filePath.trim()
    if (!documentId.trim() || !hasInput) return

    // Check if document already exists
    try {
      const { document } = await getSlackDocument(documentId.trim())
      setExistingDoc({
        chunk_count: document.chunk_count,
        updated_at: document.updated_at,
        file_size: document.file_size,
      })
      setShowConflict(true)
    } catch {
      // 404 = doesn't exist, proceed directly
      doIngest()
    }
  }

  const hasInput = inputMode === 'paste' ? content.trim() : filePath.trim()
  const canSubmit = documentId.trim() && hasInput && embedHealth?.available && !ingesting && !showConflict

  return (
    <div class={styles.embedForm}>
      <div class={styles.embedFormField}>
        <label>Document ID</label>
        <input
          type="text"
          placeholder="general-2024-05"
          value={documentId}
          onInput={(e) => { setDocumentId((e.target as HTMLInputElement).value); setResult(null); setShowConflict(false) }}
        />
      </div>

      <div class={styles.modeToggle}>
        <button
          type="button"
          class={clsx(styles.modeButton, inputMode === 'file' && styles.modeButtonActive)}
          onClick={() => { setInputMode('file'); setResult(null) }}
        >
          <FileText size={13} /> File path
        </button>
        <button
          type="button"
          class={clsx(styles.modeButton, inputMode === 'paste' && styles.modeButtonActive)}
          onClick={() => { setInputMode('paste'); setResult(null) }}
        >
          <ClipboardPaste size={13} /> Paste content
        </button>
      </div>

      {inputMode === 'file' ? (
        <div class={styles.embedFormField}>
          <label>File path</label>
          <input
            type="text"
            placeholder="/path/to/slack-export.md"
            value={filePath}
            onInput={(e) => { setFilePath((e.target as HTMLInputElement).value); setResult(null) }}
          />
        </div>
      ) : (
        <div class={styles.embedFormField}>
          <label>Content</label>
          <textarea
            class={styles.contentTextarea}
            placeholder={"### [2024-05-01 09:15] U12345\nHey team, the deploy went through.\n\n### [2024-05-01 09:20] U67890\nLooks good, tests passing."}
            value={content}
            rows={8}
            onInput={(e) => { setContent((e.target as HTMLTextAreaElement).value); setResult(null) }}
          />
        </div>
      )}

      <div class={styles.embedFormGrid}>
        <div class={styles.embedFormField}>
          <label>Channel</label>
          <input
            type="text"
            placeholder="general"
            value={channel}
            onInput={(e) => setChannel((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class={styles.embedFormField}>
          <label>Workspace</label>
          <input
            type="text"
            placeholder="my-team"
            value={workspace}
            onInput={(e) => setWorkspace((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div class={styles.embedFormField}>
        <label>Date range</label>
        <input
          type="text"
          placeholder="2024-05-01 to 2024-05-31"
          value={dateRange}
          onInput={(e) => setDateRange((e.target as HTMLInputElement).value)}
        />
      </div>

      {showConflict && existingDoc && (
        <div class={styles.conflictBanner}>
          <div class={styles.conflictMessage}>
            <AlertTriangle size={14} />
            <span>
              Document <strong>{documentId.trim()}</strong> already exists ({existingDoc.chunk_count} chunks,
              updated {new Date(existingDoc.updated_at).toLocaleDateString()})
            </span>
          </div>
          <div class={styles.conflictActions}>
            <button type="button" class={styles.conflictAppend} onClick={() => doIngest('append')}>
              Append
            </button>
            <button type="button" class={styles.conflictReplace} onClick={() => doIngest('replace')}>
              Replace
            </button>
            <button type="button" class={styles.conflictCancel} onClick={() => setShowConflict(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div class={styles.embedActions}>
        <button
          type="button"
          class={styles.embedStartButton}
          disabled={!canSubmit}
          onClick={handleIngest}
        >
          {ingesting ? <Loader size={14} /> : <Upload size={14} />}
          {ingesting ? 'Ingesting...' : 'Ingest'}
        </button>
        <span class={styles.healthLabel}>
          <span class={clsx(styles.healthDot, embedHealth?.available ? styles.healthOnline : styles.healthOffline)} />
          {embedHealth?.available ? `Embed server online (${embedHealth.model})` : 'Embed server offline'}
        </span>
        {result && (
          <span class={styles.ingestResult}>
            <Check size={14} />
            {result.chunks_created > 0
              ? `${result.chunks_created} chunk${result.chunks_created === 1 ? '' : 's'} created`
              : 'Content unchanged (0 chunks)'}
          </span>
        )}
      </div>
    </div>
  )
}
