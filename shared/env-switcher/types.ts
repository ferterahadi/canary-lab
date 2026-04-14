export type SlotDefinition = {
  description: string;
  target: string; // may contain $VAR tokens referencing appRoots
};

export type FeatureDefinition = {
  slots: string[]; // slot names this feature uses
  testCommand: string;
  testCwd: string; // may contain $VAR tokens referencing appRoots
};

export type EnvSetsConfig = {
  appRoots: Record<string, string>;
  slots: Record<string, SlotDefinition>;
  feature: FeatureDefinition;
};

export type BackupRecord = {
  originalPath: string;
  backupPath: string;
};
