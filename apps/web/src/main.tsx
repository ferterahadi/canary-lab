import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RunsProvider } from './state/RunsContext'
import { EvaluationExportProvider } from './state/EvaluationExportContext'
import { WizardDraftProvider } from './state/WizardDraftContext'
import { McpPromoProvider } from './state/McpPromoContext'
import { bootstrapTheme } from './lib/theme'
import './styles.css'

bootstrapTheme()
const container = document.getElementById('root')
if (!container) throw new Error('root element missing')
createRoot(container).render(
  <React.StrictMode>
    <RunsProvider>
      <WizardDraftProvider>
        <McpPromoProvider>
          <EvaluationExportProvider>
            <App />
          </EvaluationExportProvider>
        </McpPromoProvider>
      </WizardDraftProvider>
    </RunsProvider>
  </React.StrictMode>,
)
