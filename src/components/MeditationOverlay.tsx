import { useEffect, useRef, useState } from 'react'

// 呼吸节奏：吸气 4 秒、停留 7 秒、呼气 9 秒，循环周期 20 秒
const BREATH_CYCLE = [
  { name: '吸气', seconds: 4, tone: 523.25 },
  { name: '停留', seconds: 7, tone: 392 },
  { name: '呼气', seconds: 9, tone: 261.63 },
] as const

const DURATIONS = [1, 3, 5, 10, 15, 30]
const CYCLE_SECONDS = BREATH_CYCLE.reduce((sum, phase) => sum + phase.seconds, 0)

type MeditationStatus = 'select' | 'running' | 'done'

function phaseOf(elapsed: number) {
  const position = elapsed % CYCLE_SECONDS
  if (position < BREATH_CYCLE[0].seconds) return 0
  if (position < BREATH_CYCLE[0].seconds + BREATH_CYCLE[1].seconds) return 1
  return 2
}

function clockLabel(seconds: number) {
  const safe = Math.max(0, seconds)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

export function MeditationOverlay({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<MeditationStatus>('select')
  const [total, setTotal] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)

  const audioContextRef = useRef<AudioContext | null>(null)
  const lastPhaseRef = useRef(-1)
  const mutedRef = useRef(muted)

  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  // 关闭时释放音频资源，避免后台残留
  useEffect(() => () => {
    void audioContextRef.current?.close()
  }, [])

  function getAudioContext() {
    if (!audioContextRef.current) {
      const Context = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Context) return null
      audioContextRef.current = new Context()
    }
    return audioContextRef.current
  }

  // 柔和的正弦提示音，音量刻意压低，避免打断呼吸
  function playTone(frequency: number, duration = 1.1, volume = 0.06) {
    if (mutedRef.current) return
    try {
      const context = getAudioContext()
      if (!context) return
      if (context.state === 'suspended') void context.resume()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const now = context.currentTime
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.linearRampToValueAtTime(volume, now + 0.16)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(now)
      oscillator.stop(now + duration + 0.05)
    } catch {
      // 音频不可用时不影响冥想计时
    }
  }

  function playFinishChime() {
    playTone(392, 0.9, 0.05)
    window.setTimeout(() => playTone(523.25, 1.4, 0.06), 420)
  }

  function start(minutes: number) {
    setTotal(minutes * 60)
    setElapsed(0)
    setPaused(false)
    setStatus('running')
    lastPhaseRef.current = -1
    // 在点击手势里创建音频上下文，满足浏览器的自动播放限制
    getAudioContext()
    playTone(BREATH_CYCLE[0].tone)
    lastPhaseRef.current = 0
  }

  // 每秒推进一次；暂停时停掉计时器即可
  useEffect(() => {
    if (status !== 'running' || paused) return
    const timer = window.setInterval(() => {
      setElapsed((value) => value + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status, paused])

  // 阶段切换时发声；结束或手动停止后展示完成态
  useEffect(() => {
    if (status !== 'running') return
    if (elapsed >= total) {
      setStatus('done')
      playFinishChime()
      return
    }
    const phase = phaseOf(elapsed)
    if (phase !== lastPhaseRef.current) {
      lastPhaseRef.current = phase
      playTone(BREATH_CYCLE[phase].tone)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, status, total])

  const phase = status === 'running' ? phaseOf(elapsed) : 0
  const cycle = Math.floor(elapsed / CYCLE_SECONDS)
  const phaseName = BREATH_CYCLE[phase].name

  return (
    <div className="meditation-overlay" role="dialog" aria-modal="true" aria-label="冥想">
      {status === 'select' && (
        <section className="meditation-panel">
          <h2>冥想</h2>
          <p className="meditation-rhythm">4 秒吸气 · 7 秒停留 · 9 秒呼气</p>
          <div className="meditation-options">
            {DURATIONS.map((minutes) => (
              <button key={minutes} type="button" onClick={() => start(minutes)}>
                {minutes} 分钟
              </button>
            ))}
          </div>
          <button type="button" className="meditation-close" onClick={onClose}>关闭</button>
        </section>
      )}

      {status === 'running' && (
        <section className="meditation-session">
          <div
            key={`${cycle}-${phase}`}
            className={[
              'meditation-breath-circle',
              phase === 0 ? 'phase-in' : phase === 1 ? 'phase-hold' : 'phase-out',
              paused ? 'is-paused' : '',
            ].filter(Boolean).join(' ')}
          >
            <span>{phaseName}</span>
          </div>
          <p className="meditation-countdown" aria-live="polite">{clockLabel(total - elapsed)}</p>
          <div className="meditation-controls">
            <button type="button" onClick={() => setPaused((value) => !value)}>
              {paused ? '继续' : '暂停'}
            </button>
            <button type="button" onClick={() => setMuted((value) => !value)}>
              {muted ? '开启声音' : '静音'}
            </button>
            <button type="button" onClick={() => setStatus('done')}>结束</button>
          </div>
        </section>
      )}

      {status === 'done' && (
        <section className="meditation-panel">
          <h2>完成</h2>
          <p className="meditation-rhythm">
            {total > 0 ? `本次冥想 ${total / 60} 分钟` : '本次冥想已结束'}
          </p>
          <div className="meditation-done-actions">
            <button type="button" onClick={() => setStatus('select')}>再来一次</button>
            <button type="button" className="primary" onClick={onClose}>关闭</button>
          </div>
        </section>
      )}
    </div>
  )
}
