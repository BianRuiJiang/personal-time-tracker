import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeditationOverlay } from '../src/components/MeditationOverlay'
import type { Activity } from '../src/types'

const record: Activity = {
  id: 'meditation-id',
  user_id: 'user-id',
  name: '冥想 1 分钟',
  started_at: '2026-11-03T10:00:00.000Z',
  ended_at: null,
  source: 'manual',
  metadata: {},
  created_at: '2026-11-03T10:00:00.000Z',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('冥想记录', () => {
  it('倒计时结束后自动把冥想标记为完成', async () => {
    vi.useFakeTimers()
    const onFinish = vi.fn().mockResolvedValue(undefined)
    render(
      <MeditationOverlay
        onStart={vi.fn().mockResolvedValue(record)}
        onFinish={onFinish}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('冥想时长（分钟）'), { target: { value: '1' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始 1 分钟冥想' }))
      await Promise.resolve()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(screen.getByRole('progressbar', { name: '本次冥想进度' }))
      .toHaveAttribute('aria-valuenow', '50')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(onFinish).toHaveBeenCalledWith(record, 'completed')
    expect(screen.getByText('完成一次呼吸')).toBeInTheDocument()
  })
})
