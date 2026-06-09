// in-process plumbing smoke: the first live validation of the eval foundation.
// boots the backend's DB + skill-sandbox runtime in-process (no HTTP), runs a
// trivial command, then installs + imports pyscipopt — the riskiest assumption
// for bike-rebalance, since upstream apt-installs libgfortran5 (unavailable in
// the non-root sandbox) and we can only use uv.
//
// run (needs ARCHESTRA_CODE_RUNTIME_ENABLED=true + a live Dagger host from Tilt):
//   pnpm tsx --tsconfig standalone-scripts.tsconfig.json \
//     src/standalone-scripts/skillsbench-eval/smoke.ts

import { pathToFileURL } from "node:url";
import { initializeDatabase } from "@/database";
import { seedDefaultUserAndOrg } from "@/database/seed";
import logger from "@/logging";
import { OrganizationModel, SkillSandboxModel } from "@/models";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { asSandboxId } from "@/types";

const SANDBOX_HOME = "/home/sandbox";

const PROBES = [
  "echo hello-from-sandbox",
  "uv pip install --system pyscipopt==6.1.0",
  "python3 -c \"import pyscipopt; print('pyscipopt', pyscipopt.__version__)\"",
] as const;

async function smoke(): Promise<void> {
  await initializeDatabase();

  if (!skillSandboxRuntimeService.isEnabled) {
    throw new Error(
      "skill sandbox is disabled — set ARCHESTRA_CODE_RUNTIME_ENABLED=true and a Dagger runner host, then `tilt up`",
    );
  }

  const admin = await seedDefaultUserAndOrg();
  const org = await OrganizationModel.getOrCreateDefaultOrganization();

  await skillSandboxRuntimeService.init();

  // a throwaway sandbox not bound to any conversation; enough to exercise runCommand.
  const sandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: admin.id,
    defaultCwd: SANDBOX_HOME,
  });
  const sandboxId = asSandboxId(sandbox.id);
  const caller = { userId: admin.id, organizationId: org.id };

  let allOk = true;
  for (const command of PROBES) {
    const result = await skillSandboxRuntimeService.runCommand({
      sandboxId,
      caller,
      command,
      cwd: SANDBOX_HOME,
      timeoutSeconds: 300,
    });
    const ok = result.exitCode === 0 && !result.timedOut;
    allOk &&= ok;
    logger.info(
      {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
      `${ok ? "✅" : "❌"} $ ${command}`,
    );
  }

  await skillSandboxRuntimeService.shutdown();

  if (!allOk) {
    throw new Error("one or more sandbox probes failed (see logs above)");
  }
  logger.info(
    "✅ smoke passed: in-process sandbox boot + uv + pyscipopt import all work",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  smoke()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error({ err: error }, "❌ smoke failed");
      process.exit(1);
    });
}
