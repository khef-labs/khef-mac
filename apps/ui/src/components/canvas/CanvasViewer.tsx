import { useState, useCallback, useEffect, useRef } from 'preact/hooks'
import { Maximize, Minimize } from 'lucide-preact'
import clsx from 'clsx'
import styles from './CanvasViewer.module.css'

interface CanvasViewerProps {
  content: string
  className?: string
}

const HEIGHT_REPORTER = `<script>
(function(){
  var maxH = 0;
  var timer = null;
  var settled = false;
  function report(){
    if (settled || timer) return;
    timer = setTimeout(function(){
      timer = null;
      var h = document.documentElement.scrollHeight;
      if (h > maxH + 2) {
        maxH = h;
        parent.postMessage({type:'canvas-height',height:h},'*');
      }
    }, 150);
  }
  new MutationObserver(report).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('load',report);
  report();
  setTimeout(report,300);
  setTimeout(function(){ settled=true; },5000);
})();
</script>`

function injectHeightReporter(html: string): string {
  const idx = html.lastIndexOf('</body>')
  if (idx !== -1) return html.slice(0, idx) + HEIGHT_REPORTER + html.slice(idx)
  return html + HEIGHT_REPORTER
}

export function CanvasViewer({ content, className }: CanvasViewerProps) {
  const [fullscreen, setFullscreen] = useState(false)
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const toggleFullscreen = useCallback(() => {
    setFullscreen((prev) => !prev)
  }, [])

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [fullscreen])

  // Listen for height messages from the iframe (with threshold to prevent resize loops)
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'canvas-height' && typeof e.data.height === 'number') {
        if (iframeRef.current && e.source === iframeRef.current.contentWindow) {
          setContentHeight((prev) => {
            if (prev !== null && Math.abs(e.data.height - prev) <= 2) return prev
            return e.data.height
          })
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  const srcDoc = injectHeightReporter(content)
  const iframeStyle = !fullscreen && contentHeight ? { height: `${contentHeight}px` } : undefined

  return (
    <div class={clsx(styles.wrapper, fullscreen && styles.fullscreen, className)}>
      <div class={styles.controls}>
        <button
          class={styles.controlButton}
          onClick={toggleFullscreen}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      </div>
      <iframe
        ref={iframeRef}
        class={styles.iframe}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title="Canvas content"
        style={iframeStyle}
      />
    </div>
  )
}
