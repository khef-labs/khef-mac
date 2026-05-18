import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { hashContent } from './assistant-sync';

export type AssistantCommandType = 'command' | 'skill' | 'prompt';
export type AssistantCommandScope = 'user' | 'project';

export interface AssistantCommand {
  assistant_handle: string;
  type: AssistantCommandType;
  scope: AssistantCommandScope;
  name: string;
  description?: string;
  content?: string; // Omitted in compact mode
  file_path: string;
  hash: string;
}

export interface AssistantCommandCreateInput {
  name: string;
  description?: string;
  content: string;
  scope: AssistantCommandScope;
  type: AssistantCommandType;
  projectPath?: string;
}

export interface AssistantCommandUpdateInput {
  name?: string;
  description?: string;
  content?: string;
  expected_hash?: string;
  force?: boolean;
}

export interface ConflictError {
  type: 'conflict';
  message: string;
  expected_hash: string;
  file_hash: string;
  options: Array<'force'>;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

interface AssistantPaths {
  commands: { user: string | null; project: string | null };
  skills: { user: string | null; project: string | null };
  prompts: { user: string | null; project: string | null };
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  const [, yamlContent, body] = match;
  const frontmatter: Record<string, string> = {};

  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body.trim() };
}

function buildFrontmatter(name: string, description?: string): string {
  const lines: string[] = ['---', `name: ${name}`];

  if (description && description.trim().length > 0) {
    const needsQuote = description.includes('\n') || description.includes(':');
    if (needsQuote) {
      lines.push(`description: "${description.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`description: ${description}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Name is required');
  }

  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error('Name must not include path separators');
  }

  return trimmed;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getAssistantPaths(assistantHandle: string, projectPath?: string): AssistantPaths {
  if (assistantHandle === 'claude-code') {
    const userCommands = process.env.CLAUDE_COMMANDS_DIR || path.join(os.homedir(), '.claude', 'commands');
    const userSkills = process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
    const projectCommands = projectPath ? path.join(projectPath, '.claude', 'commands') : null;
    const projectSkills = projectPath ? path.join(projectPath, '.claude', 'skills') : null;

    return {
      commands: { user: userCommands, project: projectCommands },
      skills: { user: userSkills, project: projectSkills },
      prompts: { user: null, project: null },
    };
  }

  if (assistantHandle === 'codex-cli') {
    const userPrompts = process.env.CODEX_PROMPTS_DIR || path.join(os.homedir(), '.codex', 'prompts');

    return {
      commands: { user: null, project: null },
      skills: { user: null, project: null },
      prompts: { user: userPrompts, project: null },
    };
  }

  throw new Error(`Unsupported assistant: ${assistantHandle}`);
}

function readCommandFile(filePath: string, compact = false): { name: string; description?: string; content?: string; hash: string } {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(content);
  const name = parsed.frontmatter.name || path.basename(filePath, path.extname(filePath));
  const description = parsed.frontmatter.description || undefined;

  const result: { name: string; description?: string; content?: string; hash: string } = {
    name,
    description,
    hash: hashContent(content),
  };

  if (!compact) {
    result.content = parsed.body;
  }

  return result;
}

function readSkillFile(skillDir: string, compact = false): { name: string; description?: string; content?: string; filePath: string; hash: string } | null {
  const filePath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(content);
  const name = parsed.frontmatter.name || path.basename(skillDir);
  const description = parsed.frontmatter.description || undefined;

  const result: { name: string; description?: string; content?: string; filePath: string; hash: string } = {
    name,
    description,
    filePath,
    hash: hashContent(content),
  };

  if (!compact) {
    result.content = parsed.body;
  }

  return result;
}

function listCommandsFromDir(dirPath: string, scope: AssistantCommandScope, assistantHandle: string, compact = false): AssistantCommand[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath).filter((file) => file.endsWith('.md'));
  return entries.map((file) => {
    const filePath = path.join(dirPath, file);
    const parsed = readCommandFile(filePath, compact);
    const cmd: AssistantCommand = {
      assistant_handle: assistantHandle,
      type: 'command',
      scope,
      name: parsed.name,
      description: parsed.description,
      file_path: filePath,
      hash: parsed.hash,
    };
    if (!compact) {
      cmd.content = parsed.content;
    }
    return cmd;
  });
}

function listPromptsFromDir(dirPath: string, scope: AssistantCommandScope, assistantHandle: string, compact = false): AssistantCommand[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath).filter((file) => file.endsWith('.md'));
  return entries.map((file) => {
    const filePath = path.join(dirPath, file);
    const parsed = readCommandFile(filePath, compact);
    const cmd: AssistantCommand = {
      assistant_handle: assistantHandle,
      type: 'prompt',
      scope,
      name: parsed.name,
      description: parsed.description,
      file_path: filePath,
      hash: parsed.hash,
    };
    if (!compact) {
      cmd.content = parsed.content;
    }
    return cmd;
  });
}

