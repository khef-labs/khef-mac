import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'agents' });

export interface Agent {
  name: string;
  description: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
  skills?: string[];
  prompt?: string; // The markdown body (system prompt) - omitted in compact mode
  filePath: string;
  scope: 'user' | 'project';
}

export interface UserAgentsResult {
  agents: Agent[];
  agentsPath: string;
}

export interface ProjectAgentsResult {
  agents: Agent[];
  agentsPath: string | null; // null if project has no path configured
}

// Agent directory paths by assistant
const AGENT_PATHS: Record<string, { user: string; project: string }> = {
  'claude-code': {
    user: path.join(os.homedir(), '.claude', 'agents'),
    project: '.claude/agents',
  },
};

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlContent, body] = match;
  const frontmatter: Record<string, any> = {};

  // Simple YAML parsing for agent frontmatter
  const lines = yamlContent.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Handle quoted strings
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle arrays (comma-separated or YAML list format)
    if (key === 'tools' || key === 'disallowedTools' || key === 'skills') {
      if (value.startsWith('[') && value.endsWith(']')) {
        // JSON-style array
        try {
          frontmatter[key] = JSON.parse(value);
        } catch {
          frontmatter[key] = value.slice(1, -1).split(',').map(s => s.trim());
        }
      } else if (value) {
        // Comma-separated
        frontmatter[key] = value.split(',').map(s => s.trim());
      }
    } else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Parse a single agent markdown file
 * @param compact - If true, omit the prompt (body) to reduce I/O
 */
function parseAgentFile(filePath: string, scope: 'user' | 'project', compact = false): Agent | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) {
      log.warn({ filePath }, 'Agent file missing required fields');
      return null;
    }

    const agent: Agent = {
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: frontmatter.tools,
      disallowedTools: frontmatter.disallowedTools,
      permissionMode: frontmatter.permissionMode,
      skills: frontmatter.skills,
      filePath,
      scope,
    };

    if (!compact) {
      agent.prompt = body;
    }

    return agent;
  } catch (err) {
    log.error({ err, filePath }, 'Failed to parse agent file');
    return null;
  }
}

/**
 * Get user-level agents for an assistant
 * @param compact - If true (default), omit prompt from results
 */
export function getUserAgents(assistantHandle: string, compact = true): UserAgentsResult {
  const paths = AGENT_PATHS[assistantHandle];
  if (!paths) {
    return { agents: [], agentsPath: '' };
  }

  const agents: Agent[] = [];
  const agentsPath = paths.user;

  if (fs.existsSync(agentsPath)) {
    const files = fs.readdirSync(agentsPath).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const agent = parseAgentFile(path.join(agentsPath, file), 'user', compact);
      if (agent) agents.push(agent);
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, agentsPath };
}

/**
 * Get project-level agents for an assistant
 * @param projectPath - The resolved filesystem path to the project (not the khef project ID)
 * @param compact - If true (default), omit prompt from results
 */
export function getProjectAgents(assistantHandle: string, projectPath: string | null, compact = true): ProjectAgentsResult {
  const paths = AGENT_PATHS[assistantHandle];
  if (!paths) {
    return { agents: [], agentsPath: null };
  }

  if (!projectPath) {
    return { agents: [], agentsPath: null };
  }

  const agents: Agent[] = [];
  const agentsPath = path.join(projectPath, paths.project);

  if (fs.existsSync(agentsPath)) {
    const files = fs.readdirSync(agentsPath).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const agent = parseAgentFile(path.join(agentsPath, file), 'project', compact);
      if (agent) agents.push(agent);
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, agentsPath };
}

/**
 * Get a single user-level agent by name (always returns full content)
 */
export function getUserAgent(assistantHandle: string, agentName: string): Agent | null {
  const { agents } = getUserAgents(assistantHandle, false);
  return agents.find(a => a.name === agentName) || null;
}

/**
 * Get a single project-level agent by name (always returns full content)
 */
export function getProjectAgent(assistantHandle: string, agentName: string, projectPath: string | null): Agent | null {
  const { agents } = getProjectAgents(assistantHandle, projectPath, false);
  return agents.find(a => a.name === agentName) || null;
}

/**
 * Generate frontmatter YAML from agent data
 */
