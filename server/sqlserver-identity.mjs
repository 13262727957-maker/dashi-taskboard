import { createHash, randomBytes, randomUUID } from "node:crypto";
import sql from "mssql";

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function legacyTaskFingerprint(input) {
  return createHash("sha256")
    .update(`${String(input.title ?? "").trim()}\n${String(input.description ?? "").trim()}`)
    .digest("hex");
}

function taskFingerprint(input) {
  return input.sourceId
    ? createHash("sha256").update(`source:${String(input.sourceId).trim()}`).digest("hex")
    : legacyTaskFingerprint(input);
}

async function acquireProjectTaskLock(transaction, projectId) {
  const lock = await transaction.request()
    .input("resource", sql.NVarChar(255), `taskboard.project-tasks:${projectId}`)
    .query(`
      DECLARE @lockResult INT;
      EXEC @lockResult = sp_getapplock
        @Resource = @resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 15000;
      SELECT @lockResult AS lock_result;
    `);
  if (lock.recordset[0]?.lock_result < 0) {
    throw new Error("当前项目正在提交任务卡片，请稍后重试");
  }
}

async function nextProjectTaskKey(transaction, projectId, prefix) {
  const taskNumber = await transaction.request()
    .input("projectId", sql.UniqueIdentifier, projectId)
    .query(`
      SELECT COUNT(*) + 1 AS next_number
      FROM taskboard.task_cards WITH (UPDLOCK, HOLDLOCK)
      WHERE project_id = @projectId;
    `);
  return `${prefix}-${String(taskNumber.recordset[0].next_number).padStart(3, "0")}`;
}

async function dedupeProjectTaskCards(transaction, projectId, userId) {
  const result = await transaction.request()
    .input("projectId", sql.UniqueIdentifier, projectId)
    .input("userId", sql.UniqueIdentifier, userId)
    .query(`
      DECLARE @merged TABLE (
        duplicate_task_id UNIQUEIDENTIFIER NOT NULL,
        keeper_task_id UNIQUEIDENTIFIER NOT NULL
      );

      WITH ranked AS (
        SELECT
          t.task_id,
          FIRST_VALUE(t.task_id) OVER (
            PARTITION BY CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', CONCAT(LTRIM(RTRIM(t.title)), N'\n', LTRIM(RTRIM(COALESCE(t.description, N''))))), 2)
            ORDER BY
              CASE WHEN t.source_fingerprint IS NOT NULL THEN 0 ELSE 1 END,
              t.updated_at DESC,
              t.task_id
          ) AS keeper_task_id,
          ROW_NUMBER() OVER (
            PARTITION BY CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', CONCAT(LTRIM(RTRIM(t.title)), N'\n', LTRIM(RTRIM(COALESCE(t.description, N''))))), 2)
            ORDER BY
              CASE WHEN t.source_fingerprint IS NOT NULL THEN 0 ELSE 1 END,
              t.updated_at DESC,
              t.task_id
          ) AS dedupe_rank
        FROM taskboard.task_cards t WITH (UPDLOCK, HOLDLOCK)
        WHERE t.project_id = @projectId
      )
      INSERT INTO @merged (duplicate_task_id, keeper_task_id)
      SELECT task_id, keeper_task_id
      FROM ranked
      WHERE dedupe_rank > 1;

      UPDATE e
      SET task_id = m.keeper_task_id
      FROM taskboard.task_events e
      INNER JOIN @merged m ON m.duplicate_task_id = e.task_id
      WHERE e.project_id = @projectId;

      UPDATE r
      SET task_id = m.keeper_task_id
      FROM taskboard.agent_runs r
      INNER JOIN @merged m ON m.duplicate_task_id = r.task_id
      WHERE r.project_id = @projectId;

      INSERT INTO taskboard.task_events
        (task_id, project_id, event_type, from_value, to_value, operator_user_id)
      SELECT DISTINCT
        m.keeper_task_id,
        @projectId,
        N'deduped',
        CONVERT(NVARCHAR(36), m.duplicate_task_id),
        CONVERT(NVARCHAR(36), m.keeper_task_id),
        @userId
      FROM @merged m;

      DELETE t
      FROM taskboard.task_cards t
      INNER JOIN @merged m ON m.duplicate_task_id = t.task_id
      WHERE t.project_id = @projectId;

      SELECT COUNT(*) AS deduped FROM @merged;
    `);
  return Number(result.recordset[0]?.deduped ?? 0);
}

