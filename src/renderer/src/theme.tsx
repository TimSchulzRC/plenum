import { FluentProvider, teamsDarkTheme, teamsLightTheme, type Theme } from '@fluentui/react-components'
import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings } from '@shared/types'
import { api, onEvent } from './api'

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif"

const shape: Partial<Theme> = {
  fontFamilyBase: FONT,
  borderRadiusMedium: '8px',
  borderRadiusLarge: '10px',
  borderRadiusXLarge: '12px'
}

// Menüs, Popups und Fluent-Knöpfe nutzen die Teams-Themes von Fluent unverändert,
// nur die Ecken sind runder. Die Farben in styles.css stammen aus denselben Themes.
export const lightTheme: Theme = {
  ...teamsLightTheme,
  ...shape,
  shadow16: '0 12px 32px rgba(0, 0, 0, 0.16), 0 0 0 1px rgba(0, 0, 0, 0.06)'
}

export const darkTheme: Theme = {
  ...teamsDarkTheme,
  ...shape,
  shadow16: '0 16px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06)'
}

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useDarkMode(force?: 'dark' | 'light'): boolean {
  const [pref, setPref] = useState<AppSettings['theme']>('system')
  const [sys, setSys] = useState(systemDark())
  useEffect(() => {
    void api.getSettings().then((s) => setPref(s.theme))
    const off = onEvent('settings', (s) => setPref(s.theme))
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => setSys(mq.matches)
    mq.addEventListener('change', h)
    return () => {
      off()
      mq.removeEventListener('change', h)
    }
  }, [])
  if (force) return force === 'dark'
  return pref === 'dark' || (pref === 'system' && sys)
}

export function ThemeRoot({ children, force }: { children: ReactNode; force?: 'dark' | 'light' }): JSX.Element {
  const dark = useDarkMode(force)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  return (
    // Layout-Stile über style statt className: Fluent kopiert die Klasse auf Portal-Container (Menüs, Tooltips).
    <FluentProvider theme={dark ? darkTheme : lightTheme} style={{ height: '100%', background: 'transparent', fontFamily: 'var(--font)' }}>
      {children}
    </FluentProvider>
  )
}