function listSkillsFromDir(dirPath: string, scope: AssistantCommandScope, assistantHandle: string, compact = false): AssistantCommand[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name));

  const results: AssistantCommand[] = [];
  for (const skillDir of entries) {
    const parsed = readSkillFile(skillDir, compact);
    if (!parsed) continue;
    const cmd: AssistantCommand = {
      assistant_handle: assistantHandle,
      type: 'skill',
      scope,
      name: parsed.name,
      description: parsed.description,
      file_path: parsed.filePath,
      hash: parsed.hash,
    };
    if (!compact) {
      cmd.content = parsed.content;
    }
    results.push(cmd);
  }

  return results;
}

function findByName(commands: AssistantCommand[], name: string): AssistantCommand | null {
  return commands.find((command) => command.name === name) || null;
}

export function listAssistantCommands(
  assistantHandle: string,
  options: {
    scope: 'user' | 'project' | 'all';
    type?: AssistantCommandType;
    projectPath?: string;
    compact?: boolean;
  }
): AssistantCommand[] {
  const paths = getAssistantPaths(assistantHandle, options.projectPath);
  const types = options.type ? [options.type] : ['command', 'skill', 'prompt'];
  const scopes: AssistantCommandScope[] =
    options.scope === 'all' ? ['user', 'project'] : [options.scope];
  const compact = options.compact ?? true;

  const results: AssistantCommand[] = [];

  for (const scope of scopes) {
    if (scope === 'project' && !options.projectPath) {
      continue;
    }

    for (const type of types) {
      if (type === 'command') {
        const dirPath = scope === 'user' ? paths.commands.user : paths.commands.project;
        if (!dirPath) continue;
        results.push(...listCommandsFromDir(dirPath, scope, assistantHandle, compact));
      }

      if (type === 'skill') {
        const dirPath = scope === 'user' ? paths.skills.user : paths.skills.project;
        if (!dirPath) continue;
        results.push(...listSkillsFromDir(dirPath, scope, assistantHandle, compact));
      }

      if (type === 'prompt') {
        const dirPath = scope === 'user' ? paths.prompts.user : paths.prompts.project;
        if (!dirPath) continue;
        results.push(...listPromptsFromDir(dirPath, scope, assistantHandle, compact));
      }
    }
  }

  return results;
}

export function getAssistantCommand(
  assistantHandle: string,
  name: string,
  options: {
    scope: AssistantCommandScope;
    type: AssistantCommandType;
    projectPath?: string;
  }
): AssistantCommand | null {
  // Always return full content for detail endpoint
  const commands = listAssistantCommands(assistantHandle, {
    scope: options.scope,
    type: options.type,
    projectPath: options.projectPath,
    compact: false,
  });

  return findByName(commands, name);
}