async function writeTaskSyncLog(connection, input) {
  await connection.request()
    .input("syncId", sql.UniqueIdentifier, input.syncId)
    .input("projectId", sql.UniqueIdentifier, input.projectId)
    .input("operatorUserId", sql.UniqueIdentifier, input.userId)
    .input("localProjectId", sql.NVarChar(200), input.localProjectId ?? null)
    .input("taskCount", sql.Int, input.taskCount ?? 0)
    .input("importedCount", sql.Int, input.imported ?? 0)
    .input("updatedCount", sql.Int, input.updated ?? 0)
    .input("failedCount", sql.Int, input.failed ?? 0)
    .input("syncStatus", sql.NVarChar(20), input.status)
    .input("errorMessage", sql.NVarChar(sql.MAX), input.error ?? null)
    .query(`
      INSERT INTO taskboard.task_sync_logs (
        sync_id, project_id, operator_user_id, local_project_id, task_count,
        imported_count, updated_count, failed_count, sync_status, error_message
      )
      VALUES (
        @syncId, @projectId, @operatorUserId, @localProjectId, @taskCount,
        @importedCount, @updatedCount, @failedCount, @syncStatus, @errorMessage
      );
    `);
}

function userFromRow(row) {
  return {
    id: row.user_id,
    employeeNo: row.employee_no,
    displayName: row.display_name,
    email: row.email,
    department: row.department,
    jobTitle: row.job_title,
    accountStatus: row.account_status,
  };
}

