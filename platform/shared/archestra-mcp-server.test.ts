import { describe, expect, expectTypeOf, test } from "vitest";
import { AGENT_TOOL_PREFIX, isAgentTool } from "./agents";
import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  getArchestraMcpServerName,
  getArchestraToolFullName,
  getArchestraToolPrefix,
  getArchestraToolShortName,
  isArchestraMcpServerTool,
  TOOL_API_FULL_NAME,
} from "./archestra-mcp-server";

describe("archestra MCP tool names", () => {
  test("contains the shared special tool short names", () => {
    expect(ARCHESTRA_TOOL_SHORT_NAMES).toContain("api");
    expect(ARCHESTRA_TOOL_SHORT_NAMES).toContain("swap_agent");
    expect(ARCHESTRA_TOOL_SHORT_NAMES).toContain("artifact_write");
  });

  test("builds a fully-qualified Archestra tool name", () => {
    expect(getArchestraToolFullName("api")).toBe(TOOL_API_FULL_NAME);
  });

  test("preserves literal full-name typing", () => {
    const fullName = getArchestraToolFullName("api");
    expectTypeOf(fullName).toEqualTypeOf<typeof TOOL_API_FULL_NAME>();
  });

  test("slugifies branded tool prefixes for non-alphanumeric app names", () => {
    expect(
      getArchestraMcpServerName({
        appName: "Archestra ❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra");
    expect(
      getArchestraToolPrefix({
        appName: "Archestra ❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra__");
    expect(
      getArchestraToolFullName("api", {
        appName: "Archestra ❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra__api");
  });

  test("falls back to the default built-in prefix when branding slugifies to empty", () => {
    expect(
      getArchestraMcpServerName({
        appName: "❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra");
    expect(
      getArchestraToolFullName("api", {
        appName: "❤️",
        fullWhiteLabeling: true,
      }),
    ).toBe("archestra__api");
  });

  test("extracts the short name from an Archestra tool", () => {
    expect(getArchestraToolShortName(TOOL_API_FULL_NAME)).toBe("api");
  });

  test("returns null for unknown or non-Archestra tool names", () => {
    expect(getArchestraToolShortName("archestra__poop")).toBeNull();
    expect(getArchestraToolShortName("github__list_issues")).toBeNull();
  });

  test("identifies Archestra and agent tools by prefix", () => {
    expect(isArchestraMcpServerTool("archestra__whoami")).toBe(true);
    expect(isArchestraMcpServerTool("github__list_issues")).toBe(false);
    expect(isAgentTool(`${AGENT_TOOL_PREFIX}delegate_me`)).toBe(true);
    expect(isAgentTool("archestra__whoami")).toBe(false);
  });
});
