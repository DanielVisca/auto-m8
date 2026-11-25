import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { Explore } from './Explore'
import { Canvas } from './Canvas'
import { registerSw } from './Mobile'
import { startTracing } from './tracing'

registerSw()
startTracing()

// ?popout=explore: the architecture explorer on its own, in a separate window. Opening a chat from it
// goes to the main window (the app's shell routes it there).
const popout = new URLSearchParams(location.search).get('popout') === 'explore'
const repoFromHash = () => { const [k, id] = location.hash.slice(1).split('/'); return k === 'explore' && id ? decodeURIComponent(id) : undefined }

// ?thumb=<board id>: the board alone, for the preview the app captures offscreen. No activity pings.
const thumb = new URLSearchParams(location.search).get('thumb')
const thumbTheme = new URLSearchParams(location.search).get('theme')
if (thumb && (thumbTheme === 'dark' || thumbTheme === 'light')) document.documentElement.dataset.theme = thumbTheme

createRoot(document.getElementById('root')!).render(thumb
  ? <div className="board-thumb-root"><Canvas folderId={thumb} ttlSeconds={null} conversations={[]} onOpen={() => {}} /></div>
  : popout
  ? <div className="explore-popout"><Explore popout initialRepo={repoFromHash()} onOpenChat={id => window.open(`${location.origin.replace('localhost', '127.0.0.1')}/#chat/${encodeURIComponent(id)}`, '_blank')} /></div>
  : <App />)
