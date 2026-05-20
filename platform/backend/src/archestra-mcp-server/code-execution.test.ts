import { TOOL_RUN_PYTHON_FULL_NAME } from "@shared";
import { describe, expect, test } from "@/test";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";
import { TOOL_PERMISSIONS } from "./rbac";

const context: ArchestraContext = {
  agent: { id: "test-agent", name: "Test Agent" },
};

describe("run_python tool", () => {
  test("is excluded from the advertised tool list while the runtime is disabled", () => {
    const names = getArchestraMcpTools().map((tool) => tool.name);
    expect(names).not.toContain(TOOL_RUN_PYTHON_FULL_NAME);
  });

  test("is available to all authenticated users (no RBAC permission)", () => {
    expect(TOOL_PERMISSIONS.run_python).toBeNull();
  });

  test("rejects empty code", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_PYTHON_FULL_NAME,
      { code: "" },
      context,
    );
    expect(result.isError).toBe(true);
  });

  test("returns a clean error when the runtime is disabled", async () => {
    const result = await executeArchestraTool(
      TOOL_RUN_PYTHON_FULL_NAME,
      { code: "print('hello')" },
      context,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not enabled");
  });
});
