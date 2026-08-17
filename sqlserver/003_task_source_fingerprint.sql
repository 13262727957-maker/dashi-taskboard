IF COL_LENGTH(N'taskboard.task_cards', N'source_fingerprint') IS NULL
BEGIN
    ALTER TABLE taskboard.task_cards ADD source_fingerprint VARCHAR(64) NULL;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_taskboard_task_cards_source_fingerprint' AND object_id = OBJECT_ID(N'taskboard.task_cards'))
BEGIN
    CREATE UNIQUE INDEX UX_taskboard_task_cards_source_fingerprint
      ON taskboard.task_cards (project_id, source_fingerprint)
      WHERE source_fingerprint IS NOT NULL;
END;
GO
