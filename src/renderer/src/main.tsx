import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
import { routeInfo } from './api'
import { ThemeRoot } from './theme'
import './styles.css'

const MainApp = lazy(() => import('./MainApp'))
const CallApp = lazy(() => import('./call/CallApp'))
const PopoutApp = lazy(() => import('./call/PopoutApp'))
const IncomingApp = lazy(() => import('./call/IncomingApp'))

function Root(): JSX.Element {
  const { path } = routeInfo()
  document.body.dataset.route = path.replace('/', '')
  if (path === '/call') return <ThemeRoot force="dark"><CallApp /></ThemeRoot>
  if (path === '/popout') return <ThemeRoot force="dark"><PopoutApp /></ThemeRoot>
  if (path === '/incoming') return <ThemeRoot force="dark"><IncomingApp /></ThemeRoot>
  return <ThemeRoot><MainApp /></ThemeRoot>
}

createRoot(document.getElementById('root')!).render(
  <Suspense fallback={null}>
    <Root />
  </Suspense>
)
