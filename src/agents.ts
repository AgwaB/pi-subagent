import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { THINKING_LEVELS, type AgentScope, type ThinkingLevel } from "./core/constants.ts";

export type AgentSource = "global" | "project";

export interface AgentDefinition {
  name: string;
  displayName: string;
  description?: string;
  aliases: string[];
  source: AgentSource;
  sourcePath: string;
  body: string;
  frontmatter: Record<string, unknown>;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPromptMode?: "append" | "replace" | string;
}

export interface AgentRegistry {
  agents: AgentDefinition[];
  byAlias: Map<string, AgentDefinition>;
  projectAgentsDir: string | null;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSafeAgentName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name) && name.split(".").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function thinkingValue(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevel : undefined;
}

function toolsValue(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const tools = uniqueStrings(raw.map((entry) => typeof entry === "string" ? entry.trim() : undefined));
  return tools.length > 0 ? tools : undefined;
}

function toDottedName(path: string): string {
  return path.split(sep).join(".");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): unknown {
  const stripped = stripQuotes(value.trim());
  if (stripped === "true") return true;
  if (stripped === "false") return false;
  const numeric = Number(stripped);
  if (stripped.length > 0 && Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(stripped)) return numeric;
  return stripped;
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: markdown };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { frontmatter: {}, body: markdown };
  return {
    frontmatter: parseSimpleYaml(lines.slice(1, end).join("\n")),
    body: lines.slice(end + 1).join("\n").replace(/^\s+/, ""),
  };
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentListKey: string | undefined;

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const listItem = rawLine.match(/^\s+-\s*(.*)$/);
    if (listItem) {
      if (!currentListKey || !Array.isArray(result[currentListKey])) continue;
      (result[currentListKey] as string[]).push(stripQuotes(listItem[1]!.trim()));
      continue;
    }

    if (/^\s/.test(rawLine)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1]!;
    const rawValue = match[2] ?? "";
    if (rawValue.trim() === "") {
      result[key] = [];
      currentListKey = key;
      continue;
    }
    currentListKey = undefined;
    result[key] = parseScalar(rawValue);
  }
  return result;
}

