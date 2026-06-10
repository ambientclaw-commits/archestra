import { describe, expect, it } from "vitest";
import { classifyHeuristic } from "./heuristic";

describe("classifyHeuristic", () => {
  it("never marks a tool-bearing turn as easy (defers to the classifier)", () => {
    const result = classifyHeuristic({ promptText: "hi", hasTools: true });
    expect(result.band).toBe("ambiguous");
  });

  it("routes short, simple prompts to easy", () => {
    const result = classifyHeuristic({
      promptText: "what is the capital of France?",
      hasTools: false,
    });
    expect(result.band).toBe("easy");
    expect(result.score).toBeLessThan(0.5);
  });

  it("routes long prompts to hard", () => {
    const result = classifyHeuristic({
      promptText: "a ".repeat(4000),
      hasTools: false,
    });
    expect(result.band).toBe("hard");
  });

  it("sends a short prompt with a hard keyword to the classifier (ambiguous)", () => {
    const result = classifyHeuristic({
      promptText: "refactor this",
      hasTools: false,
    });
    expect(result.band).toBe("ambiguous");
  });

  it("sends mid-size prompts to the classifier (ambiguous)", () => {
    const result = classifyHeuristic({
      promptText: "summarize the following note. ".repeat(40),
      hasTools: false,
    });
    expect(result.band).toBe("ambiguous");
  });
});