export function createAssistantCommand(
  assistantHandle: string,
  input: AssistantCommandCreateInput
): AssistantCommand {
  const name = sanitizeName(input.name);
  const description = input.description?.trim();
  const content = input.content ?? '';

  const paths = getAssistantPaths(assistantHandle, input.projectPath);
  const isProject = input.scope === 'project';

  if (input.type === 'command') {
    const dirPath = isProject ? paths.commands.project : paths.commands.user;
    if (!dirPath) {
      throw new Error('Project path required for project scope');
    }
    ensureDir(dirPath);

    const filePath = path.join(dirPath, `${name}.md`);
    if (fs.existsSync(filePath)) {
      throw new Error(`Command already exists: ${name}`);
    }

    const frontmatter = buildFrontmatter(name, description);
    const fileContent = `${frontmatter}\n\n${content}`;
    fs.writeFileSync(filePath, fileContent, 'utf8');

    return {
      assistant_handle: assistantHandle,
      type: 'command',
      scope: input.scope,
      name,
      description,
      content,
      file_path: filePath,
      hash: hashContent(fileContent),
    };
  }

  if (input.type === 'skill') {
    const dirPath = isProject ? paths.skills.project : paths.skills.user;
    if (!dirPath) {
      throw new Error('Project path required for project scope');
    }
    ensureDir(dirPath);

    const skillDir = path.join(dirPath, name);
    if (fs.existsSync(skillDir)) {
      throw new Error(`Skill already exists: ${name}`);
    }

    fs.mkdirSync(skillDir, { recursive: true });
    const filePath = path.join(skillDir, 'SKILL.md');
    const frontmatter = buildFrontmatter(name, description);
    const fileContent = `${frontmatter}\n\n${content}`;
    fs.writeFileSync(filePath, fileContent, 'utf8');

    return {
      assistant_handle: assistantHandle,
      type: 'skill',
      scope: input.scope,
      name,
      description,
      content,
      file_path: filePath,
      hash: hashContent(fileContent),
    };
  }

  if (input.type === 'prompt') {
    const dirPath = isProject ? paths.prompts.project : paths.prompts.user;
    if (!dirPath) {
      throw new Error('Prompts not supported for this assistant or scope');
    }
    ensureDir(dirPath);

    const filePath = path.join(dirPath, `${name}.md`);
    if (fs.existsSync(filePath)) {
      throw new Error(`Prompt already exists: ${name}`);
    }

    const frontmatter = buildFrontmatter(name, description);
    const fileContent = `${frontmatter}\n\n${content}`;
    fs.writeFileSync(filePath, fileContent, 'utf8');

    return {
      assistant_handle: assistantHandle,
      type: 'prompt',
      scope: input.scope,
      name,
      description,
      content,
      file_path: filePath,
      hash: hashContent(fileContent),
    };
  }

  throw new Error(`Unsupported command type: ${input.type}`);
}

