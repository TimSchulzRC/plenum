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

// Menüs, Popups und Fluent-Knöpfe im selben Farbschema wie die übrige Oberfläche
export const lightTheme: Theme = {
  ...teamsLightTheme,
  ...shape,
  colorNeutralBackground1: '#ffffff',
  colorNeutralBackground1Hover: '#f3f3f7',
  colorNeutralBackground1Pressed: '#ebebf1',
  colorNeutralBackground1Selected: '#eeeef6',
  colorNeutralForeground1: '#1d1d22',
  colorNeutralForeground2: '#3d3d46',
  colorNeutralForeground3: '#6b6b76',
  colorNeutralStroke1: 'rgba(20, 20, 40, 0.16)',
  colorNeutralStroke2: 'rgba(20, 20, 40, 0.1)',
  shadow16: '0 12px 32px rgba(15, 15, 30, 0.16), 0 0 0 1px rgba(15, 15, 30, 0.06)'
}

export const darkTheme: Theme = {
  ...teamsDarkTheme,
  ...shape,
  colorNeutralBackground1: '#2a2a30',
  colorNeutralBackground1Hover: '#32323a',
  colorNeutralBackground1Pressed: '#383840',
  colorNeutralBackground1Selected: '#34343c',
  colorNeutralBackground2: '#242429',
  colorNeutralBackground3: '#1d1d21',
  colorNeutralBackground4: '#18181b',
  colorNeutralForeground1: '#f1f1f4',
  colorNeutralForeground2: '#cfcfd6',
  colorNeutralForeground3: '#9898a3',
  colorNeutralStroke1: 'rgba(255, 255, 255, 0.14)',
  colorNeutralStroke2: 'rgba(255, 255, 255, 0.09)',
  colorNeutralStroke3: 'rgba(255, 255, 255, 0.06)',
  colorSubtleBackgroundHover: 'rgba(255, 255, 255, 0.06)',
  colorSubtleBackgroundPressed: 'rgba(255, 255, 255, 0.09)',
  colorBrandBackground: '#6366e0',
  colorBrandBackgroundHover: '#7275ea',
  colorBrandBackgroundPressed: '#5558cc',
  colorBrandForeground1: '#a6a9ff',
  colorCompoundBrandStroke: '#a6a9ff',
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
