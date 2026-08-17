IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_taskboard_project_members_active_owner' AND object_id = OBJECT_ID(N'taskboard.project_members'))
BEGIN
    CREATE UNIQUE INDEX UX_taskboard_project_members_active_owner
      ON taskboard.project_members (project_id)
      WHERE is_active = 1 AND project_role = N'owner';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_taskboard_task_cards_project_task' AND object_id = OBJECT_ID(N'taskboard.task_cards'))
    CREATE UNIQUE INDEX UQ_taskboard_task_cards_project_task ON taskboard.task_cards (project_id, task_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_taskboard_task_events_project_task')
BEGIN
    ALTER TABLE taskboard.task_events
      ADD CONSTRAINT FK_taskboard_task_events_project_task
      FOREIGN KEY (project_id, task_id)
      REFERENCES taskboard.task_cards (project_id, task_id);
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_taskboard_agent_runs_project_task')
BEGIN
    ALTER TABLE taskboard.agent_runs
      ADD CONSTRAINT FK_taskboard_agent_runs_project_task
      FOREIGN KEY (project_id, task_id)
      REFERENCES taskboard.task_cards (project_id, task_id);
END;
GO
