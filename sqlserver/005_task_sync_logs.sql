IF OBJECT_ID(N'taskboard.task_sync_logs', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.task_sync_logs (
        sync_id UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_taskboard_task_sync_logs_id DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_taskboard_task_sync_logs PRIMARY KEY,
        project_id UNIQUEIDENTIFIER NOT NULL,
        operator_user_id UNIQUEIDENTIFIER NOT NULL,
        local_project_id NVARCHAR(200) NULL,
        task_count INT NOT NULL CONSTRAINT DF_taskboard_task_sync_logs_task_count DEFAULT 0,
        imported_count INT NOT NULL CONSTRAINT DF_taskboard_task_sync_logs_imported DEFAULT 0,
        updated_count INT NOT NULL CONSTRAINT DF_taskboard_task_sync_logs_updated DEFAULT 0,
        failed_count INT NOT NULL CONSTRAINT DF_taskboard_task_sync_logs_failed DEFAULT 0,
        sync_status NVARCHAR(20) NOT NULL,
        error_message NVARCHAR(MAX) NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_task_sync_logs_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_taskboard_task_sync_logs_status CHECK (sync_status IN (N'success', N'failed')),
        CONSTRAINT FK_taskboard_task_sync_logs_project FOREIGN KEY (project_id)
            REFERENCES taskboard.projects (project_id),
        CONSTRAINT FK_taskboard_task_sync_logs_operator FOREIGN KEY (operator_user_id)
            REFERENCES taskboard.users (user_id)
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_task_sync_logs_project_created' AND object_id = OBJECT_ID(N'taskboard.task_sync_logs'))
BEGIN
    CREATE INDEX IX_taskboard_task_sync_logs_project_created
      ON taskboard.task_sync_logs (project_id, created_at DESC, sync_id);
END;
GO
