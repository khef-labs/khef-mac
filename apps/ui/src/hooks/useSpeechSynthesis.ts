import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import { loadStore, saveStore } from '../lib/store'

export interface SpeechSynthesisState {
  isSupported: boolean
  isSpeaking: boolean
  isPaused: boolean
  voices: SpeechSynthesisVoice[]
  selectedVoice: SpeechSynthesisVoice | null
  rate: number
  pitch: number
  currentChunkIndex: number
  chunks: string[]
  spokenCharIndex: number
}

export interface UseSpeechSynthesisReturn extends SpeechSynthesisState {
  speak: (text: string) => void
  speakFrom: (text: string, fromSnippet: string) => void
  pause: () => void
  resume: () => void
  stop: () => void
  setVoice: (voice: SpeechSynthesisVoice) => void
  setRate: (rate: number) => void
  setPitch: (pitch: number) => void
}


// Character limit for individual utterances (browsers have ~32k limit)
const MAX_CHUNK_LENGTH = 5000

// Split text into speakable chunks at sentence boundaries
function splitIntoChunks(text: string): string[] {
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_LENGTH) {
      chunks.push(remaining.trim())
      break
    }

    // Find a good break point (sentence end, paragraph, or word boundary)
    let breakPoint = MAX_CHUNK_LENGTH

    // Try to break at sentence end
    const sentenceMatch = remaining.slice(0, MAX_CHUNK_LENGTH).match(/[.!?]\s+(?=[A-Z])/g)
    if (sentenceMatch) {
      const lastSentence = remaining.slice(0, MAX_CHUNK_LENGTH).lastIndexOf(sentenceMatch[sentenceMatch.length - 1])
      if (lastSentence > MAX_CHUNK_LENGTH / 2) {
        breakPoint = lastSentence + sentenceMatch[sentenceMatch.length - 1].length
      }
    }

    // Fall back to paragraph break
    if (breakPoint === MAX_CHUNK_LENGTH) {
      const paragraphBreak = remaining.slice(0, MAX_CHUNK_LENGTH).lastIndexOf('\n\n')
      if (paragraphBreak > MAX_CHUNK_LENGTH / 2) {
        breakPoint = paragraphBreak + 2
      }
    }

    // Fall back to line break
    if (breakPoint === MAX_CHUNK_LENGTH) {
      const lineBreak = remaining.slice(0, MAX_CHUNK_LENGTH).lastIndexOf('\n')
      if (lineBreak > MAX_CHUNK_LENGTH / 2) {
        breakPoint = lineBreak + 1
      }
    }

    // Fall back to space
    if (breakPoint === MAX_CHUNK_LENGTH) {
      const spaceBreak = remaining.slice(0, MAX_CHUNK_LENGTH).lastIndexOf(' ')
      if (spaceBreak > MAX_CHUNK_LENGTH / 2) {
        breakPoint = spaceBreak + 1
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trim())
    remaining = remaining.slice(breakPoint)
  }

  return chunks.filter(c => c.length > 0)
}

// Find the position in `original` that corresponds to where `needle`
// (lowercase, whitespace-collapsed) appears. Walks the original string
// collapsing whitespace on the fly to keep positions in sync.
function findOriginalPosition(original: string, needle: string): number {
  const lower = original.toLowerCase()
  let normI = 0 // position in the virtual normalized string

  // Build a mapping: for each char in the normalized string, track its original position
  const normToOrig: number[] = []
  let prevWasSpace = false

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i]
    const isSpace = /\s/.test(ch)

    if (isSpace) {
      if (!prevWasSpace) {
        normToOrig.push(i)
        normI++
      }
      prevWasSpace = true
    } else {
      normToOrig.push(i)
      normI++
      prevWasSpace = false
    }
  }

  // Search the normalized sequence for the needle
  const normStr = normToOrig.map(i => {
    const ch = lower[i]
    return /\s/.test(ch) ? ' ' : ch
  }).join('')

  const pos = normStr.indexOf(needle)
  if (pos < 0) return -1

  // Map back to original position
  return normToOrig[pos] ?? -1
}

// Find a clean break point (sentence or paragraph boundary) at or before `pos`
function findBreakBefore(text: string, pos: number): number {
  if (pos <= 0) return 0
  // Look backwards from pos for a paragraph break
  const parBreak = text.lastIndexOf('\n\n', pos)
  if (parBreak >= 0 && parBreak > pos - 200) return parBreak + 2
  // Sentence boundary
  const slice = text.slice(0, pos)
  const sentenceEnd = slice.search(/[.!?]\s+(?=[A-Z])[^]*$/)
  if (sentenceEnd >= 0 && sentenceEnd > pos - 200) {
    const afterPunc = slice.indexOf(' ', sentenceEnd + 1)
    return afterPunc >= 0 ? afterPunc + 1 : sentenceEnd
  }
  // Line break
  const lineBreak = text.lastIndexOf('\n', pos)
  if (lineBreak >= 0 && lineBreak > pos - 200) return lineBreak + 1
  // Fall back to the position itself
  return pos
}

