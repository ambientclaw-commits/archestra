import { describe, expect, test } from "@/test";
import { codeRuntimeService } from "./code-runtime-service";
import { CodeRuntimeError } from "./types";

describe("codeRuntimeService", () => {
  test("is disabled when ARCHESTRA_CODE_RUNTIME_ENABLED is unset", () => {
    expect(codeRuntimeService.isEnabled).toBe(false);
    expect(codeRuntimeService.isReady).toBe(false);
  });

  test("run() rejects with CodeRuntimeError while the runtime is disabled", async () => {
    await expect(
      codeRuntimeService.run({ code: "print('hello')" }),
    ).rejects.toBeInstanceOf(CodeRuntimeError);
  });
});
