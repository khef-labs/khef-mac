import { useState, useCallback } from 'preact/hooks'
import { Copy, Check } from 'lucide-preact'
import clsx from 'clsx'
import styles from './CopyButton.module.css'

interface CopyButtonProps {
  text: string
  title?: string
  size?: number
  label?: string
  copiedLabel?: string
  className?: string
  onCopy?: () => void
  stopPropagation?: boolean
}

export function CopyButton({
  text,
  title = 'Copy to clipboard',
  size = 14,
  label,
  copiedLabel = 'Copied',
  className,
  onCopy,
  stopPropagation,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (stopPropagation) e.stopPropagation()
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        onCopy?.()
      })
    },
    [text, stopPropagation, onCopy],
  )

  return (
    <button
      type="button"
      class={clsx(styles.copyButton, label && styles.withLabel, className)}
      onClick={handleClick}
      title={copied ? 'Copied!' : title}
      data-testid="copy-button"
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
      {label && (copied ? copiedLabel : label)}
    </button>
  )
}
