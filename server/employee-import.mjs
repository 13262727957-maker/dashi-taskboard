import * as XLSX from "xlsx";

const HEADER_ALIASES = {
  employeeNo: ["工号", "员工工号", "employee_no", "employeeNo", "employee id", "employee_id"],
  displayName: ["姓名", "员工姓名", "display_name", "displayName", "name"],
  email: ["邮箱", "公司邮箱", "email", "email_address"],
  department: ["部门", "department"],
  jobTitle: ["职位", "岗位", "job_title", "jobTitle", "title"],
  isActive: ["在职状态", "是否在职", "is_active", "isActive", "active"],
};

function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeValue(value) {
  return String(value ?? "").trim();
}

function resolveHeaders(headerRow) {
  const normalized = new Map(
    headerRow.map((value, index) => [normalizeHeader(value), index]),
  );
  const indexes = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const alias = aliases.find((candidate) => normalized.has(normalizeHeader(candidate)));
    if (alias) indexes[field] = normalized.get(normalizeHeader(alias));
  }
  return indexes;
}

function parseActive(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (!normalized) return true;
  if (["否", "离职", "停用", "false", "0", "no", "inactive"].includes(normalized)) return false;
  return true;
}

export function parseEmployeeWorkbook(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("员工 Excel 文件为空");
  }

  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("员工 Excel 文件没有工作表");

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: false,
  });
  if (rows.length === 0) throw new Error("员工 Excel 文件没有数据");

  const indexes = resolveHeaders(rows[0]);
  if (indexes.employeeNo === undefined || indexes.displayName === undefined) {
    throw new Error("员工 Excel 必须包含“工号”和“姓名”列");
  }

  const employees = [];
  const errors = [];
  const seen = new Set();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const employeeNo = normalizeValue(row[indexes.employeeNo]);
    const displayName = normalizeValue(row[indexes.displayName]);
    if (!employeeNo && !displayName) continue;
    if (!employeeNo || !displayName) {
      errors.push({ row: rowIndex + 1, message: "工号和姓名不能为空" });
      continue;
    }
    if (seen.has(employeeNo)) {
      errors.push({ row: rowIndex + 1, message: `工号重复：${employeeNo}` });
      continue;
    }
    seen.add(employeeNo);
    employees.push({
      employeeNo,
      displayName,
      email: indexes.email === undefined ? null : normalizeValue(row[indexes.email]) || null,
      department: indexes.department === undefined ? null : normalizeValue(row[indexes.department]) || null,
      jobTitle: indexes.jobTitle === undefined ? null : normalizeValue(row[indexes.jobTitle]) || null,
      isActive: indexes.isActive === undefined ? true : parseActive(row[indexes.isActive]),
      sourceFileName: options.sourceFileName ?? null,
    });
  }

  return { employees, errors, sheetName };
}
