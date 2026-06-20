import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RunsProvider } from './features/runs/state/RunsContext'
import { BenchmarkProvider } from './state/BenchmarkContext'
import { PortifyProvider } from './features/portify/state/PortifyContext'
import { EvaluationExportProvider } from './features/evaluation-export/state/EvaluationExportContext'
import { WizardDraftProvider } from './features/wizard/state/WizardDraftContext'
import { McpPromoProvider } from './state/McpPromoContext'
import { bootstrapTheme } from './lib/theme'
import './styles.css'

bootstrapTheme()
const container = document.getElementById('root')
if (!container) throw new Error('root element missing')
createRoot(container).render(
  <React.StrictMode>
    <RunsProvider>
      <BenchmarkProvider>
        <PortifyProvider>
          <WizardDraftProvider>
            <McpPromoProvider>
              <EvaluationExportProvider>
                <App />
              </EvaluationExportProvider>
            </McpPromoProvider>
          </WizardDraftProvider>
        </PortifyProvider>
      </BenchmarkProvider>
    </RunsProvider>
  </React.StrictMode>,
)
