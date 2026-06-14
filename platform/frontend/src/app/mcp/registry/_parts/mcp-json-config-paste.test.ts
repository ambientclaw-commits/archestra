import { describe, expect, it } from "vitest";
import { parseMcpJsonConfig } from "./mcp-json-config-paste";

describe("parseMcpJsonConfig", () => {
  // ── Invalid input ──────────────────────────────────────────────────────────

  it("returns error for empty string", () => {
    const result = parseMcpJsonConfig("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("returns error for invalid JSON", () => {
    const result = parseMcpJsonConfig("{not json}");
    expect(result.ok).toBe(false);
  });

  it("returns error for JSON array", () => {
    const result = parseMcpJsonConfig("[]");
    expect(result.ok).toBe(false);
  });

  it("returns error for unrecognised object", () => {
    const result = parseMcpJsonConfig('{"foo": "bar"}');
    expect(result.ok).toBe(false);
  });

  // ── Format 1: VS Code servers block (HTTP) ────────────────────────────────

  it("parses VS Code HTTP server config (Format 1)", () => {
    const json = JSON.stringify({
      servers: {
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: {
            Authorization: "Bearer ${input:github_mcp_pat}",
          },
        },
      },
      inputs: [
        {
          type: "promptString",
          id: "github_mcp_pat",
          description: "GitHub Personal Access Token",
          password: true,
        },
      ],
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.configs).toHaveLength(1);
    const cfg = result.configs[0];
    expect(cfg.name).toBe("github");
    expect(cfg.serverType).toBe("remote");
    expect(cfg.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(cfg.transportType).toBe("http");
    expect(cfg.headers?.Authorization).toBe("Bearer ${input:github_mcp_pat}");
  });

  it("parses multiple servers in VS Code servers block", () => {
    const json = JSON.stringify({
      servers: {
        server1: { type: "http", url: "https://server1.example.com/mcp" },
        server2: { type: "http", url: "https://server2.example.com/mcp" },
      },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs).toHaveLength(2);
  });

  // ── Format 2: Command/args/env keyed map ──────────────────────────────────

  it("parses Claude Desktop config with docker command (Format 2)", () => {
    const json = JSON.stringify({
      sonarqube: {
        command: "docker",
        args: [
          "run",
          "--init",
          "--pull=always",
          "-i",
          "--rm",
          "-e",
          "SONARQUBE_TOKEN",
          "-e",
          "SONARQUBE_ORG",
          "mcp/sonarqube",
        ],
        env: {
          SONARQUBE_TOKEN: "<token>",
          SONARQUBE_ORG: "<org>",
        },
      },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.configs).toHaveLength(1);
    const cfg = result.configs[0];
    expect(cfg.name).toBe("sonarqube");
    expect(cfg.serverType).toBe("local");
    expect(cfg.command).toBe("docker");
    expect(cfg.args).toEqual([
      "run",
      "--init",
      "--pull=always",
      "-i",
      "--rm",
      "-e",
      "SONARQUBE_TOKEN",
      "-e",
      "SONARQUBE_ORG",
      "mcp/sonarqube",
    ]);
    expect(cfg.env?.SONARQUBE_TOKEN).toBe("<token>");
    expect(cfg.env?.SONARQUBE_ORG).toBe("<org>");
  });

  it("parses npx-based server config", () => {
    const json = JSON.stringify({
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cfg = result.configs[0];
    expect(cfg.name).toBe("filesystem");
    expect(cfg.serverType).toBe("local");
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(cfg.env).toBeUndefined();
  });

  // ── Format 3: mcpServers wrapper ──────────────────────────────────────────

  it("parses mcpServers wrapper format (Format 3)", () => {
    const json = JSON.stringify({
      mcpServers: {
        myServer: {
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "secret" },
        },
      },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cfg = result.configs[0];
    expect(cfg.name).toBe("myServer");
    expect(cfg.serverType).toBe("local");
    expect(cfg.command).toBe("node");
    expect(cfg.env?.API_KEY).toBe("secret");
  });

  // ── Format 4: Single server object ───────────────────────────────────────

  it("parses single server object with command at top level (Format 4)", () => {
    const json = JSON.stringify({
      command: "uvx",
      args: ["mcp-server-git", "--repository", "/path/to/repo"],
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cfg = result.configs[0];
    expect(cfg.name).toBe("");
    expect(cfg.serverType).toBe("local");
    expect(cfg.command).toBe("uvx");
    expect(cfg.args).toEqual(["mcp-server-git", "--repository", "/path/to/repo"]);
  });

  it("parses single remote server object with url at top level (Format 4)", () => {
    const json = JSON.stringify({
      url: "https://remote.example.com/mcp",
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cfg = result.configs[0];
    expect(cfg.serverType).toBe("remote");
    expect(cfg.url).toBe("https://remote.example.com/mcp");
  });

  // ── Format 5: Archestra registry manifest ────────────────────────────────

  it("parses Archestra registry manifest for remote server (Format 5)", () => {
    const json = JSON.stringify({
      display_name: "GitHub Copilot MCP",
      name: "github",
      server: {
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
      },
      oauth_config: {
        server_url: "https://api.githubcopilot.com/mcp",
      },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cfg = result.configs[0];
    expect(cfg.name).toBe("GitHub Copilot MCP");
    expect(cfg.serverType).toBe("remote");
    expect(cfg.url).toBe("https://api.githubcopilot.com/mcp/");
  });

  it("parses Archestra registry manifest for local server (Format 5)", () => {
    const json = JSON.stringify({
      display_name: "Filesystem MCP",
      name: "filesystem",
      server: {
        type: "local",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cfg = result.configs[0];
    expect(cfg.name).toBe("Filesystem MCP");
    expect(cfg.serverType).toBe("local");
    expect(cfg.command).toBe("npx");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("ignores entries without command or url in keyed map", () => {
    const json = JSON.stringify({
      validServer: { command: "node", args: ["server.js"] },
      invalidEntry: { foo: "bar" },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only one valid server
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0].name).toBe("validServer");
  });

  it("handles missing env gracefully", () => {
    const json = JSON.stringify({
      server: { command: "node", args: ["server.js"] },
    });

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs[0].env).toBeUndefined();
  });

  it("handles whitespace and extra newlines around JSON", () => {
    const json = `
      {
        "myServer": {
          "command": "node",
          "args": ["server.js"]
        }
      }
    `;

    const result = parseMcpJsonConfig(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs[0].command).toBe("node");
  });
});
