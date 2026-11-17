import { createRoot } from 'octane'
import App from './App.btsx'
import './style.css'
import './styles/site.css'
import { useUIStore } from './lib/store/uiStore'
import { applyTheme } from './lib/theme'
import { startConvexAuthSync } from './lib/convex/client'

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app container.')

// Saved preferences load with the store, so the first paint already has the theme.
applyTheme(useUIStore.getState().theme)
startConvexAuthSync()

createRoot(container).render(App, { docsUrl: 'https://beast-docs.vercel.app' })
