import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

describe('移动端适配要点', () => {
  it('手机端不显示重置按钮', () => {
    expect(css).toMatch(/@media \(max-width: 560px\) \{[\s\S]{0,200}?\.reset-btn \{ display: none;/)
  })

  it('底部面板没有毛玻璃或柔和阴影', () => {
    expect(css).not.toContain('backdrop-filter')
    const composer = css.match(/\.composer \{([^}]*)\}/)
    expect(composer).not.toBeNull()
    expect(composer![1]).not.toContain('box-shadow')
  })

  it('提供可安装到主屏的 manifest 与应用图标', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8'),
    )
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('./')
    expect(manifest.theme_color).toBe('#f5f5f0')
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)
    expect(html).toContain('rel="manifest"')
    expect(html).toContain('apple-touch-icon')
    for (const file of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
      expect(existsSync(resolve(process.cwd(), 'public/icons', file))).toBe(true)
    }
  })

  it('viewport 支持刘海安全区与软键盘压缩内容', () => {
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('interactive-widget=resizes-content')
  })

  it('整页高度使用 dvh，并保留 vh 兜底', () => {
    expect(css).toMatch(/height:\s*100vh;/)
    expect(css).toMatch(/height:\s*100dvh;/)
  })

  it('输入框字号不小于 16px，避免 iOS 聚焦时放大整页', () => {
    expect(css).toMatch(/\.composer-form input \{[\s\S]{0,400}?font-size:\s*16px/)
    expect(css).toMatch(/\.auth-panel input \{[\s\S]{0,400}?font-size:\s*16px/)
  })

  it('底部记录区限高并可内部滚动，快捷键再多也挤不掉记录列表', () => {
    expect(css).toMatch(/\.composer \{[\s\S]{0,600}?max-height:\s*56dvh/)
    expect(css).toMatch(/\.composer \{[\s\S]{0,600}?overflow-y:\s*auto/)
  })

  it('安全区使用 env(safe-area-inset)', () => {
    expect(css).toContain('env(safe-area-inset-top)')
    expect(css).toContain('env(safe-area-inset-bottom)')
  })

  it('删除层没有红色底色，只保留红字', () => {
    expect(css).toMatch(/\.record-row \{[\s\S]{0,240}?background:\s*var\(--surface\)/)
    expect(css).toMatch(/\.row-delete \{[\s\S]{0,240}?background:\s*transparent/)
  })

  it('记录时间贴近右下角', () => {
    expect(css).toMatch(/\.row-meta \{[\s\S]{0,120}?right:\s*10px/)
    expect(css).toMatch(/\.row-meta \{[\s\S]{0,120}?bottom:\s*5px/)
  })

  it('底部记录区不做毛玻璃，避免背景透上来发糊', () => {
    expect(css).not.toContain('backdrop-filter')
    expect(css).toMatch(/\.composer \{[\s\S]{0,400}?background:\s*var\(--surface\)/)
  })

  it('左滑走合成层，拖动时关闭过渡避免卡顿', () => {
    expect(css).toMatch(/\.row-surface \{[\s\S]{0,600}?will-change:\s*transform/)
    expect(css).toMatch(/\.row-surface\.dragging \{[\s\S]{0,120}?transition:\s*none/)
  })

  it('主屏启动使用 Service Worker 缓存和静态加载壳', () => {
    expect(html).toContain('navigator.serviceWorker.register')
    expect(html).toContain('app-loading')
    expect(existsSync(resolve(process.cwd(), 'public/sw.js'))).toBe(true)
  })
})
