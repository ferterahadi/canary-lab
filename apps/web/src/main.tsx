import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RunsProvider } from './state/RunsContext'
import { bootstrapTheme } from './lib/theme'
import './styles.css'

bootstrapTheme()
const container = document.getElementById('root')
if (!container) throw new Error('root element missing')
createRoot(container).render(
  <React.StrictMode>
    <RunsProvider>
      <App />
    </RunsProvider>
  </React.StrictMode>,
)
