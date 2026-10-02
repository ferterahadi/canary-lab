export type BackupRecord = {
  originalPath: string;
  // null records prior absence; teardown removes only that run-created target.
  backupPath: string | null;
};
