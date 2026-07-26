// Public surface of the `config` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export {
  BranchSuggestInput,
  branchSuggestions,
  useRepoGitStatus,
} from './components/BranchSuggestInput'
export { DeleteSuiteConfirm } from './components/DeleteSuiteConfirm'
export { FeatureConfigEditor } from './components/FeatureConfigEditor'
export {
  FolderPicker,
  FolderPickerModal,
} from './components/FolderPicker'
export { SettingsModal } from './components/SettingsModal'
