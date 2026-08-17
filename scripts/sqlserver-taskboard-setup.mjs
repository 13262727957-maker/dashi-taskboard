import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(ROOT, "sqlserver", "001_taskboard_identity.sql");
const migrationPaths = [
  path.join(ROOT, "sqlserver", "002_remove_system_admin_columns.sql"),
  path.join(ROOT, "sqlserver", "003_task_source_fingerprint.sql"),
  path.join(ROOT, "sqlserver", "004_consistent_project_relations.sql"),
  path.join(ROOT, "sqlserver", "005_task_sync_logs.sql"),
];
const DEFAULT_DATABASE = "dashi_taskboard_test";
const TEST_IDS = {
  owner: "00000000-0000-0000-0000-000000000102",
  developer: "00000000-0000-0000-0000-000000000103",
  project: "00000000-0000-0000-0000-000000000201",
  ownerMember: "00000000-0000-0000-0000-000000000202",
  developerMember: "00000000-0000-0000-0000-000000000203",
  taskOne: "00000000-0000-0000-0000-000000000301",
  taskTwo: "00000000-0000-0000-0000-000000000302",
  runOne: "00000000-0000-0000-0000-000000000401",
};

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function sqlConfig(database) {
  return {
    server: requiredEnv("TASKBOARD_SQLSERVER_HOST"),
    port: Number(process.env.TASKBOARD_SQLSERVER_PORT ?? 1433),
    user: requiredEnv("TASKBOARD_SQLSERVER_USER"),
    password: requiredEnv("TASKBOARD_SQLSERVER_PASSWORD"),
    database,
    options: {
      encrypt: process.env.TASKBOARD_SQLSERVER_ENCRYPT === "true",
      trustServerCertificate: process.env.TASKBOARD_SQLSERVER_TRUST_CERT !== "false",
    },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };
}

function splitBatches(source) {
  return source
    .split(/^\s*GO\s*$/gim)
    .map((batch) => batch.trim())
    .filter(Boolean);
}

async function ensureDatabase() {
  const database = process.env.TASKBOARD_SQLSERVER_DATABASE?.trim() || DEFAULT_DATABASE;
  const pool = await sql.connect(sqlConfig("master"));
  const request = pool.request();
  request.input("databaseName", sql.NVarChar(128), database);
  await request.query(`
    IF DB_ID(@databaseName) IS NULL
    BEGIN
      DECLARE @statement NVARCHAR(4000) = N'CREATE DATABASE ' + QUOTENAME(@databaseName);
      EXEC sys.sp_executesql @statement;
    END
  `);
  await pool.close();
  return database;
}

async function applySchema(pool) {
  const source = await readFile(schemaPath, "utf8");
  for (const batch of splitBatches(source)) await pool.request().batch(batch);
  for (const migrationPath of migrationPaths) {
    const migration = await readFile(migrationPath, "utf8");
    for (const batch of splitBatches(migration)) await pool.request().batch(batch);
  }
}

