import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
} from 'lucide-preact'
import styles from './VideoPlayer.module.css'

interface VideoPlayerProps {
  src: string
  poster?: string
  caption?: string
  className?: string
}

const SPEEDS = [0.5, 1, 1.25, 1.5, 2]

/** Convert a YouTube or Vimeo URL to its embed form. Returns null for non-embeddable URLs. */
function toEmbedUrl(src: string): string | null {
  // YouTube: watch, short link, or already embed
  const ytWatch = src.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([\w-]+)/)
  if (ytWatch) return `https://www.youtube.com/embed/${ytWatch[1]}`
  const ytEmbed = src.match(/youtube\.com\/embed\/([\w-]+)/)
  if (ytEmbed) return `https://www.youtube.com/embed/${ytEmbed[1]}`

  // Vimeo
  const vimeo = src.match(/vimeo\.com\/(\d+)/)
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`

  // Google Drive: shared link or already preview/embed
  const gdrive = src.match(/drive\.google\.com\/file\/d\/([\w-]+)/)
  if (gdrive) return `https://drive.google.com/file/d/${gdrive[1]}/preview`

  return null
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function VideoPlayer({ src, poster, caption, className }: VideoPlayerProps) {
  // External embeds (YouTube, Vimeo) — render iframe with platform controls
  const embedUrl = toEmbedUrl(src)
  if (embedUrl) {
    return (
      <div class={`${styles.wrapper} ${styles.embedWrapper} ${className || ''}`.trim()}>
        <iframe
          class={styles.embedIframe}
          src={embedUrl}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          title={caption || 'Embedded video'}
        />
        {caption && <div class={styles.caption}>{caption}</div>}
      </div>
    )
  }

  const wrapperRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const seekRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isSeeking, setIsSeeking] = useState(false)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)

  // --- Video event handlers ---

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (v && !isSeeking) setCurrentTime(v.currentTime)
  }, [isSeeking])

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (v) setDuration(v.duration)
  }, [])

  const onProgress = useCallback(() => {
    const v = videoRef.current
    if (v && v.buffered.length > 0) {
      setBuffered(v.buffered.end(v.buffered.length - 1))
    }
  }, [])

  const onPlay = useCallback(() => setPlaying(true), [])
  const onPause = useCallback(() => setPlaying(false), [])
  const onEnded = useCallback(() => setPlaying(false), [])

  // --- Controls auto-hide ---

  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (playing) {
      hideTimer.current = setTimeout(() => setControlsVisible(false), 2500)
    }
  }, [playing])

  useEffect(() => {
    if (playing) {
      hideTimer.current = setTimeout(() => setControlsVisible(false), 2500)
    } else {
      setControlsVisible(true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [playing])

  // --- Fullscreen tracking ---

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // --- Actions ---

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play()
    else v.pause()
  }, [])

  const skip = useCallback((delta: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta))
  }, [])

  const changeSpeed = useCallback((s: number) => {
    const v = videoRef.current
    if (!v) return
    v.playbackRate = s
    setSpeed(s)
    setShowSpeedMenu(false)
  }, [])

  const cycleSpeed = useCallback(() => {
    const idx = SPEEDS.indexOf(speed)
    const next = SPEEDS[(idx + 1) % SPEEDS.length]
    changeSpeed(next)
  }, [speed, changeSpeed])

  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }, [])

  const changeVolume = useCallback((val: number) => {
    const v = videoRef.current
    if (!v) return
    v.volume = val
    setVolume(val)
    if (val > 0 && v.muted) {
      v.muted = false
      setMuted(false)
    }
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      el.requestFullscreen()
    }
  }, [])

  // --- Seek bar interactions ---

  const seekTo = useCallback(
    (clientX: number) => {
      const bar = seekRef.current
      const v = videoRef.current
      if (!bar || !v || !duration) return
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const time = pct * duration
      v.currentTime = time
      setCurrentTime(time)
    },
    [duration]
  )

  const onSeekMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      setIsSeeking(true)
      seekTo(e.clientX)

      const onMove = (ev: MouseEvent) => seekTo(ev.clientX)
      const onUp = () => {
        setIsSeeking(false)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [seekTo]
  )

  const onSeekHover = useCallback(
    (e: MouseEvent) => {
      const bar = seekRef.current
      if (!bar || !duration) return
      const rect = bar.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      setHoverTime(pct * duration)
      setHoverX(e.clientX - rect.left)
    },
    [duration]
  )

  const onSeekLeave = useCallback(() => {
    setHoverTime(null)
  }, [])

  // --- Keyboard shortcuts ---

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      const key = e.key.toLowerCase()
      let handled = true

      switch (key) {
        case ' ':
        case 'k':
          togglePlay()
          break
        case 'arrowleft':
          skip(-5)
          break
        case 'arrowright':
          skip(5)
          break
        case 'j':
          skip(-10)
          break
        case 'l':
          skip(10)
          break
        case 'm':
          toggleMute()
          break
        case 'f':
          toggleFullscreen()
          break
        case '<':
        case ',': {
          const idx = SPEEDS.indexOf(speed)
          if (idx > 0) changeSpeed(SPEEDS[idx - 1])
          break
        }
        case '>':
        case '.': {
          const idx = SPEEDS.indexOf(speed)
          if (idx < SPEEDS.length - 1) changeSpeed(SPEEDS[idx + 1])
          break
        }
        default:
          handled = false
      }

      if (handled) {
        e.preventDefault()
        e.stopPropagation()
        showControls()
      }
    },
    [togglePlay, skip, toggleMute, toggleFullscreen, speed, changeSpeed, showControls]
  )

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0

  return (
    <div
      ref={wrapperRef}
      class={`${styles.wrapper} ${isFullscreen ? styles.fullscreen : ''} ${className || ''}`.trim()}
      onMouseMove={showControls}
      onClick={(e) => {
        // Close speed menu on outside click
        if (showSpeedMenu) {
          setShowSpeedMenu(false)
          e.stopPropagation()
        }
      }}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <video
        ref={videoRef}
        class={styles.video}
        src={src}
        preload="metadata"
        poster={poster}
        playsInline
        onClick={togglePlay}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={onLoadedMetadata}
        onProgress={onProgress}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
      />

      {/* Play overlay when paused */}
      {!playing && (
        <button class={styles.playOverlay} onClick={togglePlay} aria-label="Play">
          <Play size={48} fill="currentColor" />
        </button>
      )}

      {/* Control bar */}
      <div class={`${styles.controls} ${controlsVisible ? styles.controlsVisible : ''}`}>
        {/* Seek bar */}
        <div
          ref={seekRef}
          class={styles.seekBar}
          onMouseDown={onSeekMouseDown}
          onMouseMove={onSeekHover}
          onMouseLeave={onSeekLeave}
        >
          <div class={styles.seekTrack}>
            <div class={styles.seekBuffered} style={{ width: `${bufferedPct}%` }} />
            <div class={styles.seekProgress} style={{ width: `${progress}%` }} />
            <div class={styles.seekThumb} style={{ left: `${progress}%` }} />
          </div>
          {hoverTime !== null && (
            <div class={styles.seekTooltip} style={{ left: `${hoverX}px` }}>
              {formatTime(hoverTime)}
            </div>
          )}
        </div>

        {/* Bottom row */}
        <div class={styles.controlsRow}>
          <div class={styles.controlsLeft}>
            <button class={styles.controlBtn} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button class={styles.controlBtn} onClick={() => skip(-10)} aria-label="Skip back 10s" title="-10s">
              <SkipBack size={16} />
            </button>
            <button class={styles.controlBtn} onClick={() => skip(10)} aria-label="Skip forward 10s" title="+10s">
              <SkipForward size={16} />
            </button>

            <div class={styles.volumeGroup}>
              <button class={styles.controlBtn} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <input
                class={styles.volumeSlider}
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onInput={(e) => changeVolume(parseFloat((e.target as HTMLInputElement).value))}
                aria-label="Volume"
              />
            </div>

            <span class={styles.timeDisplay}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div class={styles.controlsRight}>
            <div class={styles.speedControl}>
              <button
                class={styles.speedBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  setShowSpeedMenu((prev) => !prev)
                }}
                onDblClick={(e) => {
                  e.stopPropagation()
                  cycleSpeed()
                }}
                aria-label="Playback speed"
              >
                {speed}x
              </button>
              {showSpeedMenu && (
                <div class={styles.speedMenu}>
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      class={`${styles.speedMenuItem} ${s === speed ? styles.speedMenuItemActive : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        changeSpeed(s)
                      }}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button class={styles.controlBtn} onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            </button>
          </div>
        </div>
      </div>

      {caption && <div class={styles.caption}>{caption}</div>}
    </div>
  )
}
