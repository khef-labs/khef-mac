import { useMemo } from 'preact/hooks'
import styles from './LoadingMessage.module.css'

const LOADING_MESSAGES = [
  'Flibgittering...',
  'Pondering the cosmos...',
  'Rummaging through neurons...',
  'Consulting the oracle...',
  'Unscrambling thoughts...',
  'Wrangling bits...',
  'Tickling the database...',
  'Herding electrons...',
  'Summoning memories...',
  'Dusting off the archives...',
  'Percolating...',
  'Cogitating furiously...',
  'Befuddling the cache...',
  'Untangling synapses...',
  'Communing with silicon...',
  'Prestidigitating...',
  'Aligning the stars...',
  'Decoding the matrix...',
  'Exploring the labyrinth...',
  'Navigating the data seas...',
  'Illuminating the dark corners...',
]

export function getRandomLoadingMessage(): string {
  return LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)]
}

interface LoadingMessageProps {
  /** Stable key to keep the message consistent across re-renders (e.g., page ID) */
  stableKey?: string
  /** Override the random message */
  message?: string
}

export function LoadingMessage({ stableKey, message }: LoadingMessageProps) {
  const text = useMemo(() => message || getRandomLoadingMessage(), [stableKey, message])

  return (
    <div class={styles.loading}>
      <div class={styles.spinner} />
      <span class={styles.message}>{text}</span>
    </div>
  )
}
