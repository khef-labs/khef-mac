import { Volume2 } from 'lucide-preact'
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis'
import shared from './SettingsShared.module.css'
import styles from './TtsSection.module.css'

export function TtsSection() {
  const tts = useSpeechSynthesis()

  if (!tts.isSupported) {
    return (
      <div class={shared.section}>

        <p class={shared.description}>
          Text-to-speech is not supported in this browser.
        </p>
      </div>
    )
  }

  return (
    <div class={shared.section}>
      <h2 class={shared.sectionTitle}>Text-to-Speech</h2>
      <p class={shared.description}>
        Configure voice and speed for reading memory content aloud.
        Only local voices are shown (no data sent over the network).
      </p>
      <div class={shared.field}>
        <label class={shared.label} htmlFor="ttsSpeed">Speed</label>
        <div class={styles.speedButtons}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => (
            <button
              key={speed}
              type="button"
              class={`${styles.speedButton} ${tts.rate === speed ? styles.speedButtonActive : ''}`}
              onClick={() => tts.setRate(speed)}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>
      {tts.voices.filter(v => v.lang.startsWith('en')).length > 0 && (
        <div class={shared.field}>
          <label class={shared.label} htmlFor="ttsVoice">Voice</label>
          <select
            id="ttsVoice"
            class={shared.input}
            value={tts.selectedVoice?.voiceURI || ''}
            onChange={(e) => {
              const uri = (e.target as HTMLSelectElement).value
              const voice = tts.voices.find(v => v.voiceURI === uri)
              if (voice) tts.setVoice(voice)
            }}
          >
            {tts.voices
              .filter(v => v.lang.startsWith('en'))
              .map(voice => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name.replace(/^(Microsoft |Google )/, '')} ({voice.lang})
                </option>
              ))}
          </select>
          <p class={shared.description}>
            Available voices depend on your browser and operating system.
          </p>
        </div>
      )}
      <div class={shared.field}>
        <label class={shared.label}>Preview</label>
        <button
          type="button"
          class={shared.syncButton}
          onClick={() => {
            if (tts.isSpeaking) {
              tts.stop()
            } else {
              tts.speak('This is a preview of the selected voice and speed settings.')
            }
          }}
        >
          <Volume2 size={16} />
          {tts.isSpeaking ? 'Stop' : 'Play Sample'}
        </button>
      </div>
    </div>
  )
}
