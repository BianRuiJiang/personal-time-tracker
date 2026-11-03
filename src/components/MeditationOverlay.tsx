import { useEffect, useRef, useState } from 'react'
import type { Activity } from '../types'

// 呼吸节奏：吸气 4 秒、停留 7 秒、呼气 9 秒，循环周期 20 秒。
const BREATH_CYCLE = [
  { name: '吸气', seconds: 4, from: 220, to: 440, copy: '声音缓缓上扬' },
  { name: '停留', seconds: 7, from: 392, to: 392, copy: '声音平稳托住' },
  { name: '呼气', seconds: 9, from: 440, to: 196, copy: '声音慢慢下沉' },
] as const

const PRESET_MINUTES = [3, 5, 10, 15]
const DEFAULT_MINUTES = 5
const CYCLE_SECONDS = BREATH_CYCLE.reduce((sum, phase) => sum + phase.seconds, 0)

type MeditationOutcome = 'completed' | 'cancelled'
type MeditationStatus = 'select' | 'starting' | 'running' | 'finishing' | 'done'

interface MeditationOverlayProps {
  onStart: (minutes: number) => Promise<Activity | null>
  onFinish: (record: Activity, outcome: MeditationOutcome) => Promise<void>
  onClose: () => void
}

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

export function MeditationOverlay({ onStart, onFinish, onClose }: MeditationOverlayProps) {
  const [status, setStatus] = useState<MeditationStatus>('select')
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES)
  const [total, setTotal] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [record, setRecord] = useState<Activity | null>(null)
  const [outcome, setOutcome] = useState<MeditationOutcome>('completed')
  const [error, setError] = useState('')

  const audioContextRef = useRef<AudioContext | null>(null)
  const phaseNodesRef = useRef<OscillatorNode[]>([])
  const lastPhaseRef = useRef(-1)
  const finishingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopPhaseAudio()
      void audioContextRef.current?.close()
    }
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

  function stopPhaseAudio() {
    const context = audioContextRef.current
    const now = context?.currentTime ?? 0
    for (const oscillator of phaseNodesRef.current) {
      try {
        oscillator.stop(now)
      } catch {
        // 已自然结束的节点无需再次处理。
      }
    }
    phaseNodesRef.current = []
  }

  // 用三组走势明确的持续和弦区分呼吸阶段，同时保留柔和听感。
  function playBreathSound(phaseIndex: number) {
    if (muted) return
    try {
      const context = getAudioContext()
      if (!context) return
      if (context.state === 'suspended') void context.resume()
      stopPhaseAudio()

      const phase = BREATH_CYCLE[phaseIndex]
      const now = context.currentTime
      const duration = phase.seconds + 0.35
      const master = context.createGain()
      master.gain.setValueAtTime(0.0001, now)
      master.gain.linearRampToValueAtTime(0.105, now + Math.min(0.8, duration * 0.2))
      master.gain.setValueAtTime(0.105, now + Math.max(1, duration - 0.75))
      master.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      master.connect(context.destination)

      const chord = phaseIndex === 0
        ? [1, 1.5, 2]
        : phaseIndex === 1
          ? [1, 1.25, 1.5]
          : [1, 0.75, 0.5]

      phaseNodesRef.current = chord.map((ratio, index) => {
        const oscillator = context.createOscillator()
        const voiceGain = context.createGain()
        oscillator.type = phaseIndex === 1 ? 'sine' : index === 0 ? 'sine' : 'triangle'
        oscillator.frequency.setValueAtTime(phase.from * ratio, now)
        if (phase.from !== phase.to) {
          oscillator.frequency.exponentialRampToValueAtTime(phase.to * ratio, now + duration * 0.88)
        }
        voiceGain.gain.value = index === 0 ? 0.6 : 0.24
        oscillator.connect(voiceGain)
        voiceGain.connect(master)
        oscillator.start(now)
        oscillator.stop(now + duration + 0.05)
        return oscillator
      })
    } catch {
      // 音频不可用时不影响冥想计时和记录。
    }
  }

  function playFinishChime() {
    if (muted) return
    window.setTimeout(() => playBreathSound(1), 80)
  }

  async function start(selectedMinutes: number) {
    if (status !== 'select') return
    setError('')
    setStatus('starting')
    let created: Activity | null = null
    try {
      created = await onStart(selectedMinutes)
    } catch (startError) {
      if (!mountedRef.current) return
      setError(startError instanceof Error ? startError.message : '冥想记录创建失败')
      setStatus('select')
      return
    }
    if (!mountedRef.current) return
    if (!created) {
      setStatus('select')
      return
    }
    setRecord(created)
    setTotal(selectedMinutes * 60)
    setElapsed(0)
    setPaused(false)
    setStatus('running')
    lastPhaseRef.current = 0
    getAudioContext()
    playBreathSound(0)
  }

  async function finishSession(nextOutcome: MeditationOutcome) {
    if (!record || finishingRef.current) return
    finishingRef.current = true
    setStatus('finishing')
    setPaused(false)
    stopPhaseAudio()
    if (nextOutcome === 'completed') playFinishChime()

    try {
      await onFinish(record, nextOutcome)
      if (!mountedRef.current) return
      setOutcome(nextOutcome)
      setStatus('done')
    } catch (finishError) {
      if (!mountedRef.current) return
      setError(finishError instanceof Error ? finishError.message : '冥想记录保存失败')
      setStatus('running')
    } finally {
      finishingRef.current = false
    }
  }

  // 每秒推进一次；暂停时停掉计时器即可。
  useEffect(() => {
    if (status !== 'running' || paused) return
    const timer = window.setInterval(() => {
      setElapsed((value) => value + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status, paused])

  // 阶段切换时同步更新声音，圆环和页面底色由 CSS 平滑过渡。
  useEffect(() => {
    if (status !== 'running' || paused) return
    const phase = phaseOf(elapsed)
    if (phase !== lastPhaseRef.current) {
      lastPhaseRef.current = phase
      playBreathSound(phase)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, status, paused])

  useEffect(() => {
    if (status !== 'running' || elapsed < total || total === 0) return
    void finishSession('completed')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, status, total])

  useEffect(() => {
    const context = audioContextRef.current
    if (!context || status !== 'running') return
    if (paused) {
      void context.suspend()
    } else {
      void context.resume()
    }
  }, [paused, status])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || status === 'finishing') return
      if (status === 'running') {
        void finishSession('cancelled')
      } else if (status !== 'starting') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, record])

  const phase = status === 'running' || status === 'finishing' ? phaseOf(elapsed) : 0
  const activePhase = BREATH_CYCLE[phase]
  const safeMinutes = Math.min(60, Math.max(1, Math.round(Number(minutes) || DEFAULT_MINUTES)))

  return (
    <div
      className={[
        'meditation-overlay',
        status === 'running' || status === 'finishing' ? `breath-${phase}` : 'breath-neutral',
      ].join(' ')}
      role="dialog"
      aria-modal="true"
      aria-label="冥想"
    >
      <div className="meditation-atmosphere" aria-hidden="true" />

      {status === 'select' && (
        <section className="meditation-panel">
          <div className="meditation-title">
            <span>呼吸练习</span>
            <h2>留一点安静给自己</h2>
          </div>
          <div className="meditation-rhythm">
            {BREATH_CYCLE.map((item) => (
              <span key={item.name}>
                <strong>{item.seconds}</strong>
                <small>{item.name}</small>
              </span>
            ))}
          </div>
          <label className="meditation-duration">
            <span>本次时长</span>
            <span className="meditation-duration-input">
              <input
                aria-label="冥想时长（分钟）"
                type="number"
                inputMode="numeric"
                min={1}
                max={60}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
              <em>分钟</em>
            </span>
          </label>
          {error && <p className="meditation-error" role="alert">{error}</p>}
          <div className="meditation-options" aria-label="常用时长">
            {PRESET_MINUTES.map((value) => (
              <button
                key={value}
                type="button"
                className={safeMinutes === value ? 'is-selected' : ''}
                onClick={() => setMinutes(value)}
              >
                {value} 分钟
              </button>
            ))}
          </div>
          <button
            type="button"
            className="meditation-start primary"
            onClick={() => {
              setMinutes(safeMinutes)
              void start(safeMinutes)
            }}
          >
            开始 {safeMinutes} 分钟冥想
          </button>
          <button type="button" className="meditation-close" onClick={onClose}>稍后再来</button>
        </section>
      )}

      {(status === 'running' || status === 'finishing') && (
        <section className="meditation-session">
          <div className="meditation-phase-copy" aria-live="polite">
            <span>{activePhase.name}</span>
            <small>{activePhase.copy}</small>
          </div>
          <div
            className={[
              'meditation-breath-circle',
              phase === 0 ? 'phase-in' : phase === 1 ? 'phase-hold' : 'phase-out',
              paused || status === 'finishing' ? 'is-paused' : '',
            ].filter(Boolean).join(' ')}
          >
            <span>{activePhase.name}</span>
          </div>
          <p className="meditation-countdown" aria-live="polite">{clockLabel(total - elapsed)}</p>
          {error && <p className="meditation-error" role="alert">{error}</p>}
          <div className="meditation-controls">
            <button type="button" disabled={status === 'finishing'} onClick={() => setPaused((value) => !value)}>
              {paused ? '继续' : '暂停'}
            </button>
            <button
              type="button"
              disabled={status === 'finishing'}
              onClick={() => {
                const nextMuted = !muted
                setMuted(nextMuted)
                if (nextMuted) stopPhaseAudio()
                else playBreathSound(phaseOf(elapsed))
              }}
            >
              {muted ? '开启声音' : '静音'}
            </button>
            <button
              type="button"
              className="meditation-cancel"
              disabled={status === 'finishing'}
              onClick={() => void finishSession('cancelled')}
            >
              {status === 'finishing' ? '保存中' : '取消并记录'}
            </button>
          </div>
        </section>
      )}

      {status === 'starting' && (
        <section className="meditation-panel meditation-loading" aria-live="polite">
          <span className="meditation-loading-ring" aria-hidden="true" />
          <p>正在准备呼吸空间…</p>
        </section>
      )}

      {status === 'done' && (
        <section className="meditation-panel meditation-complete">
          <div className="meditation-complete-mark" aria-hidden="true">✓</div>
          <h2>{outcome === 'completed' ? '完成一次呼吸' : '已结束并记录'}</h2>
          <p>
            {outcome === 'completed'
              ? `本次 ${minutes} 分钟冥想已写入时间记录。`
              : `本次冥想已按 ${clockLabel(elapsed)} 写入时间记录。`}
          </p>
          <div className="meditation-done-actions">
            <button type="button" onClick={() => {
              setRecord(null)
              setTotal(0)
              setElapsed(0)
              lastPhaseRef.current = -1
              setStatus('select')
            }}>再来一次</button>
            <button type="button" className="primary" onClick={onClose}>关闭</button>
          </div>
        </section>
      )}
    </div>
  )
}