export function updateAssistantCommand(
  assistantHandle: string,
  name: string,
  options: {
    scope: AssistantCommandScope;
    type: AssistantCommandType;
    projectPath?: string;
    updates: AssistantCommandUpdateInput;
  }
): AssistantCommand | ConflictError {
  const existing = getAssistantCommand(assistantHandle, name, {
    scope: options.scope,
    type: options.type,
    projectPath: options.projectPath,
  });

  if (!existing) {
    throw new Error(`Command not found: ${name}`);
  }

  const paths = getAssistantPaths(assistantHandle, options.projectPath);
  const isProject = options.scope === 'project';
  const updates = options.updates;
  const targetName = updates.name ? sanitizeName(updates.name) : existing.name;
  const targetDescription = updates.description ?? existing.description;
  const targetContent = updates.content ?? existing.content;

  let filePath = existing.file_path;
  let contentOnDisk = fs.readFileSync(existing.file_path, 'utf8');
  const currentHash = hashContent(contentOnDisk);

  if (updates.expected_hash && !updates.force && updates.expected_hash !== currentHash) {
    return {
      type: 'conflict',
      message: 'External changes detected',
      expected_hash: updates.expected_hash,
      file_hash: currentHash,
      options: ['force'],
    };
  }

  if (options.type === 'command') {
    const dirPath = isProject ? paths.commands.project : paths.commands.user;
    if (!dirPath) {
      throw new Error('Project path required for project scope');
    }

    const nextFilePath = path.join(dirPath, `${targetName}.md`);
    if (nextFilePath !== filePath && fs.existsSync(nextFilePath)) {
      throw new Error(`Command already exists: ${targetName}`);
    }

    const frontmatter = buildFrontmatter(targetName, targetDescription);
    const fileContent = `${frontmatter}\n\n${targetContent}`;

    if (nextFilePath !== filePath) {
      fs.renameSync(filePath, nextFilePath);
      filePath = nextFilePath;
    }

    fs.writeFileSync(filePath, fileContent, 'utf8');

    return {
      assistant_handle: assistantHandle,
      type: 'command',
      scope: options.scope,
      name: targetName,
      description: targetDescription,
      content: targetContent,
      file_path: filePath,
      hash: hashContent(fileContent),
    };
  }

  if (options.type === 'skill') {
    const dirPath = isProject ? paths.skills.project : paths.skills.user;
    if (!dirPath) {
      throw new Error('Project path required for project scope');
    }

    const currentDir = path.dirname(existing.file_path);
    const nextDir = path.join(dirPath, targetName);
    if (nextDir !== currentDir && fs.existsSync(nextDir)) {
      throw new Error(`Skill already exists: ${targetName}`);
    }

    if (nextDir !== currentDir) {
      fs.renameSync(currentDir, nextDir);
      filePath = path.join(nextDir, 'SKILL.md');
    }

    const frontmatter = buildFrontmatter(targetName, targetDescription);
    const fileContent = `${frontmatter}\n\n${targetContent}`;
    fs.writeFileSync(filePath, fileContent, 'utf8');

    return {
      assistant_handle: assistantHandle,
      type: 'skill',
      scope: options.scope,
      name: targetName,
      description: targetDescription,
      content: targetContent,
      file_path: filePath,
      hash: hashContent(fileContent),
    };
  }

  if (options.type === 'prompt') {
    const dirPath = isProject ? paths.prompts.project : paths.prompts.user;
    if (!dirPath) {
      throw new Error('Prompts not supported for this assistant or scope');
    }

    const nextFilePath = path.join(dirPath, `${targetName}.md`);
    if (nextFilePath !== filePath && fs.existsSync(nextFilePath)) {
      throw new Error(`Prompt already exists: ${targetName}`);
    }

    const frontmatter = buildFrontmatter(targetName, targetDescription);
    const fileContent = `${frontmatter}\n\n${targetContent}`;

    if (nextFilePath !== filePath) {
      fs.renameSync(filePath, nextFilePath);
      filePath = nextFilePath;
    }

    fs.writeFileSync(filePath, fileContent, 'utf8');

    return {
      assistant_handle: assistantHandle,
      type: 'prompt',
      scope: options.scope,
      name: targetName,
      description: targetDescription,
      content: targetContent,
      file_path: filePath,
      hash: hashContent(fileContent),
    };
  }

  throw new Error(`Unsupported command type: ${options.type}`);
}

export function deleteAssistantCommand(
  assistantHandle: string,
  name: string,
  options: {
    scope: AssistantCommandScope;
    type: AssistantCommandType;
    projectPath?: string;
  }
): boolean {
  const existing = getAssistantCommand(assistantHandle, name, {
    scope: options.scope,
    type: options.type,
    projectPath: options.projectPath,
  });

  if (!existing) {
    return false;
  }

  if (options.type === 'command') {
    fs.unlinkSync(existing.file_path);
    return true;
  }

  if (options.type === 'skill') {
    const dirPath = path.dirname(existing.file_path);
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  }

  if (options.type === 'prompt') {
    fs.unlinkSync(existing.file_path);
    return true;
  }

  throw new Error(`Unsupported command type: ${options.type}`);
}

export interface SyncResult {
  name: string;
  file_path: string;
  action: 'created' | 'updated' | 'unchanged';
}

