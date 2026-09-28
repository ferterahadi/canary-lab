export type { SlotDefinition, FeatureDefinition, EnvSetsConfig } from '../../../../config/logic/envset-runtime';

export type BackupRecord = {
  originalPath: string;
  // null records prior absence; teardown removes only that run-created target.
  backupPath: string | null;
};