// Strip markdown and non-speakable content for cleaner TTS output
function stripMarkdown(text: string): string {
  return text
    // Remove YAML frontmatter
    .replace(/^---[\s\S]*?---\n*/g, '')
    // Remove code blocks (fenced) entirely
    .replace(/```[\s\S]*?```/g, '')
    // Keep inline code text, just remove the backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove images (before links to avoid partial matches)
    .replace(/!\[.*?\]\([^)]+\)/g, '')
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove reference-style link definitions
    .replace(/^\[[^\]]+\]:\s*.*$/gm, '')
    // Remove bare URLs (https://, http://, www.)
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    .replace(/www\.[^\s)>\]]+/g, '')
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    // Remove file paths (Unix and Windows style)
    .replace(/(?:\/[\w.-]+)+\/?/g, ' ')
    .replace(/(?:[A-Z]:\\[\w\\.-]+)+/gi, ' ')
    // Remove headers but keep text
    .replace(/^#{1,6}\s+/gm, '')
    // Remove emphasis markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Remove strikethrough
    .replace(/~~(.*?)~~/g, '$1')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove blockquotes marker
    .replace(/^>\s*/gm, '')
    // Remove task list checkboxes
    .replace(/^\s*[-*+]\s*\[[ xX]\]\s*/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove footnote references
    .replace(/\[\^[^\]]+\]/g, '')
    // Remove footnote definitions
    .replace(/^\[\^[^\]]+\]:.*$/gm, '')
    // Remove table formatting (pipes and dashes)
    .replace(/^\|.*\|$/gm, (match) => {
      // Convert table rows to readable text
      if (/^[\s|:-]+$/.test(match)) return '' // Skip separator rows
      return match.replace(/\|/g, ', ').replace(/^,\s*/, '').replace(/,\s*$/, '')
    })
    // Remove definition list markers
    .replace(/^:\s+/gm, '')
    // Clean up special characters that don't read well
    .replace(/[│┃┆┇┊┋]/g, '') // Box drawing characters
    .replace(/[→←↑↓↔↕]/g, '') // Arrows
    .replace(/[•◦▪▫]/g, '') // Bullets
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function useSpeechSynthesis(): UseSpeechSynthesisReturn {
  const [isSupported] = useState(() => typeof window !== 'undefined' && 'speechSynthesis' in window)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null)
  const [rate, setRateState] = useState(() => loadStore().tts.rate)
  const [pitch, setPitch] = useState(1.0)

  const [currentChunkIndex, setCurrentChunkIndex] = useState(-1)
  const [chunks, setChunks] = useState<string[]>([])
  const [spokenCharIndex, setSpokenCharIndex] = useState(-1)
  const chunksRef = useRef<string[]>([])
  const currentChunkRef = useRef(0)
  // Generation counter — incremented on each speak/speakFrom so stale
  // utterance callbacks (onend, onboundary, onerror) from a canceled
  // speech are ignored.
  const generationRef = useRef(0)
  const savedVoiceUriRef = useRef<string | null>(loadStore().tts.voiceUri)

  // Load voices (may be async on some browsers)
  useEffect(() => {
    if (!isSupported) return

    const loadVoices = () => {
      // PRIVACY: Only use local voices (localService === true).
      // Network voices (localService === false) send text to cloud services (e.g., Google)
      // for synthesis. Local voices process everything on-device with no network calls.
      const availableVoices = speechSynthesis.getVoices().filter(v => v.localService)
      setVoices(availableVoices)

      // Select saved voice, or fall back to default English voice
      if (!selectedVoice && availableVoices.length > 0) {
        // Try to restore saved voice (must also be local)
        const savedUri = savedVoiceUriRef.current
        const savedVoice = savedUri ? availableVoices.find(v => v.voiceURI === savedUri) : null

        const voice = savedVoice
          || availableVoices.find(v => v.lang.startsWith('en') && v.default)
          || availableVoices.find(v => v.lang.startsWith('en-US'))
          || availableVoices.find(v => v.lang.startsWith('en'))
          || availableVoices[0]
        setSelectedVoice(voice)
      }
    }

    loadVoices()

    // Some browsers fire voiceschanged event when voices load
    speechSynthesis.addEventListener('voiceschanged', loadVoices)
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', loadVoices)
    }
  }, [isSupported, selectedVoice])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isSupported) {
        speechSynthesis.cancel()
      }
    }
  }, [isSupported])

  const speakNextChunk = useCallback(() => {
    if (currentChunkRef.current >= chunksRef.current.length) {
      setIsSpeaking(false)
      setIsPaused(false)
      setCurrentChunkIndex(-1)
      setSpokenCharIndex(-1)
      return
    }

    setCurrentChunkIndex(currentChunkRef.current)
    setSpokenCharIndex(0)
    const chunk = chunksRef.current[currentChunkRef.current]
    const utterance = new SpeechSynthesisUtterance(chunk)

    if (selectedVoice) {
      utterance.voice = selectedVoice
    }
    utterance.rate = rate
    utterance.pitch = pitch

    // Capture generation so stale callbacks from canceled speech are ignored
    const gen = generationRef.current

    utterance.onboundary = (event) => {
      if (gen !== generationRef.current) return
      if (event.name === 'word') {
        setSpokenCharIndex(event.charIndex)
      }
    }

    utterance.onend = () => {
      if (gen !== generationRef.current) return
      currentChunkRef.current++
      speakNextChunk()
    }

    utterance.onerror = (event) => {
      if (event.error === 'canceled') return
      if (gen !== generationRef.current) return
      console.error('Speech synthesis error:', event.error)
      setIsSpeaking(false)
      setIsPaused(false)
      setCurrentChunkIndex(-1)
      setSpokenCharIndex(-1)
    }

    speechSynthesis.speak(utterance)
  }, [selectedVoice, rate, pitch])

  const speak = useCallback((text: string) => {
    if (!isSupported) return

    // Stop any current speech and invalidate stale callbacks
    generationRef.current++
    speechSynthesis.cancel()

    // Prepare text and split into chunks
    const cleanText = stripMarkdown(text)
    const newChunks = splitIntoChunks(cleanText)
    chunksRef.current = newChunks
    currentChunkRef.current = 0
    setChunks(newChunks)

    if (newChunks.length === 0) return

    setIsSpeaking(true)
    setIsPaused(false)
    speakNextChunk()
  }, [isSupported, speakNextChunk])

  // Jump to the chunk containing `fromSnippet` (plain text from a DOM block).
  // Uses a short delay between cancel() and speak() to work around a Chrome bug
  // where cancel + immediate speak fails to stop the old utterance.
  const speakFrom = useCallback((text: string, fromSnippet: string) => {
    if (!isSupported) return

    generationRef.current++
    speechSynthesis.cancel()

    const cleanText = stripMarkdown(text)
    const newChunks = splitIntoChunks(cleanText)

    if (newChunks.length === 0) return

    // Find the chunk and position within it that contains the snippet,
    // then truncate so playback starts from that point
    const normalizedSnippet = fromSnippet.replace(/\s+/g, ' ').trim().toLowerCase()
    const needle = normalizedSnippet.slice(0, 80)
    let startChunk = 0

    if (needle.length > 5) {
      for (let i = 0; i < newChunks.length; i++) {
        const origChunk = newChunks[i]
        // Map normalized match position back to original string position
        const origPos = findOriginalPosition(origChunk, needle)
        if (origPos >= 0) {
          // Find a sentence/paragraph boundary near the match position
          const breakPos = findBreakBefore(origChunk, origPos)
          const truncated = origChunk.slice(breakPos).trim()
          if (truncated.length > 0) {
            newChunks[i] = truncated
          }
          startChunk = i
          break
        }
      }
    }

    // Delay to let cancel() fully flush before starting new speech
    const gen = generationRef.current
    setTimeout(() => {
      if (gen !== generationRef.current) return
      chunksRef.current = newChunks
      setChunks(newChunks)
      currentChunkRef.current = startChunk
      setIsSpeaking(true)
      setIsPaused(false)
      speakNextChunk()
    }, 100)
  }, [isSupported, speakNextChunk])

  const pause = useCallback(() => {
    if (!isSupported || !isSpeaking) return
    speechSynthesis.pause()
    setIsPaused(true)
  }, [isSupported, isSpeaking])

  const resume = useCallback(() => {
    if (!isSupported || !isPaused) return
    speechSynthesis.resume()
    setIsPaused(false)
  }, [isSupported, isPaused])

  const stop = useCallback(() => {
    if (!isSupported) return
    generationRef.current++
    speechSynthesis.cancel()
    chunksRef.current = []
    currentChunkRef.current = 0
    setChunks([])
    setCurrentChunkIndex(-1)
    setSpokenCharIndex(-1)
    setIsSpeaking(false)
    setIsPaused(false)
  }, [isSupported])

  const setVoice = useCallback((voice: SpeechSynthesisVoice) => {
    setSelectedVoice(voice)
    saveStore({ tts: { ...loadStore().tts, voiceUri: voice.voiceURI } })
  }, [])

  const setRate = useCallback((newRate: number) => {
    setRateState(newRate)
    saveStore({ tts: { ...loadStore().tts, rate: newRate } })
  }, [])

  return {
    isSupported,
    isSpeaking,
    isPaused,
    voices,
    selectedVoice,
    rate,
    pitch,
    currentChunkIndex,
    chunks,
    spokenCharIndex,
    speak,
    speakFrom,
    pause,
    resume,
    stop,
    setVoice,
    setRate,
    setPitch,
  }
}