async function hasGitBoundary(directory: string): Promise<boolean> {
  try {
    const info = await lstat(join(directory, ".git"));
    return info.isDirectory() || info.isFile() || info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function findNearestProjectAgentsDir(cwd: string): Promise<string | null> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".pi", "agents");
    try {
      const info = await lstat(candidate);
      if (info.isDirectory()) return candidate;
      if (info.isSymbolicLink()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (await hasGitBoundary(current)) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function agentRoots(cwd: string, scope: AgentScope | undefined): Promise<Array<{ path: string; source: AgentSource }>> {
  const globalRoot = join(homedir(), ".pi", "agent", "agents");
  const projectRoot = await findNearestProjectAgentsDir(cwd);
  if (scope === "global") return [{ path: globalRoot, source: "global" }];
  if (scope === "project") return projectRoot ? [{ path: projectRoot, source: "project" }] : [];
  const roots: Array<{ path: string; source: AgentSource }> = [{ path: globalRoot, source: "global" }];
  if (projectRoot) roots.push({ path: projectRoot, source: "project" });
  return roots;
}

async function listMarkdownFiles(root: string, source: AgentSource): Promise<string[]> {
  try {
    const rootStat = await lstat(root);
    if (source === "project" && rootStat.isSymbolicLink()) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const file = join(root, entry.name);
      if (entry.isDirectory()) return await listMarkdownFiles(file, source);
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) return [file];
      return [];
    }));
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readAgentFile(file: string, root: string, source: AgentSource): Promise<AgentDefinition> {
  const rootPath = resolve(root);
  const sourcePath = resolve(file);
  if (!isInsideOrEqual(rootPath, sourcePath)) throw new Error(`agent path escapes root: ${sourcePath}`);
  const rootStat = await lstat(rootPath);
  if (source === "project" && rootStat.isSymbolicLink()) throw new Error(`project agent root must not be a symlink: ${rootPath}`);
  const realRoot = await realpath(rootPath);
  const realSource = await realpath(sourcePath);
  if (!isInsideOrEqual(realRoot, realSource)) throw new Error(`agent symlink escapes root: ${sourcePath}`);

  const markdown = await readFile(realSource, "utf8");
  return parseAgentMarkdown(markdown, realSource, source, realRoot);
}

export function parseAgentMarkdown(markdown: string, sourcePath: string, source: AgentSource, rootPath?: string): AgentDefinition {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const fileBaseName = basename(sourcePath, ".md");
  const relativeName = rootPath ? toDottedName(relative(rootPath, sourcePath).replace(/\.md$/, "")) : fileBaseName;
  const name = stringValue(frontmatter.name) ?? fileBaseName;
  const packageName = stringValue(frontmatter.package);
  const displayName = packageName ? `${packageName}.${name}` : relativeName || name;
  const aliases = uniqueStrings([
    displayName,
    relativeName,
    name,
    packageName ? `${packageName}.${name}` : undefined,
    dirname(relativeName) !== "." ? `${toDottedName(dirname(relativeName))}.${name}` : undefined,
  ]);

  return {
    name,
    displayName,
    description: stringValue(frontmatter.description),
    aliases,
    source,
    sourcePath,
    body,
    frontmatter,
    model: stringValue(frontmatter.model),
    thinking: thinkingValue(frontmatter.thinking),
    tools: toolsValue(frontmatter.tools),
    systemPromptMode: stringValue(frontmatter.systemPromptMode),
  };
}

export async function discoverAgents(cwd: string, scope?: AgentScope): Promise<AgentRegistry> {
  const byAlias = new Map<string, AgentDefinition>();
  const byPath = new Map<string, AgentDefinition>();
  const roots = await agentRoots(cwd, scope);
  const projectAgentsDir = roots.find((root) => root.source === "project")?.path ?? await findNearestProjectAgentsDir(cwd);

  for (const root of roots) {
    const files = await listMarkdownFiles(root.path, root.source);
    for (const file of files) {
      const agent = await readAgentFile(file, root.path, root.source);
      let accepted = false;
      for (const alias of agent.aliases) {
        if (!byAlias.has(alias)) {
          byAlias.set(alias, agent);
          accepted = true;
        }
      }
      if (accepted && !byPath.has(agent.sourcePath)) byPath.set(agent.sourcePath, agent);
    }
  }

  return {
    agents: [...byPath.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    byAlias,
    projectAgentsDir,
  };
}

function candidateAgentPaths(name: string, roots: Array<{ path: string; source: AgentSource }>): Array<{ file: string; root: string; source: AgentSource }> {
  if (!isSafeAgentName(name)) return [];
  const pathName = name.replaceAll(".", sep);
  const candidates = uniqueStrings([`${pathName}.md`, `${name}.md`]);
  return roots.flatMap((root) => candidates.flatMap((candidate) => {
    const rootPath = resolve(root.path);
    const file = resolve(rootPath, candidate);
    if (!isInsideOrEqual(rootPath, file)) return [];
    return [{ file, root: rootPath, source: root.source }];
  }));
}

export async function loadAgentByName(name: string, cwd: string, scope?: AgentScope): Promise<AgentDefinition | undefined> {
  if (!isSafeAgentName(name)) return undefined;
  const roots = await agentRoots(cwd, scope);
  for (const candidate of candidateAgentPaths(name, roots)) {
    try {
      return await readAgentFile(candidate.file, candidate.root, candidate.source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (String((error as Error).message).includes("project agent root must not be a symlink")) continue;
      throw error;
    }
  }
  const registry = await discoverAgents(cwd, scope);
  return registry.byAlias.get(name);
}

export function buildAgentSystemPrompt(agent: AgentDefinition): string {
  return [
    `You are Pi subagent '${agent.displayName}'.`,
    agent.description ? `Agent description: ${agent.description}` : undefined,
    "Do not assume parent conversation history unless it is provided in the task.",
    "Do not launch other subagents unless explicitly instructed.",
    "",
    "# Agent Definition",
    agent.body.trim(),
  ].filter((line): line is string => line !== undefined).join("\n").trim();
}
