/**
 * Utility for parsing MCP server config JSON pasted by the user.
 *
 * Supports multiple config formats found in the wild:
 *
 * Format 1 – VS Code MCP config (servers block + optional inputs):
 * {
 *   "servers": {
 *     "github": {
 *       "type": "http",
 *       "url": "https://api.githubcopilot.com/mcp/",
 *       "headers": { "Authorization": "Bearer ${input:github_mcp_pat}" }
 *     }
 *   },
 *   "inputs": [...]
 * }
 *
 * Format 2 – Claude Desktop / standard MCP config (command/args/env):
 * {
 *   "sonarqube": {
 *     "command": "docker",
 *     "args": ["run", "--rm", "-i", "mcp/sonarqube"],
 *     "env": { "SONARQUBE_TOKEN": "<token>" }
 *   }
 * }
 *
 * Format 3 – mcpServers wrapper (same as format 2 but nested under mcpServers):
 * {
 *   "mcpServers": {
 *     "sonarqube": { "command": "...", "args": [...], "env": {...} }
 *   }
 * }
 *
 * Format 4 – Single server object (command/args/env at top level):
 * {
 *   "command": "npx",
 *   "args": ["-y", "@modelcontextprotocol/server-filesystem"],
 *   "env": { "API_KEY": "..." }
 * }
 *
 * Format 5 – Archestra registry manifest (server.url / server.command etc.):
 * {
 *   "server": { "type": "remote", "url": "https://...", ... },
 *   "display_name": "...",
 *   ...
 * }
 */

export type ParsedMcpConfig = {
  /** Server name inferred from the config (may be empty) */
  name: string;
  /** "remote" for HTTP servers, "local" for command-based servers */
  serverType: "remote" | "local";
  /** For remote servers */
  url?: string;
  /** For local servers */
  command?: string;
  /** For local servers – array of arguments */
  args?: string[];
  /** For local servers – env vars (key → value) */
  env?: Record<string, string>;
  /** Raw headers from HTTP server config (key → value) */
  headers?: Record<string, string>;
  /** Transport type hint from HTTP server config */
  transportType?: "http" | "stdio" | "streamable-http";
};

export type ParseMcpJsonResult =
  | { ok: true; configs: ParsedMcpConfig[] }
  | { ok: false; error: string };

/**
 * Try to parse the given text as an MCP server JSON config.
 * Returns a result object; never throws.
 */
export function parseMcpJsonConfig(text: string): ParseMcpJsonResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty input" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Invalid JSON – please check the format" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  // ── Format 5: Archestra registry manifest ─────────────────────────────────
  // Has a "server" key with type/url or command
  if (isArchestraManifest(obj)) {
    const server = obj.server as Record<string, unknown>;
    const name =
      stringOrEmpty(obj.display_name) || stringOrEmpty(obj.name) || "";

    if (server.type === "remote" || server.type === "http") {
      const url = stringOrEmpty(server.url);
      if (!url) {
        return {
          ok: false,
          error: "Archestra manifest has a remote server but missing URL",
        };
      }
      return {
        ok: true,
        configs: [{ name, serverType: "remote", url, transportType: "http" }],
      };
    }

    // local server in manifest
    return {
      ok: true,
      configs: [
        {
          name,
          serverType: "local",
          command: stringOrEmpty(server.command) || undefined,
          args: stringArray(server.args),
          env: stringRecord(
            (obj.user_config as Record<string, unknown>) ?? server.env,
          ),
        },
      ],
    };
  }

  // ── Format 1: VS Code MCP config { "servers": { ... }, "inputs": [...] } ─
  if (typeof obj.servers === "object" && obj.servers !== null) {
    const servers = obj.servers as Record<string, unknown>;
    const configs = parseServersBlock(servers);
    if (configs.length > 0) {
      return { ok: true, configs };
    }
  }

  // ── Format 3: mcpServers wrapper ──────────────────────────────────────────
  if (typeof obj.mcpServers === "object" && obj.mcpServers !== null) {
    const servers = obj.mcpServers as Record<string, unknown>;
    const configs = parseCommandBlock(servers);
    if (configs.length > 0) {
      return { ok: true, configs };
    }
  }

  // ── Format 4: Single server object (command/args/env at top level) ────────
  if (typeof obj.command === "string" || typeof obj.url === "string") {
    const config = parseSingleServer("", obj);
    if (config) {
      return { ok: true, configs: [config] };
    }
  }

  // ── Format 2: keyed map of servers { "name": { command, args, env } } ─────
  // Each value should look like a server config (has command or url)
  const configs = parseCommandBlock(obj);
  if (configs.length > 0) {
    return { ok: true, configs };
  }

  return {
    ok: false,
    error:
      "Could not recognise MCP config format. Expected servers, mcpServers, command/args, or url fields.",
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isArchestraManifest(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.server === "object" &&
    obj.server !== null &&
    ("url" in (obj.server as object) || "command" in (obj.server as object))
  );
}

/** Parse VS Code "servers" block (Format 1 – HTTP servers with type/url) */
function parseServersBlock(
  servers: Record<string, unknown>,
): ParsedMcpConfig[] {
  const configs: ParsedMcpConfig[] = [];

  for (const [name, value] of Object.entries(servers)) {
    if (typeof value !== "object" || value === null) continue;
    const server = value as Record<string, unknown>;

    if (server.type === "http" || server.type === "sse" || server.url) {
      const url = stringOrEmpty(server.url);
      if (!url) continue;

      configs.push({
        name,
        serverType: "remote",
        url,
        transportType: "http",
        headers: stringRecord(server.headers),
      });
    } else if (server.command) {
      // command-based server inside a "servers" block
      const config = parseSingleServer(name, server);
      if (config) configs.push(config);
    }
  }

  return configs;
}

/** Parse a { name: { command, args, env } } map (Formats 2 & 3) */
function parseCommandBlock(
  block: Record<string, unknown>,
): ParsedMcpConfig[] {
  const configs: ParsedMcpConfig[] = [];

  for (const [name, value] of Object.entries(block)) {
    if (typeof value !== "object" || value === null) continue;
    const server = value as Record<string, unknown>;

    // Skip entries that don't look like server configs
    if (!server.command && !server.url) continue;

    const config = parseSingleServer(name, server);
    if (config) configs.push(config);
  }

  return configs;
}

/** Parse a single server object into a ParsedMcpConfig */
function parseSingleServer(
  name: string,
  server: Record<string, unknown>,
): ParsedMcpConfig | null {
  const url = stringOrEmpty(server.url);
  const command = stringOrEmpty(server.command);

  if (url) {
    return {
      name,
      serverType: "remote",
      url,
      transportType: "http",
      headers: stringRecord(server.headers),
    };
  }

  if (command) {
    return {
      name,
      serverType: "local",
      command,
      args: stringArray(server.args),
      env: stringRecord(server.env),
    };
  }

  return null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((v) => typeof v === "string")
    .map((v) => v as string);
  return result.length > 0 ? result : undefined;
}

function stringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
