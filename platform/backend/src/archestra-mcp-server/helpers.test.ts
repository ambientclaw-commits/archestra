import { describe, expect, test } from "@/test";
import { isAbortLikeError } from "./helpers";

describe("isAbortLikeError", () => {
  test("returns true for AbortError", () => {
    const error = new DOMException("The operation was aborted", "AbortError");
    expect(isAbortLikeError(error)).toBe(true);
  });

  test("returns true for error message containing abort", () => {
    const error = new Error("Request was aborted by client");
    expect(isAbortLikeError(error)).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isAbortLikeError("not an error")).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError(42)).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isAbortLikeError(new Error("Connection timeout"))).toBe(false);
  });
});
