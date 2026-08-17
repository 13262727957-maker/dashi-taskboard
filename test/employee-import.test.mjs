import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { parseEmployeeWorkbook } from "../server/employee-import.mjs";

test("employee workbook import accepts Chinese headers and keeps inactive employees", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["工号", "姓名", "公司邮箱", "部门", "在职状态"],
    ["A001", "张三", "zhangsan@example.com", "研发", "在职"],
    ["A002", "李四", "lisi@example.com", "研发", "离职"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "员工");

  const result = parseEmployeeWorkbook(
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    { sourceFileName: "employees.xlsx" },
  );

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.employees, [
    {
      employeeNo: "A001",
      displayName: "张三",
      email: "zhangsan@example.com",
      department: "研发",
      jobTitle: null,
      isActive: true,
      sourceFileName: "employees.xlsx",
    },
    {
      employeeNo: "A002",
      displayName: "李四",
      email: "lisi@example.com",
      department: "研发",
      jobTitle: null,
      isActive: false,
      sourceFileName: "employees.xlsx",
    },
  ]);
});

test("employee workbook import rejects missing identity columns", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["部门", "职位"], ["研发", "工程师"]]),
    "员工",
  );

  assert.throws(
    () => parseEmployeeWorkbook(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })),
    /必须包含.*工号.*姓名/,
  );
});