function employeeFromRow(row) {
  return {
    employeeNo: row.employee_no,
    displayName: row.display_name,
    email: row.email,
    department: row.department,
    jobTitle: row.job_title,
    isActive: Boolean(row.is_active),
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

export class SqlServerIdentityStore {
  constructor(config) {
    this.config = config;
    this.poolPromise = null;
  }

  async pool() {
    if (!this.poolPromise) {
      this.poolPromise = sql.connect(this.config).catch((error) => {
        this.poolPromise = null;
        throw error;
      });
    }
    return this.poolPromise;
  }

  async status() {
    const pool = await this.pool();
    const result = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM taskboard.users) AS user_count,
        (SELECT COUNT(*) FROM taskboard.employee_directory) AS employee_count;
    `);
    const row = result.recordset[0];
    return {
      configured: true,
      initialized: true,
      userCount: Number(row.user_count),
      employeeCount: Number(row.employee_count),
    };
  }

  async registerDeveloper(employeeNo, displayName) {
    const pool = await this.pool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const normalizedEmployeeNo = String(employeeNo).trim();
      const normalizedDisplayName = String(displayName).trim();
      const employeeResult = await transaction.request()
        .input("employeeNo", sql.NVarChar(50), normalizedEmployeeNo)
        .query("SELECT * FROM taskboard.employee_directory WHERE employee_no = @employeeNo");
      let employee = employeeResult.recordset[0];
      if (!employee) {
        await transaction.request()
          .input("employeeNo", sql.NVarChar(50), normalizedEmployeeNo)
          .input("displayName", sql.NVarChar(100), normalizedDisplayName)
          .query(`
            INSERT INTO taskboard.employee_directory
              (employee_no, display_name, is_active, source_file_name)
            VALUES
              (@employeeNo, @displayName, 1, N'自助登记');
          `);
        employee = {
          employee_no: normalizedEmployeeNo,
          display_name: normalizedDisplayName,
          email: null,
          department: null,
          job_title: null,
          is_active: true,
        };
      }
      if (!employee.is_active) throw new Error("该工号已离职或停用");
      if (employee.display_name !== normalizedDisplayName) throw new Error("姓名与该工号不匹配");

      const userResult = await transaction.request()
        .input("employeeNo", sql.NVarChar(50), normalizedEmployeeNo)
        .query("SELECT * FROM taskboard.users WHERE employee_no = @employeeNo");
      const existingUser = userResult.recordset[0];
      let userId = existingUser?.user_id;
      if (!userId) {
        userId = randomUUID();
        await transaction.request()
          .input("userId", sql.UniqueIdentifier, userId)
          .input("employeeNo", sql.NVarChar(50), normalizedEmployeeNo)
          .input("displayName", sql.NVarChar(100), normalizedDisplayName)
          .input("email", sql.NVarChar(255), employee?.email ?? null)
          .input("department", sql.NVarChar(200), employee?.department ?? null)
          .input("jobTitle", sql.NVarChar(200), employee?.job_title ?? null)
          .query(`
            INSERT INTO taskboard.users
              (user_id, employee_no, display_name, email, department, job_title, account_status)
            VALUES
              (@userId, @employeeNo, @displayName, @email, @department, @jobTitle, N'active');
          `);
      } else {
        await transaction.request()
          .input("userId", sql.UniqueIdentifier, userId)
          .input("displayName", sql.NVarChar(100), employee?.display_name ?? normalizedDisplayName)
          .query("UPDATE taskboard.users SET account_status = N'active', display_name = @displayName, updated_at = SYSUTCDATETIME() WHERE user_id = @userId");
      }
      await transaction.commit();
      return this.createSessionForUser(userId);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async createSessionForUser(userId) {
    const pool = await this.pool();
    const result = await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .query("SELECT * FROM taskboard.users WHERE user_id = @userId AND account_status = N'active'");
    const row = result.recordset[0];
    if (!row) throw new Error("用户不存在或已停用");
    const token = randomBytes(32).toString("base64url");
    await pool.request()
      .input("userId", sql.UniqueIdentifier, row.user_id)
      .input("tokenHash", sql.VarChar(64), hashSessionToken(token))
      .input("expiresAt", sql.DateTime2, new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000))
      .query(`
        INSERT INTO taskboard.user_sessions (user_id, token_hash, expires_at)
        VALUES (@userId, @tokenHash, @expiresAt);
      `);
    return { token, user: userFromRow(row) };
  }

  async session(token) {
    if (!token) return null;
    const pool = await this.pool();
    const result = await pool.request()
      .input("tokenHash", sql.VarChar(64), hashSessionToken(token))
      .query(`
        SELECT u.*, s.session_id
        FROM taskboard.user_sessions s
        INNER JOIN taskboard.users u ON u.user_id = s.user_id
        WHERE s.token_hash = @tokenHash AND s.expires_at > SYSUTCDATETIME() AND u.account_status = N'active';
      `);
    const row = result.recordset[0];
    if (!row) return null;
    await pool.request()
      .input("sessionId", sql.UniqueIdentifier, row.session_id)
      .query("UPDATE taskboard.user_sessions SET last_seen_at = SYSUTCDATETIME() WHERE session_id = @sessionId");
    return userFromRow(row);
  }

  async listEmployees() {
    const pool = await this.pool();
    const result = await pool.request().query(`
      SELECT * FROM taskboard.employee_directory
      ORDER BY is_active DESC, display_name, employee_no;
    `);
    return result.recordset.map(employeeFromRow);
  }

  async listAvailableDevelopers(userId, projectId) {
    if (await this.projectAccess(userId, projectId) !== "owner") {
      throw new Error("只有项目负责人可以配置成员");
    }
    const pool = await this.pool();
    const result = await pool.request()
      .input("projectId", sql.UniqueIdentifier, projectId)
      .query(`
        SELECT u.user_id, u.employee_no, u.display_name, u.email, u.department, u.job_title
        FROM taskboard.users u
        WHERE u.account_status = N'active'
          AND NOT EXISTS (
            SELECT 1 FROM taskboard.project_members pm
            WHERE pm.project_id = @projectId AND pm.user_id = u.user_id AND pm.is_active = 1
          )
        ORDER BY u.display_name, u.employee_no;
      `);
    return result.recordset.map((row) => ({
      userId: row.user_id,
      employeeNo: row.employee_no,
      displayName: row.display_name,
      email: row.email,
      department: row.department,
      jobTitle: row.job_title,
    }));
  }

  async importEmployees(employees) {
    const pool = await this.pool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const employee of employees) {
        await transaction.request()
          .input("employeeNo", sql.NVarChar(50), employee.employeeNo)
          .input("displayName", sql.NVarChar(100), employee.displayName)
          .input("email", sql.NVarChar(255), employee.email)
          .input("department", sql.NVarChar(200), employee.department)
          .input("jobTitle", sql.NVarChar(200), employee.jobTitle)
          .input("isActive", sql.Bit, employee.isActive)
          .input("sourceFileName", sql.NVarChar(260), employee.sourceFileName)
          .query(`
            UPDATE taskboard.employee_directory
            SET display_name = @displayName, email = @email, department = @department,
                job_title = @jobTitle, is_active = @isActive, source_file_name = @sourceFileName,
                updated_at = SYSUTCDATETIME()
            WHERE employee_no = @employeeNo;
            IF @@ROWCOUNT = 0
              INSERT INTO taskboard.employee_directory
                (employee_no, display_name, email, department, job_title, is_active, source_file_name)
              VALUES
                (@employeeNo, @displayName, @email, @department, @jobTitle, @isActive, @sourceFileName);
          `);
      }
      await transaction.commit();
      return this.listEmployees();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listProjects(userId) {
    const pool = await this.pool();
    const result = await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .query(`
        SELECT p.project_id, p.project_code, p.project_name, p.workspace_path, p.description,
               p.owner_user_id, owner.display_name AS owner_name,
               (SELECT COUNT(DISTINCT COALESCE(t.source_fingerprint, CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', CONCAT(LTRIM(RTRIM(t.title)), N'\n', LTRIM(RTRIM(COALESCE(t.description, N''))))), 2))) FROM taskboard.task_cards t WHERE t.project_id = p.project_id) AS issue_count,
               p.is_archived, p.created_at, p.updated_at,
               pm.project_role
        FROM taskboard.projects p
        INNER JOIN taskboard.users owner ON owner.user_id = p.owner_user_id
        LEFT JOIN taskboard.project_members pm
          ON pm.project_id = p.project_id AND pm.user_id = @userId AND pm.is_active = 1
        WHERE p.is_archived = 0
        ORDER BY p.updated_at DESC, p.project_name;
      `);
    return result.recordset.map((row) => ({
      id: row.project_id,
      code: row.project_code,
      name: row.project_name,
      workspacePath: row.workspace_path,
      description: row.description,
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name,
      issueCount: Number(row.issue_count ?? 0),
      role: row.project_role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listTaskSyncLogs(userId, limit = 100) {
    const pool = await this.pool();
    const result = await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
               l.sync_id,
               l.project_id,
               p.project_name,
               p.project_code,
               l.operator_user_id,
               u.display_name AS operator_name,
               u.employee_no AS operator_employee_no,
               l.local_project_id,
               l.task_count,
               l.imported_count,
               l.updated_count,
               l.failed_count,
               l.sync_status,
               l.error_message,
               l.created_at
        FROM taskboard.task_sync_logs l
        INNER JOIN taskboard.projects p ON p.project_id = l.project_id
        INNER JOIN taskboard.users u ON u.user_id = l.operator_user_id
        WHERE l.operator_user_id = @userId
           OR EXISTS (
             SELECT 1
             FROM taskboard.project_members pm
             WHERE pm.project_id = l.project_id
               AND pm.user_id = @userId
               AND pm.is_active = 1
           )
        ORDER BY l.created_at DESC, l.sync_id DESC;
      `);
    return result.recordset.map((row) => ({
      id: row.sync_id,
      projectId: row.project_id,
      projectName: row.project_name,
      projectCode: row.project_code,
      operatorUserId: row.operator_user_id,
      operatorName: row.operator_name,
      operatorEmployeeNo: row.operator_employee_no,
      localProjectId: row.local_project_id,
      taskCount: Number(row.task_count ?? 0),
      imported: Number(row.imported_count ?? 0),
      updated: Number(row.updated_count ?? 0),
      failed: Number(row.failed_count ?? 0),
      status: row.sync_status,
      error: row.error_message,
      createdAt: row.created_at,
    }));
  }

  async createProject(userId, input) {
    const pool = await this.pool();
    const projectId = randomUUID();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("projectCode", sql.NVarChar(50), input.code)
        .input("projectName", sql.NVarChar(200), input.name)
        .input("workspacePath", sql.NVarChar(1000), input.workspacePath)
        .input("description", sql.NVarChar(1000), input.description)
        .input("ownerUserId", sql.UniqueIdentifier, userId)
        .query(`
          INSERT INTO taskboard.projects
            (project_id, project_code, project_name, workspace_path, description, owner_user_id)
          VALUES
            (@projectId, @projectCode, @projectName, @workspacePath, @description, @ownerUserId);
          INSERT INTO taskboard.project_members (project_id, user_id, project_role)
          VALUES (@projectId, @ownerUserId, N'owner');
        `);
      await transaction.commit();
      return {
        id: projectId,
        code: input.code,
        name: input.name,
        workspacePath: input.workspacePath,
        description: input.description,
        ownerUserId: userId,
        role: "owner",
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async listProjectMembers(userId, projectId) {
    const pool = await this.pool();
    const result = await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .input("projectId", sql.UniqueIdentifier, projectId)
      .query(`
        SELECT u.user_id, u.employee_no, u.display_name, u.email, u.department,
               pm.project_role, pm.joined_at, pm.is_active
        FROM taskboard.project_members pm
        INNER JOIN taskboard.users u ON u.user_id = pm.user_id
        WHERE pm.project_id = @projectId
          AND pm.is_active = 1
        ORDER BY CASE pm.project_role WHEN N'owner' THEN 0 ELSE 1 END, u.display_name;
      `);
    return result.recordset.map((row) => ({
      userId: row.user_id,
      employeeNo: row.employee_no,
      displayName: row.display_name,
      email: row.email,
      department: row.department,
      projectRole: row.project_role,
      joinedAt: row.joined_at,
    }));
  }

  async joinProject(userId, projectId) {
    const pool = await this.pool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const projectResult = await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .query("SELECT project_id FROM taskboard.projects WHERE project_id = @projectId AND is_archived = 0");
      if (projectResult.recordset.length === 0) throw new Error("项目不存在或已归档");
      await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
          UPDATE taskboard.project_members SET is_active = 1
          WHERE project_id = @projectId AND user_id = @userId;
          IF @@ROWCOUNT = 0
            INSERT INTO taskboard.project_members (project_id, user_id, project_role)
            VALUES (@projectId, @userId, N'developer');
        `);
      await transaction.commit();
      return this.listProjectMembers(userId, projectId);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async addProjectMember(operatorUserId, projectId, employeeNo) {
    const pool = await this.pool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const ownerResult = await transaction.request()
        .input("operatorUserId", sql.UniqueIdentifier, operatorUserId)
        .input("projectId", sql.UniqueIdentifier, projectId)
        .query(`
          SELECT 1 FROM taskboard.project_members
          WHERE project_id = @projectId AND user_id = @operatorUserId
            AND project_role = N'owner' AND is_active = 1;
        `);
      if (ownerResult.recordset.length === 0) throw new Error("只有项目负责人可以添加成员");

      const employeeResult = await transaction.request()
        .input("employeeNo", sql.NVarChar(50), employeeNo)
        .query("SELECT * FROM taskboard.employee_directory WHERE employee_no = @employeeNo AND is_active = 1");
      const employee = employeeResult.recordset[0];
      if (!employee) throw new Error("员工不存在或已离职");

      const userResult = await transaction.request()
        .input("employeeNo", sql.NVarChar(50), employeeNo)
        .query("SELECT user_id FROM taskboard.users WHERE employee_no = @employeeNo");
      let userId = userResult.recordset[0]?.user_id;
      if (!userId) throw new Error("该开发人员还没有自行登录登记");
      await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
          UPDATE taskboard.project_members SET is_active = 1, project_role = N'developer'
          WHERE project_id = @projectId AND user_id = @userId;
          IF @@ROWCOUNT = 0
            INSERT INTO taskboard.project_members (project_id, user_id, project_role)
            VALUES (@projectId, @userId, N'developer');
        `);
      await transaction.commit();
      return this.listProjectMembers(operatorUserId, projectId);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async removeProjectMember(operatorUserId, projectId, memberUserId) {
    const pool = await this.pool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const ownerResult = await transaction.request()
        .input("operatorUserId", sql.UniqueIdentifier, operatorUserId)
        .input("projectId", sql.UniqueIdentifier, projectId)
        .query("SELECT 1 FROM taskboard.project_members WHERE project_id = @projectId AND user_id = @operatorUserId AND project_role = N'owner' AND is_active = 1");
      if (ownerResult.recordset.length === 0) throw new Error("只有项目负责人可以移除成员");
      const target = await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("memberUserId", sql.UniqueIdentifier, memberUserId)
        .query("SELECT project_role FROM taskboard.project_members WHERE project_id = @projectId AND user_id = @memberUserId AND is_active = 1");
      if (target.recordset[0]?.project_role === "owner") throw new Error("项目负责人不能移除");
      await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("memberUserId", sql.UniqueIdentifier, memberUserId)
        .query("UPDATE taskboard.project_members SET is_active = 0 WHERE project_id = @projectId AND user_id = @memberUserId AND is_active = 1");
      await transaction.commit();
      return this.listProjectMembers(operatorUserId, projectId);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async projectAccess(userId, projectId) {
    const pool = await this.pool();
    const result = await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .input("projectId", sql.UniqueIdentifier, projectId)
      .query(`
        SELECT project_role
        FROM taskboard.project_members
        WHERE project_id = @projectId AND user_id = @userId AND is_active = 1;
      `);
    return result.recordset[0]?.project_role ?? null;
  }

  async listProjectTasks(userId, projectId) {
    const pool = await this.pool();
    const result = await pool.request()
      .input("projectId", sql.UniqueIdentifier, projectId)
      .query(`
        SELECT t.*, a.display_name AS assignee_name, c.display_name AS creator_name,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(t.source_fingerprint, CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', CONCAT(LTRIM(RTRIM(t.title)), N'\n', LTRIM(RTRIM(COALESCE(t.description, N''))))), 2))
                 ORDER BY t.updated_at DESC, t.task_id
               ) AS dedupe_rank
        FROM taskboard.task_cards t
        LEFT JOIN taskboard.users a ON a.user_id = t.assignee_user_id
        INNER JOIN taskboard.users c ON c.user_id = t.created_by_user_id
        WHERE t.project_id = @projectId
          AND EXISTS (SELECT 1 FROM taskboard.projects p WHERE p.project_id = t.project_id AND p.is_archived = 0)
        ORDER BY t.updated_at DESC, t.task_key;
      `);
    return result.recordset.filter((row) => Number(row.dedupe_rank) === 1).map((row) => ({
      id: row.task_id,
      projectId: row.project_id,
      taskKey: row.task_key,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignee: row.assignee_user_id ? { id: row.assignee_user_id, name: row.assignee_name } : null,
      createdBy: { id: row.created_by_user_id, name: row.creator_name },
      version: row.version_no,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createProjectTask(userId, projectId, input) {
    const role = await this.projectAccess(userId, projectId);
    if (!role) throw new Error("你不是该项目成员");
    const pool = await this.pool();
    const taskId = randomUUID();
    const assigneeId = role === "owner" && input.assigneeUserId ? input.assigneeUserId : userId;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await acquireProjectTaskLock(transaction, projectId);
      const member = await transaction.request()
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("assigneeId", sql.UniqueIdentifier, assigneeId)
        .query(`
          SELECT 1 FROM taskboard.project_members
          WHERE project_id = @projectId AND user_id = @assigneeId AND is_active = 1;
        `);
      if (member.recordset.length === 0) throw new Error("任务负责人必须是项目成员");
      const taskKey = await nextProjectTaskKey(transaction, projectId, input.codePrefix);
      await transaction.request()
        .input("taskId", sql.UniqueIdentifier, taskId)
        .input("projectId", sql.UniqueIdentifier, projectId)
        .input("taskKey", sql.NVarChar(50), taskKey)
        .input("title", sql.NVarChar(300), input.title)
        .input("description", sql.NVarChar(sql.MAX), input.description ?? "")
        .input("priority", sql.NVarChar(20), input.priority ?? "normal")
        .input("assigneeId", sql.UniqueIdentifier, assigneeId)
        .input("createdByUserId", sql.UniqueIdentifier, userId)
        .query(`
          INSERT INTO taskboard.task_cards
            (task_id, project_id, task_key, title, description, priority, assignee_user_id, created_by_user_id)
          VALUES
            (@taskId, @projectId, @taskKey, @title, @description, @priority, @assigneeId, @createdByUserId);
          INSERT INTO taskboard.task_events
            (task_id, project_id, event_type, to_value, operator_user_id)
          VALUES
            (@taskId, @projectId, N'created', @title, @createdByUserId);
        `);
      await transaction.commit();
      return {
        id: taskId,
        projectId,
        taskKey,
        title: input.title,
        description: input.description ?? "",
        status: "todo",
        priority: input.priority ?? "normal",
        assignee: assigneeId ? { id: assigneeId, name: null } : null,
        createdBy: { id: userId, name: null },
        version: 1,
      };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async importProjectTasks(userId, projectId, tasks, options = {}) {
    const role = await this.projectAccess(userId, projectId);
    if (!role) throw new Error("你不是该项目成员");
    if (!Array.isArray(tasks)) throw new Error("任务卡片数据格式不正确");
    const pool = await this.pool();
    const syncId = randomUUID();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await acquireProjectTaskLock(transaction, projectId);
      let imported = 0;
      let updated = 0;
      for (const input of tasks) {
        // The same local task id can exist on multiple machines. Scope the
        // source key to the uploader so member load remains visible after sync.
        const sourceFingerprint = taskFingerprint({
          ...input,
          sourceId: input.sourceId ? `${userId}:${input.sourceId}` : undefined,
        });
        const existing = await transaction.request()
          .input("projectId", sql.UniqueIdentifier, projectId)
          .input("sourceFingerprint", sql.VarChar(64), sourceFingerprint)
          .query("SELECT TOP 1 task_id, version_no, status, priority, description, assignee_user_id FROM taskboard.task_cards WHERE project_id = @projectId AND source_fingerprint = @sourceFingerprint");
        if (existing.recordset.length > 0) {
          const current = existing.recordset[0];
          const nextStatus = input.status ?? "todo";
          const nextPriority = input.priority ?? "normal";
          const nextDescription = input.description ?? "";
          const changed = current.status !== nextStatus
            || current.priority !== nextPriority
            || (current.description ?? "") !== nextDescription
            || current.assignee_user_id !== userId;
          if (changed) {
            await transaction.request()
              .input("taskId", sql.UniqueIdentifier, current.task_id)
              .input("status", sql.NVarChar(20), nextStatus)
              .input("priority", sql.NVarChar(20), nextPriority)
              .input("description", sql.NVarChar(sql.MAX), nextDescription)
              .input("assigneeId", sql.UniqueIdentifier, userId)
              .input("version", sql.Int, current.version_no)
              .input("sourceFingerprint", sql.VarChar(64), sourceFingerprint)
              .query(`
                UPDATE taskboard.task_cards
                SET status = @status,
                    priority = @priority,
                    description = @description,
                    assignee_user_id = @assigneeId,
                    source_fingerprint = @sourceFingerprint,
                    version_no = version_no + 1,
                    updated_at = SYSUTCDATETIME()
                WHERE task_id = @taskId AND version_no = @version;
                INSERT INTO taskboard.task_events
                  (task_id, project_id, event_type, from_value, to_value, operator_user_id)
                SELECT task_id, project_id, N'synced_update', @version, @status, @assigneeId
                FROM taskboard.task_cards WHERE task_id = @taskId;
              `);
            updated += 1;
          }
          continue;
        }
        const taskId = randomUUID();
        const taskKey = await nextProjectTaskKey(transaction, projectId, "SYNC");
        await transaction.request()
          .input("taskId", sql.UniqueIdentifier, taskId)
          .input("projectId", sql.UniqueIdentifier, projectId)
          .input("taskKey", sql.NVarChar(50), taskKey)
          .input("title", sql.NVarChar(300), input.title)
          .input("description", sql.NVarChar(sql.MAX), input.description ?? "")
          .input("status", sql.NVarChar(20), input.status ?? "todo")
          .input("priority", sql.NVarChar(20), input.priority ?? "normal")
          .input("sourceFingerprint", sql.VarChar(64), sourceFingerprint)
          .input("userId", sql.UniqueIdentifier, userId)
          .query(`
            INSERT INTO taskboard.task_cards
              (task_id, project_id, task_key, title, description, status, priority, source_fingerprint, assignee_user_id, created_by_user_id)
            VALUES
              (@taskId, @projectId, @taskKey, @title, @description, @status, @priority, @sourceFingerprint, @userId, @userId);
            INSERT INTO taskboard.task_events
              (task_id, project_id, event_type, to_value, operator_user_id)
            VALUES
              (@taskId, @projectId, N'synced', @title, @userId);
          `);
        imported += 1;
      }
      const deduped = await dedupeProjectTaskCards(transaction, projectId, userId);
      const unchanged = imported === 0 && updated === 0 && deduped === 0;
      await writeTaskSyncLog(transaction, {
        syncId,
        projectId,
        userId,
        localProjectId: options.localProjectId,
        taskCount: tasks.length,
        imported,
        updated: updated + deduped,
        failed: 0,
        status: "success",
        error: unchanged ? "没有新的任务卡片" : null,
      });
      await transaction.commit();
      return { syncId, imported, updated, deduped, unchanged };
    } catch (error) {
      await transaction.rollback();
      try {
        await writeTaskSyncLog(pool, {
          syncId,
          projectId,
          userId,
          localProjectId: options.localProjectId,
          taskCount: tasks.length,
          imported: 0,
          updated: 0,
          failed: tasks.length,
          status: "failed",
          error: error.message,
        });
      } catch {}
      throw error;
    }
  }

  async updateProjectTask(userId, projectId, taskId, version, changes) {
    const role = await this.projectAccess(userId, projectId);
    if (!role) throw new Error("你不是该项目成员");
    const pool = await this.pool();
    const currentResult = await pool.request()
      .input("projectId", sql.UniqueIdentifier, projectId)
      .input("taskId", sql.UniqueIdentifier, taskId)
      .query("SELECT * FROM taskboard.task_cards WHERE project_id = @projectId AND task_id = @taskId");
    const current = currentResult.recordset[0];
    if (!current) throw new Error("任务不存在");
    if (current.version_no !== version) throw new Error("任务已被其他成员更新，请刷新后重试");
    if (role !== "owner" && current.assignee_user_id !== userId) throw new Error("开发人员只能修改自己负责的任务");
    if (changes.assigneeUserId !== undefined && role !== "owner") throw new Error("只有项目负责人可以转交任务");

    const next = {
      title: changes.title ?? current.title,
      description: changes.description ?? current.description,
      status: changes.status ?? current.status,
      priority: changes.priority ?? current.priority,
      assigneeUserId: changes.assigneeUserId ?? current.assignee_user_id,
    };
    if (next.assigneeUserId) {
      const assignee = await this.projectAccess(next.assigneeUserId, projectId);
      if (!assignee) throw new Error("任务负责人必须是项目成员");
    }
    const update = await pool.request()
      .input("projectId", sql.UniqueIdentifier, projectId)
      .input("taskId", sql.UniqueIdentifier, taskId)
      .input("version", sql.Int, version)
      .input("title", sql.NVarChar(300), next.title)
      .input("description", sql.NVarChar(sql.MAX), next.description)
      .input("status", sql.NVarChar(20), next.status)
      .input("priority", sql.NVarChar(20), next.priority)
      .input("assigneeUserId", sql.UniqueIdentifier, next.assigneeUserId)
      .query(`
        UPDATE taskboard.task_cards
        SET title = @title, description = @description, status = @status, priority = @priority,
            assignee_user_id = @assigneeUserId, version_no = version_no + 1, updated_at = SYSUTCDATETIME()
        WHERE project_id = @projectId AND task_id = @taskId AND version_no = @version;
      `);
    if (update.rowsAffected[0] !== 1) throw new Error("任务已被其他成员更新，请刷新后重试");
    await pool.request()
      .input("taskId", sql.UniqueIdentifier, taskId)
      .input("projectId", sql.UniqueIdentifier, projectId)
      .input("operatorUserId", sql.UniqueIdentifier, userId)
      .input("fromValue", sql.NVarChar(sql.MAX), JSON.stringify({ status: current.status, assigneeUserId: current.assignee_user_id }))
      .input("toValue", sql.NVarChar(sql.MAX), JSON.stringify({ status: next.status, assigneeUserId: next.assigneeUserId }))
      .query(`
        INSERT INTO taskboard.task_events
          (task_id, project_id, event_type, from_value, to_value, operator_user_id)
        VALUES
          (@taskId, @projectId, N'updated', @fromValue, @toValue, @operatorUserId);
      `);
    return {
      id: taskId,
      projectId,
      title: next.title,
      description: next.description,
      status: next.status,
      priority: next.priority,
      assignee: next.assigneeUserId ? { id: next.assigneeUserId, name: null } : null,
      version: version + 1,
    };
  }

  async close() {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.close();
      this.poolPromise = null;
    }
  }
}

export function sqlServerConfigFromEnv() {
  const host = process.env.TASKBOARD_SQLSERVER_HOST?.trim();
  const user = process.env.TASKBOARD_SQLSERVER_USER?.trim();
  const password = process.env.TASKBOARD_SQLSERVER_PASSWORD;
  const database = process.env.TASKBOARD_SQLSERVER_DATABASE?.trim();
  if (!host || !user || !password || !database) return null;
  return {
    server: host,
    port: Number(process.env.TASKBOARD_SQLSERVER_PORT ?? 1433),
    user,
    password,
    database,
    options: {
      encrypt: process.env.TASKBOARD_SQLSERVER_ENCRYPT === "true",
      trustServerCertificate: process.env.TASKBOARD_SQLSERVER_TRUST_CERT !== "false",
    },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };
}