function generateFrontmatter(agent: Omit<Agent, 'filePath' | 'scope' | 'prompt'>): string {
  const lines: string[] = ['---'];

  lines.push(`name: ${agent.name}`);

  // Escape description if it contains special characters
  if (agent.description.includes('\n') || agent.description.includes(':')) {
    lines.push(`description: "${agent.description.replace(/"/g, '\\"')}"`);
  } else {
    lines.push(`description: ${agent.description}`);
  }

  if (agent.model) {
    lines.push(`model: ${agent.model}`);
  }

  if (agent.tools && agent.tools.length > 0) {
    lines.push(`tools: ${agent.tools.join(', ')}`);
  }

  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    lines.push(`disallowedTools: ${agent.disallowedTools.join(', ')}`);
  }

  if (agent.permissionMode) {
    lines.push(`permissionMode: ${agent.permissionMode}`);
  }

  if (agent.skills && agent.skills.length > 0) {
    lines.push(`skills: ${agent.skills.join(', ')}`);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Create a new user-level agent
 */
export function createUserAgent(
  assistantHandle: string,
  agent: Omit<Agent, 'filePath' | 'scope'>
): Agent {
  const paths = AGENT_PATHS[assistantHandle];
  if (!paths) {
    throw new Error(`Unknown assistant: ${assistantHandle}`);
  }

  const agentsDir = paths.user;

  // Ensure directory exists
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  // Generate filename from name
  const filename = `${agent.name}.md`;
  const filePath = path.join(agentsDir, filename);

  // Check if already exists
  if (fs.existsSync(filePath)) {
    throw new Error(`Agent already exists: ${agent.name}`);
  }

  // Generate content
  const frontmatter = generateFrontmatter(agent);
  const content = `${frontmatter}\n\n${agent.prompt}`;

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    ...agent,
    filePath,
    scope: 'user',
  };
}

/**
 * Create a new project-level agent
 */
export function createProjectAgent(
  assistantHandle: string,
  agent: Omit<Agent, 'filePath' | 'scope'>,
  projectPath: string
): Agent {
  const paths = AGENT_PATHS[assistantHandle];
  if (!paths) {
    throw new Error(`Unknown assistant: ${assistantHandle}`);
  }

  const agentsDir = path.join(projectPath, paths.project);

  // Ensure directory exists
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  // Generate filename from name
  const filename = `${agent.name}.md`;
  const filePath = path.join(agentsDir, filename);

  // Check if already exists
  if (fs.existsSync(filePath)) {
    throw new Error(`Agent already exists: ${agent.name}`);
  }

  // Generate content
  const frontmatter = generateFrontmatter(agent);
  const content = `${frontmatter}\n\n${agent.prompt}`;

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    ...agent,
    filePath,
    scope: 'project',
  };
}

/**
 * Update an existing user-level agent
 */
export function updateUserAgent(
  assistantHandle: string,
  agentName: string,
  updates: Partial<Omit<Agent, 'filePath' | 'scope'>>
): Agent {
  const existing = getUserAgent(assistantHandle, agentName);
  if (!existing) {
    throw new Error(`Agent not found: ${agentName}`);
  }

  return updateAgentInternal(existing, updates);
}

/**
 * Update an existing project-level agent
 */
export function updateProjectAgent(
  assistantHandle: string,
  agentName: string,
  updates: Partial<Omit<Agent, 'filePath' | 'scope'>>,
  projectPath: string
): Agent {
  const existing = getProjectAgent(assistantHandle, agentName, projectPath);
  if (!existing) {
    throw new Error(`Agent not found: ${agentName}`);
  }

  return updateAgentInternal(existing, updates);
}

function updateAgentInternal(
  existing: Agent,
  updates: Partial<Omit<Agent, 'filePath' | 'scope'>>
): Agent {
  const updated = {
    name: updates.name ?? existing.name,
    description: updates.description ?? existing.description,
    model: updates.model ?? existing.model,
    tools: updates.tools ?? existing.tools,
    disallowedTools: updates.disallowedTools ?? existing.disallowedTools,
    permissionMode: updates.permissionMode ?? existing.permissionMode,
    skills: updates.skills ?? existing.skills,
    prompt: updates.prompt ?? existing.prompt,
  };

  // Generate content
  const frontmatter = generateFrontmatter(updated);
  const content = `${frontmatter}\n\n${updated.prompt}`;

  // Handle rename
  let filePath = existing.filePath;
  if (updates.name && updates.name !== existing.name) {
    const newFilePath = path.join(path.dirname(existing.filePath), `${updates.name}.md`);
    if (fs.existsSync(newFilePath)) {
      throw new Error(`Agent already exists: ${updates.name}`);
    }
    fs.unlinkSync(existing.filePath);
    filePath = newFilePath;
  }

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    ...updated,
    filePath,
    scope: existing.scope,
  };
}

/**
 * Delete a user-level agent
 */
export function deleteUserAgent(
  assistantHandle: string,
  agentName: string
): boolean {
  const existing = getUserAgent(assistantHandle, agentName);
  if (!existing) {
    return false;
  }

  fs.unlinkSync(existing.filePath);
  return true;
}

/**
 * Delete a project-level agent
 */
export function deleteProjectAgent(
  assistantHandle: string,
  agentName: string,
  projectPath: string
): boolean {
  const existing = getProjectAgent(assistantHandle, agentName, projectPath);
  if (!existing) {
    return false;
  }

  fs.unlinkSync(existing.filePath);
  return true;
}
