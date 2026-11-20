import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { registerSw } from './Mobile'

registerSw()

createRoot(document.getElementById('root')!).render(<App />)
