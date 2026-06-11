import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/skill-sandbox/conversations/:conversationId/file", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillSandboxConversationFileRoutes } = await import(
      "./skill-sandbox-conversation-file"
    );
    await app.register(skillSandboxConversationFileRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("rejects relative paths before materializing a sandbox", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${_url()}?path=report.json`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "path must be an absolute sandbox path",
    );
  });

  test("rejects NUL bytes constructed at runtime", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${_url()}?path=${encodeURIComponent(`/home/sandbox/report.json${String.fromCharCode(0)}`)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "path must be an absolute sandbox path",
    );
  });

  test("rejects parent traversal", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${_url()}?path=${encodeURIComponent("/home/sandbox/../secret")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("path must not contain '..'");
  });

  test("rejects paths outside sandbox roots", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${_url()}?path=${encodeURIComponent("/etc/passwd")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("path must be under");
  });

  test("returns 404 for a valid path when no conversation sandbox exists", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${_url()}?path=${encodeURIComponent("/home/sandbox/report.json")}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Sandbox file not found");
  });
});

function _url(): string {
  return "/api/skill-sandbox/conversations/00000000-0000-0000-0000-000000000000/file";
}
