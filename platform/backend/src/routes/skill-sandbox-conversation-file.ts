import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SkillSandboxFileModel, SkillSandboxModel } from "@/models";
import { isInlineSafeImageMime } from "@/skills-sandbox/mime-sniff";
import {
  SKILL_SANDBOX_HOME,
  SKILL_SANDBOX_ROOT,
} from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { SkillSandboxError } from "@/skills-sandbox/types";
import { ApiError, asSandboxId } from "@/types";

/**
 * Export access to a file inside a conversation's materialized skill sandbox.
 *
 * Where `GET /api/skill-sandbox/artifacts/:id` serves a *pre-exported* artifact (the model
 * called `download_file` first), this route lets a trusted API-key client read an arbitrary
 * sandbox path on demand by conversation — the missing primitive an external eval/harness needs
 * to verify what an agent produced, without going through the model. It runs no command, so it
 * cannot alter the sandbox filesystem; like `download_file`, materializing the sandbox may stage any
 * pending chat attachments (appending upload replay events) and records the read bytes as a
 * `skill_sandbox_files` artifact row. That shared export mechanism is why it shares
 * `download_file`'s permission.
 *
 * Security:
 *   - `SkillSandboxModel.findDefault` binds organization + user + conversation, so a caller only
 *     ever reaches a sandbox they own in a conversation they own; anything else is a 404 (no
 *     cross-org/conversation probing).
 *   - The `path` is validated here (absolute, no `..`/NUL, under the sandbox roots) for a clean
 *     400, and `exportArtifact`/`resolveArtifactPath` re-validate it inside the service.
 *   - Byte-streaming hardening (MIME from sniff, `nosniff`, CSP sandbox) mirrors the artifact
 *     route so a polyglot file has no script-execution surface.
 */
const skillSandboxConversationFileRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.get(
    "/api/skill-sandbox/conversations/:conversationId/file",
    {
      schema: {
        operationId: RouteId.GetSkillSandboxConversationFile,
        // internal: consumed by the skills-eval harness over raw HTTP, not the frontend client.
        // hidden from the generated OpenAPI client so it adds no public-API surface; RBAC still
        // applies (the auth middleware reads `operationId` from the schema, not the spec).
        hide: true,
        description:
          "Export a file from a conversation's materialized skill sandbox by absolute path. " +
          "Inline for known-safe raster images; download for everything else.",
        tags: ["Skills"],
        params: z.object({ conversationId: z.string().uuid() }),
        querystring: z.object({ path: z.string().min(1) }),
        // no `response` schema: streams raw bytes, not JSON (see artifact route).
      },
    },
    async (
      { params: { conversationId }, query: { path }, organizationId, user },
      reply,
    ) => {
      // validate the requested path shape first (clean 400), then authorize the conversation,
      // then materialize. `exportArtifact` calls `ensureEnabled()` as its first line, so a
      // disabled/unready sandbox runtime surfaces as a SkillSandboxError -> 404 below.
      assertReadablePath(path);

      const sandbox = await SkillSandboxModel.findDefault({
        organizationId,
        userId: user.id,
        conversationId,
      });
      if (!sandbox) {
        throw new ApiError(404, "Sandbox file not found");
      }

      // materialize the replay log and read the path; a bad/missing path or a disabled runtime
      // surfaces as a SkillSandboxError, which we collapse to 404 (no info leak about internals).
      let artifactId: string;
      try {
        const ref = await skillSandboxRuntimeService.exportArtifact({
          sandboxId: asSandboxId(sandbox.id),
          path,
          caller: { userId: user.id, organizationId },
        });
        artifactId = ref.artifactId;
      } catch (error) {
        if (error instanceof SkillSandboxError) {
          throw mapSkillSandboxError(error);
        }
        throw error;
      }

      const artifact = await SkillSandboxFileModel.findArtifactById(artifactId);
      if (!artifact) {
        throw new ApiError(404, "Sandbox file not found");
      }

      const inlineSafe = isInlineSafeImageMime(artifact.mimeType);
      const filename = safeFilenameFromPath(artifact.path);
      const data = Buffer.isBuffer(artifact.data)
        ? artifact.data
        : Buffer.from(artifact.data);

      reply
        .header(
          "Content-Type",
          inlineSafe ? artifact.mimeType : "application/octet-stream",
        )
        .header("Content-Length", String(data.byteLength))
        .header(
          "Content-Disposition",
          `${inlineSafe ? "inline" : "attachment"}; filename="${filename}"`,
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, max-age=300");
      return reply.send(data);
    },
  );
};

export default skillSandboxConversationFileRoutes;

// === internal helpers ===

/**
 * Validate a requested path at the route boundary for a clean 400. Mirrors the service's
 * `resolveArtifactPath` (which re-validates), but requires an *absolute* path: an external
 * caller names a concrete file (e.g. `/home/sandbox/report.json`), so there is no cwd to
 * resolve a relative path against here.
 */
function assertReadablePath(path: string): void {
  if (path.includes("\0") || !path.startsWith("/")) {
    throw new ApiError(400, "path must be an absolute sandbox path");
  }
  if (path.split("/").some((segment) => segment === "..")) {
    throw new ApiError(400, "path must not contain '..'");
  }
  const roots = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME];
  const underRoot = roots.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
  if (!underRoot) {
    throw new ApiError(
      400,
      `path must be under ${SKILL_SANDBOX_ROOT} or ${SKILL_SANDBOX_HOME}`,
    );
  }
}

function safeFilenameFromPath(path: string): string {
  const basename = path.split("/").pop() ?? "artifact";
  const cleaned = basename.replace(/[^A-Za-z0-9._\- ]/g, "_");
  return cleaned || "artifact";
}

function mapSkillSandboxError(error: SkillSandboxError): ApiError {
  if (
    error.message.startsWith("artifact not found:") ||
    /^sandbox .+ does not exist$/.test(error.message)
  ) {
    return new ApiError(404, "Sandbox file not found");
  }
  if (error.message.includes("artifact is too large")) {
    return new ApiError(413, "Sandbox file is too large");
  }
  if (
    error.message.includes("runtime is not enabled") ||
    error.message.includes("runtime is not available")
  ) {
    return new ApiError(503, "Sandbox runtime is not available");
  }
  if (error.message.includes("too many requests are already queued")) {
    return new ApiError(429, "Too many sandbox requests are already queued");
  }
  return new ApiError(500, "Sandbox file export failed");
}