function syncBuiltInSkills(assistantHandle: string): SyncResult[] {
  if (assistantHandle !== 'claude-code') {
    return [];
  }

  const targetDir = process.env.CLAUDE_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
  const libSkillsDir = process.env.KF_SKILLS_DIR || path.join(__dirname, '../../lib/skills');

  if (!fs.existsSync(libSkillsDir)) {
    return [];
  }

  ensureDir(targetDir);

  const results: SyncResult[] = [];
  const skillDirs = fs
    .readdirSync(libSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  for (const entry of skillDirs) {
    const sourceDir = path.join(libSkillsDir, entry.name);
    const targetSkillDir = path.join(targetDir, entry.name);
    const sourceSkillFile = path.join(sourceDir, 'SKILL.md');

    if (!fs.existsSync(sourceSkillFile)) continue;

    const sourceContent = fs.readFileSync(sourceSkillFile, 'utf8');
    const targetSkillFile = path.join(targetSkillDir, 'SKILL.md');

    let action: 'created' | 'updated' | 'unchanged' = 'unchanged';

    if (!fs.existsSync(targetSkillFile)) {
      ensureDir(targetSkillDir);
      fs.writeFileSync(targetSkillFile, sourceContent, 'utf8');
      action = 'created';
    } else {
      const existingContent = fs.readFileSync(targetSkillFile, 'utf8');
      if (existingContent !== sourceContent) {
        fs.writeFileSync(targetSkillFile, sourceContent, 'utf8');
        action = 'updated';
      }
    }

    results.push({
      name: entry.name,
      file_path: targetSkillFile,
      action,
    });
  }

  return results;
}

function syncBuiltInAgents(assistantHandle: string): SyncResult[] {
  if (assistantHandle !== 'claude-code') {
    return [];
  }

  const targetDir = process.env.CLAUDE_AGENTS_DIR || path.join(os.homedir(), '.claude', 'agents');
  const libAgentsDir = process.env.KF_AGENTS_DIR || path.join(__dirname, '../../lib/agents');

  if (!fs.existsSync(libAgentsDir)) {
    return [];
  }

  ensureDir(targetDir);

  const results: SyncResult[] = [];
  const files = fs.readdirSync(libAgentsDir).filter((f) => f.endsWith('.md'));

  for (const filename of files) {
    const sourcePath = path.join(libAgentsDir, filename);
    const targetPath = path.join(targetDir, filename);
    const sourceContent = fs.readFileSync(sourcePath, 'utf8');

    let action: 'created' | 'updated' | 'unchanged' = 'unchanged';

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, sourceContent, 'utf8');
      action = 'created';
    } else {
      const existingContent = fs.readFileSync(targetPath, 'utf8');
      if (existingContent !== sourceContent) {
        fs.writeFileSync(targetPath, sourceContent, 'utf8');
        action = 'updated';
      }
    }

    results.push({
      name: filename.replace(/\.md$/, ''),
      file_path: targetPath,
      action,
    });
  }

  return results;
}

export function syncBuiltInCommands(assistantHandle: string): SyncResult[] {
  // Determine target directory based on assistant
  let targetDir: string;
  if (assistantHandle === 'claude-code') {
    targetDir = process.env.CLAUDE_COMMANDS_DIR || path.join(os.homedir(), '.claude', 'commands');
  } else if (assistantHandle === 'codex-cli') {
    targetDir = process.env.CODEX_PROMPTS_DIR || path.join(os.homedir(), '.codex', 'prompts');
  } else {
    throw new Error(`Unsupported assistant: ${assistantHandle}`);
  }

  // Built-in commands are in lib/prompts/ relative to project root
  const libCommandsDir = process.env.KF_COMMANDS_DIR || path.join(__dirname, '../../lib/prompts');

  if (!fs.existsSync(libCommandsDir)) {
    return [];
  }

  ensureDir(targetDir);

  const results: SyncResult[] = [];
  const files = fs.readdirSync(libCommandsDir).filter((f) => f.startsWith('kf-') && f.endsWith('.md'));

  for (const filename of files) {
    const sourcePath = path.join(libCommandsDir, filename);
    const targetPath = path.join(targetDir, filename);
    const sourceContent = fs.readFileSync(sourcePath, 'utf8');

    let action: 'created' | 'updated' | 'unchanged' = 'unchanged';

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, sourceContent, 'utf8');
      action = 'created';
    } else {
      const existingContent = fs.readFileSync(targetPath, 'utf8');
      if (existingContent !== sourceContent) {
        fs.writeFileSync(targetPath, sourceContent, 'utf8');
        action = 'updated';
      }
    }

    results.push({
      name: filename.replace(/\.md$/, ''),
      file_path: targetPath,
      action,
    });
  }

  // Also sync built-in skills
  results.push(...syncBuiltInSkills(assistantHandle));

  // Also sync built-in agents
  results.push(...syncBuiltInAgents(assistantHandle));

  return results;
}