async function seedTestData(pool) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const request = () => transaction.request();
    await request().query(`
      MERGE taskboard.employee_directory AS target
      USING (VALUES
        (N'TEST-OWNER', N'测试负责人', N'test-owner@example.com', N'研发部', N'项目负责人', 1),
        (N'TEST-DEV', N'测试开发人员', N'test-dev@example.com', N'研发部', N'开发工程师', 1),
        (N'TEST-EXITED', N'测试离职员工', N'test-exited@example.com', N'研发部', N'开发工程师', 0)
      ) AS source(employee_no, display_name, email, department, job_title, is_active)
      ON target.employee_no = source.employee_no
      WHEN MATCHED THEN UPDATE SET
        display_name = source.display_name,
        email = source.email,
        department = source.department,
        job_title = source.job_title,
        is_active = source.is_active,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (employee_no, display_name, email, department, job_title, is_active)
      VALUES
        (source.employee_no, source.display_name, source.email, source.department, source.job_title, source.is_active);
    `);

    await request().query(`
      MERGE taskboard.users AS target
      USING (VALUES
        ('${TEST_IDS.owner}', N'TEST-OWNER', N'测试负责人', N'active'),
        ('${TEST_IDS.developer}', N'TEST-DEV', N'测试开发人员', N'active')
      ) AS source(user_id, employee_no, display_name, account_status)
      ON target.employee_no = source.employee_no
      WHEN MATCHED THEN UPDATE SET
        employee_no = source.employee_no,
        display_name = source.display_name,
        account_status = source.account_status,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (user_id, employee_no, display_name, account_status)
      VALUES
        (source.user_id, source.employee_no, source.display_name, source.account_status);
    `);

    await request().query(`
      MERGE taskboard.projects AS target
      USING (SELECT CAST('${TEST_IDS.project}' AS UNIQUEIDENTIFIER) AS project_id, N'TEST-PROJECT' AS project_code,
                    N'任务面板测试项目' AS project_name, N'测试用项目数据' AS description,
                    (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-OWNER') AS owner_user_id)
        AS source
      ON target.project_id = source.project_id
      WHEN MATCHED THEN UPDATE SET
        project_code = source.project_code,
        project_name = source.project_name,
        description = source.description,
        owner_user_id = source.owner_user_id,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (project_id, project_code, project_name, description, owner_user_id)
      VALUES
        (source.project_id, source.project_code, source.project_name, source.description, source.owner_user_id);
    `);

    await request().query(`
      MERGE taskboard.project_members AS target
      USING (
        SELECT CAST('${TEST_IDS.ownerMember}' AS UNIQUEIDENTIFIER) AS member_id, CAST('${TEST_IDS.project}' AS UNIQUEIDENTIFIER) AS project_id,
               (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-OWNER') AS user_id, N'owner' AS project_role
        UNION ALL
        SELECT CAST('${TEST_IDS.developerMember}' AS UNIQUEIDENTIFIER), CAST('${TEST_IDS.project}' AS UNIQUEIDENTIFIER),
               (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-DEV'), N'developer'
      ) AS source
      ON target.member_id = source.member_id
      WHEN MATCHED THEN UPDATE SET
        project_id = source.project_id,
        user_id = source.user_id,
        project_role = source.project_role,
        is_active = 1
      WHEN NOT MATCHED THEN INSERT
        (member_id, project_id, user_id, project_role)
      VALUES (source.member_id, source.project_id, source.user_id, source.project_role);
    `);

    await request().query(`
      MERGE taskboard.task_cards AS target
      USING (
        SELECT CAST('${TEST_IDS.taskOne}' AS UNIQUEIDENTIFIER) AS task_id, CAST('${TEST_IDS.project}' AS UNIQUEIDENTIFIER) AS project_id,
               N'TEST-001' AS task_key, N'验证项目总览' AS title, N'in_progress' AS status, N'high' AS priority,
               (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-OWNER') AS assignee_user_id,
               (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-OWNER') AS created_by_user_id
        UNION ALL
        SELECT CAST('${TEST_IDS.taskTwo}' AS UNIQUEIDENTIFIER), CAST('${TEST_IDS.project}' AS UNIQUEIDENTIFIER), N'TEST-002', N'验证成员任务视图', N'todo', N'normal',
               (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-DEV'),
               (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-OWNER')
      ) AS source
      ON target.task_id = source.task_id
      WHEN MATCHED THEN UPDATE SET
        project_id = source.project_id,
        task_key = source.task_key,
        title = source.title,
        status = source.status,
        priority = source.priority,
        assignee_user_id = source.assignee_user_id,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (task_id, project_id, task_key, title, status, priority, assignee_user_id, created_by_user_id)
      VALUES
        (source.task_id, source.project_id, source.task_key, source.title, source.status, source.priority, source.assignee_user_id, source.created_by_user_id);
    `);

    await request().query(`
      IF NOT EXISTS (SELECT 1 FROM taskboard.agent_runs WHERE run_id = '${TEST_IDS.runOne}')
        INSERT INTO taskboard.agent_runs
          (run_id, task_id, project_id, triggered_by_user_id, executor_type, status, summary)
        VALUES
          ('${TEST_IDS.runOne}', '${TEST_IDS.taskOne}', '${TEST_IDS.project}', (SELECT user_id FROM taskboard.users WHERE employee_no = N'TEST-OWNER'), N'manual', N'succeeded', N'测试执行记录');
    `);

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

const database = await ensureDatabase();
const pool = await sql.connect(sqlConfig(database));
try {
  await applySchema(pool);
  if (process.argv.includes("--seed")) await seedTestData(pool);
  const result = await pool.request().query(`
    SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = N'taskboard'
    ORDER BY TABLE_NAME;
  `);
  console.log(JSON.stringify({ database, tables: result.recordset }, null, 2));
} finally {
  await pool.close();
}
