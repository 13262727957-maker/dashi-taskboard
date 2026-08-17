/*
 * Taskboard identity and project collaboration schema for Microsoft SQL Server.
 * This migration is intentionally separate from the existing local SQLite store.
 * It can be applied to an existing company database without changing business tables.
 */

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'taskboard')
    EXEC(N'CREATE SCHEMA taskboard');
GO

IF OBJECT_ID(N'taskboard.users', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.users (
        user_id UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_taskboard_users_user_id DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_taskboard_users PRIMARY KEY,
        employee_no NVARCHAR(50) NOT NULL,
        display_name NVARCHAR(100) NOT NULL,
        email NVARCHAR(255) NULL,
        department NVARCHAR(200) NULL,
        job_title NVARCHAR(200) NULL,
        account_status NVARCHAR(20) NOT NULL CONSTRAINT DF_taskboard_users_status DEFAULT N'pending',
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_users_created DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_users_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_taskboard_users_employee_no UNIQUE (employee_no),
        CONSTRAINT CK_taskboard_users_status CHECK (account_status IN (N'pending', N'active', N'disabled'))
    );
END;
GO

IF OBJECT_ID(N'taskboard.employee_directory', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.employee_directory (
        employee_no NVARCHAR(50) NOT NULL CONSTRAINT PK_taskboard_employee_directory PRIMARY KEY,
        display_name NVARCHAR(100) NOT NULL,
        email NVARCHAR(255) NULL,
        department NVARCHAR(200) NULL,
        job_title NVARCHAR(200) NULL,
        is_active BIT NOT NULL CONSTRAINT DF_taskboard_employee_active DEFAULT 1,
        source_file_name NVARCHAR(260) NULL,
        imported_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_employee_imported DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_employee_updated DEFAULT SYSUTCDATETIME()
    );
END;
GO

IF OBJECT_ID(N'taskboard.projects', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.projects (
        project_id UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_taskboard_projects_id DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_taskboard_projects PRIMARY KEY,
        project_code NVARCHAR(50) NOT NULL,
        project_name NVARCHAR(200) NOT NULL,
        workspace_path NVARCHAR(1000) NULL,
        description NVARCHAR(1000) NULL,
        owner_user_id UNIQUEIDENTIFIER NOT NULL,
        is_archived BIT NOT NULL CONSTRAINT DF_taskboard_projects_archived DEFAULT 0,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_projects_created DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_projects_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_taskboard_projects_code UNIQUE (project_code),
        CONSTRAINT FK_taskboard_projects_owner FOREIGN KEY (owner_user_id)
            REFERENCES taskboard.users (user_id)
    );
END;
GO

IF OBJECT_ID(N'taskboard.project_members', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.project_members (
        member_id UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_taskboard_project_members_id DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_taskboard_project_members PRIMARY KEY,
        project_id UNIQUEIDENTIFIER NOT NULL,
        user_id UNIQUEIDENTIFIER NOT NULL,
        project_role NVARCHAR(20) NOT NULL,
        joined_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_project_members_joined DEFAULT SYSUTCDATETIME(),
        is_active BIT NOT NULL CONSTRAINT DF_taskboard_project_members_active DEFAULT 1,
        CONSTRAINT UQ_taskboard_project_members UNIQUE (project_id, user_id),
        CONSTRAINT CK_taskboard_project_members_role CHECK (project_role IN (N'owner', N'developer')),
        CONSTRAINT FK_taskboard_project_members_project FOREIGN KEY (project_id)
            REFERENCES taskboard.projects (project_id),
        CONSTRAINT FK_taskboard_project_members_user FOREIGN KEY (user_id)
            REFERENCES taskboard.users (user_id)
    );
END;
GO

IF OBJECT_ID(N'taskboard.task_cards', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.task_cards (
        task_id UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_taskboard_task_cards_id DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_taskboard_task_cards PRIMARY KEY,
        project_id UNIQUEIDENTIFIER NOT NULL,
        task_key NVARCHAR(50) NOT NULL,
        title NVARCHAR(300) NOT NULL,
        description NVARCHAR(MAX) NULL,
        status NVARCHAR(20) NOT NULL CONSTRAINT DF_taskboard_task_cards_status DEFAULT N'todo',
        priority NVARCHAR(20) NOT NULL CONSTRAINT DF_taskboard_task_cards_priority DEFAULT N'normal',
        assignee_user_id UNIQUEIDENTIFIER NULL,
        created_by_user_id UNIQUEIDENTIFIER NOT NULL,
        started_at DATETIME2(3) NULL,
        completed_at DATETIME2(3) NULL,
        due_at DATETIME2(3) NULL,
        version_no INT NOT NULL CONSTRAINT DF_taskboard_task_cards_version DEFAULT 1,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_task_cards_created DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_task_cards_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_taskboard_task_cards_key UNIQUE (project_id, task_key),
        CONSTRAINT CK_taskboard_task_cards_status CHECK (status IN (N'todo', N'in_progress', N'in_review', N'blocked', N'done', N'canceled')),
        CONSTRAINT CK_taskboard_task_cards_priority CHECK (priority IN (N'low', N'normal', N'high', N'urgent')),
        CONSTRAINT FK_taskboard_task_cards_project FOREIGN KEY (project_id)
            REFERENCES taskboard.projects (project_id),
        CONSTRAINT FK_taskboard_task_cards_assignee FOREIGN KEY (assignee_user_id)
            REFERENCES taskboard.users (user_id),
        CONSTRAINT FK_taskboard_task_cards_creator FOREIGN KEY (created_by_user_id)
            REFERENCES taskboard.users (user_id)
    );
END;
GO

IF OBJECT_ID(N'taskboard.task_events', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.task_events (
        event_id BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_taskboard_task_events PRIMARY KEY,
        task_id UNIQUEIDENTIFIER NOT NULL,
        project_id UNIQUEIDENTIFIER NOT NULL,
        event_type NVARCHAR(40) NOT NULL,
        from_value NVARCHAR(MAX) NULL,
        to_value NVARCHAR(MAX) NULL,
        operator_user_id UNIQUEIDENTIFIER NOT NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_task_events_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_taskboard_task_events_task FOREIGN KEY (task_id)
            REFERENCES taskboard.task_cards (task_id),
        CONSTRAINT FK_taskboard_task_events_project FOREIGN KEY (project_id)
            REFERENCES taskboard.projects (project_id),
        CONSTRAINT FK_taskboard_task_events_operator FOREIGN KEY (operator_user_id)
            REFERENCES taskboard.users (user_id)
    );
END;
GO

IF OBJECT_ID(N'taskboard.agent_runs', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.agent_runs (
        run_id UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT DF_taskboard_agent_runs_id DEFAULT NEWSEQUENTIALID()
            CONSTRAINT PK_taskboard_agent_runs PRIMARY KEY,
        task_id UNIQUEIDENTIFIER NOT NULL,
        project_id UNIQUEIDENTIFIER NOT NULL,
        triggered_by_user_id UNIQUEIDENTIFIER NOT NULL,
        executor_type NVARCHAR(30) NOT NULL,
        status NVARCHAR(20) NOT NULL CONSTRAINT DF_taskboard_agent_runs_status DEFAULT N'queued',
        lease_owner NVARCHAR(255) NULL,
        lease_until DATETIME2(3) NULL,
        heartbeat_at DATETIME2(3) NULL,
        retry_count INT NOT NULL CONSTRAINT DF_taskboard_agent_runs_retry DEFAULT 0,
        started_at DATETIME2(3) NULL,
        finished_at DATETIME2(3) NULL,
        summary NVARCHAR(MAX) NULL,
        error_message NVARCHAR(MAX) NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_agent_runs_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_taskboard_agent_runs_executor CHECK (executor_type IN (N'codex', N'automation', N'manual')),
        CONSTRAINT CK_taskboard_agent_runs_status CHECK (status IN (N'queued', N'running', N'succeeded', N'failed', N'cancelled')),
        CONSTRAINT FK_taskboard_agent_runs_task FOREIGN KEY (task_id)
            REFERENCES taskboard.task_cards (task_id),
        CONSTRAINT FK_taskboard_agent_runs_project FOREIGN KEY (project_id)
            REFERENCES taskboard.projects (project_id),
        CONSTRAINT FK_taskboard_agent_runs_triggered_by FOREIGN KEY (triggered_by_user_id)
            REFERENCES taskboard.users (user_id)
    );
END;
GO

IF OBJECT_ID(N'taskboard.user_sessions', N'U') IS NULL
BEGIN
    CREATE TABLE taskboard.user_sessions (
        session_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_taskboard_user_sessions PRIMARY KEY
            CONSTRAINT DF_taskboard_user_sessions_id DEFAULT NEWSEQUENTIALID(),
        user_id UNIQUEIDENTIFIER NOT NULL,
        token_hash VARCHAR(64) NOT NULL,
        expires_at DATETIME2(3) NOT NULL,
        created_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_user_sessions_created DEFAULT SYSUTCDATETIME(),
        last_seen_at DATETIME2(3) NOT NULL CONSTRAINT DF_taskboard_user_sessions_last_seen DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_taskboard_user_sessions_token UNIQUE (token_hash),
        CONSTRAINT FK_taskboard_user_sessions_user FOREIGN KEY (user_id)
            REFERENCES taskboard.users (user_id) ON DELETE CASCADE
    );
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_project_members_user' AND object_id = OBJECT_ID(N'taskboard.project_members'))
    CREATE INDEX IX_taskboard_project_members_user ON taskboard.project_members (user_id, is_active, project_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_task_cards_project_status' AND object_id = OBJECT_ID(N'taskboard.task_cards'))
    CREATE INDEX IX_taskboard_task_cards_project_status ON taskboard.task_cards (project_id, status, updated_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_task_cards_assignee' AND object_id = OBJECT_ID(N'taskboard.task_cards'))
    CREATE INDEX IX_taskboard_task_cards_assignee ON taskboard.task_cards (assignee_user_id, status, updated_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_task_events_task_created' AND object_id = OBJECT_ID(N'taskboard.task_events'))
    CREATE INDEX IX_taskboard_task_events_task_created ON taskboard.task_events (task_id, created_at, event_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_agent_runs_task_created' AND object_id = OBJECT_ID(N'taskboard.agent_runs'))
    CREATE INDEX IX_taskboard_agent_runs_task_created ON taskboard.agent_runs (task_id, created_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_taskboard_user_sessions_user' AND object_id = OBJECT_ID(N'taskboard.user_sessions'))
    CREATE INDEX IX_taskboard_user_sessions_user ON taskboard.user_sessions (user_id, expires_at);
GO
