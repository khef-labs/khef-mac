import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import assistantRoutes from '../../src/routes/assistants';
import projectRoutes from '../../src/routes/projects';

describe('Assistant Commands API', () => {
  let app: FastifyInstance;
  let client: Client;
  let tempRoot: string;
  let userCommandsDir: string;
  let userSkillsDir: string;
  let codexPromptsDir: string;
  let mzCommandsDir: string;
  let projectRoot: string;
  let projectId: string;

  beforeAll(async () => {
    await setupTestDb();

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khef-commands-'));
    userCommandsDir = path.join(tempRoot, 'claude-commands');
    userSkillsDir = path.join(tempRoot, 'claude-skills');
    codexPromptsDir = path.join(tempRoot, 'codex-prompts');
    mzCommandsDir = path.join(tempRoot, 'kf-commands');

    process.env.CLAUDE_COMMANDS_DIR = userCommandsDir;
    process.env.CLAUDE_SKILLS_DIR = userSkillsDir;
    process.env.CODEX_PROMPTS_DIR = codexPromptsDir;
    process.env.KF_COMMANDS_DIR = mzCommandsDir;

    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(assistantRoutes, { prefix: '/api/assistants' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    fs.rmSync(userCommandsDir, { recursive: true, force: true });
    fs.rmSync(userSkillsDir, { recursive: true, force: true });
    fs.rmSync(codexPromptsDir, { recursive: true, force: true });
    fs.mkdirSync(userCommandsDir, { recursive: true });
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.mkdirSync(codexPromptsDir, { recursive: true });

    projectRoot = path.join(tempRoot, 'project');
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Command Test Project', path: projectRoot }
    });
    projectId = JSON.parse(projectRes.payload).project.id;
  });

  it('creates, lists, updates, and deletes commands and skills', async () => {
    const createUserCommand = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands',
      payload: {
        name: 'User Command',
        description: 'User command description',
        content: 'Run something',
        scope: 'user',
        type: 'command'
      }
    });
    expect(createUserCommand.statusCode).toBe(201);
    const userCommand = JSON.parse(createUserCommand.payload).command;
    expect(fs.existsSync(userCommand.file_path)).toBe(true);

    const createUserSkill = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands',
      payload: {
        name: 'User Skill',
        description: 'User skill description',
        content: 'You are a helper.',
        scope: 'user',
        type: 'skill'
      }
    });
    expect(createUserSkill.statusCode).toBe(201);
    const userSkill = JSON.parse(createUserSkill.payload).command;
    expect(userSkill.file_path.endsWith('SKILL.md')).toBe(true);
    expect(fs.existsSync(userSkill.file_path)).toBe(true);

    const createProjectCommand = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands',
      payload: {
        name: 'Project Command',
        description: 'Project command description',
        content: 'Run project command',
        scope: 'project',
        type: 'command',
        project: projectId
      }
    });
    expect(createProjectCommand.statusCode).toBe(201);

    const createProjectSkill = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands',
      payload: {
        name: 'Project Skill',
        description: 'Project skill description',
        content: 'You are a project helper.',
        scope: 'project',
        type: 'skill',
        project: projectId
      }
    });
    expect(createProjectSkill.statusCode).toBe(201);

    const listAll = await app.inject({
      method: 'GET',
      url: `/api/assistants/claude-code/commands?scope=all&project=${projectId}`
    });
    expect(listAll.statusCode).toBe(200);
    const listBody = JSON.parse(listAll.payload);
    expect(listBody.commands).toHaveLength(4);
    listBody.commands.forEach((command: any) => {
      expect(command.file_path).toBeTruthy();
      expect(command.assistant_handle).toBe('claude-code');
    });

    const getUserSkill = await app.inject({
      method: 'GET',
      url: '/api/assistants/claude-code/commands/User%20Skill?scope=user&type=skill'
    });
    expect(getUserSkill.statusCode).toBe(200);

    const updateCommand = await app.inject({
      method: 'PATCH',
      url: '/api/assistants/claude-code/commands/User%20Command?scope=user&type=command',
      payload: {
        content: 'Updated content',
        expected_hash: userCommand.hash
      }
    });
    expect(updateCommand.statusCode).toBe(200);
    const updated = JSON.parse(updateCommand.payload).command;
    expect(updated.content).toBe('Updated content');

    const conflictUpdate = await app.inject({
      method: 'PATCH',
      url: '/api/assistants/claude-code/commands/User%20Command?scope=user&type=command',
      payload: {
        content: 'Another update',
        expected_hash: 'sha256:deadbeef'
      }
    });
    expect(conflictUpdate.statusCode).toBe(409);

    const deleteProjectSkill = await app.inject({
      method: 'DELETE',
      url: `/api/assistants/claude-code/commands/Project%20Skill?scope=project&type=skill&project=${projectId}`
    });
    expect(deleteProjectSkill.statusCode).toBe(200);
  });

  it('creates, lists, updates, and deletes codex-cli prompts', async () => {
    // Create a prompt
    const createPrompt = await app.inject({
      method: 'POST',
      url: '/api/assistants/codex-cli/commands',
      payload: {
        name: 'Test Prompt',
        description: 'A test prompt for codex',
        content: 'You are a helpful assistant.',
        scope: 'user',
        type: 'prompt'
      }
    });
    expect(createPrompt.statusCode).toBe(201);
    const prompt = JSON.parse(createPrompt.payload).command;
    expect(prompt.type).toBe('prompt');
    expect(prompt.assistant_handle).toBe('codex-cli');
    expect(fs.existsSync(prompt.file_path)).toBe(true);

    // List prompts
    const listPrompts = await app.inject({
      method: 'GET',
      url: '/api/assistants/codex-cli/commands?scope=user&type=prompt'
    });
    expect(listPrompts.statusCode).toBe(200);
    const listBody = JSON.parse(listPrompts.payload);
    expect(listBody.commands).toHaveLength(1);
    expect(listBody.commands[0].name).toBe('Test Prompt');

    // Get single prompt
    const getPrompt = await app.inject({
      method: 'GET',
      url: '/api/assistants/codex-cli/commands/Test%20Prompt?scope=user&type=prompt'
    });
    expect(getPrompt.statusCode).toBe(200);

    // Update prompt
    const updatePrompt = await app.inject({
      method: 'PATCH',
      url: '/api/assistants/codex-cli/commands/Test%20Prompt?scope=user&type=prompt',
      payload: {
        content: 'Updated prompt content',
        expected_hash: prompt.hash
      }
    });
    expect(updatePrompt.statusCode).toBe(200);
    const updated = JSON.parse(updatePrompt.payload).command;
    expect(updated.content).toBe('Updated prompt content');

    // Delete prompt
    const deletePrompt = await app.inject({
      method: 'DELETE',
      url: '/api/assistants/codex-cli/commands/Test%20Prompt?scope=user&type=prompt'
    });
    expect(deletePrompt.statusCode).toBe(200);

    // Verify deleted
    const listAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/assistants/codex-cli/commands?scope=user&type=prompt'
    });
    expect(JSON.parse(listAfterDelete.payload).commands).toHaveLength(0);
  });

  it('rejects project scope for codex-cli prompts', async () => {
    const createProjectPrompt = await app.inject({
      method: 'POST',
      url: '/api/assistants/codex-cli/commands',
      payload: {
        name: 'Project Prompt',
        description: 'Should fail',
        content: 'Content',
        scope: 'project',
        type: 'prompt',
        project: projectId
      }
    });
    expect(createProjectPrompt.statusCode).toBe(400);
    expect(JSON.parse(createProjectPrompt.payload).error).toContain('not supported');
  });

  it('syncs built-in commands to both claude-code and codex-cli', async () => {
    // Set up a test mz command
    fs.mkdirSync(mzCommandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(mzCommandsDir, 'kf-test-command.md'),
      '---\nname: kf-test-command\ndescription: Test command\n---\n\nTest content',
      'utf8'
    );

    // Sync to claude-code
    const claudeSync = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands/sync'
    });
    expect(claudeSync.statusCode).toBe(200);
    const claudeResults = JSON.parse(claudeSync.payload).results;
    const claudeTestCmd = claudeResults.find((r: any) => r.name === 'kf-test-command');
    expect(claudeTestCmd).toBeDefined();
    expect(claudeTestCmd.action).toBe('created');
    expect(fs.existsSync(path.join(userCommandsDir, 'kf-test-command.md'))).toBe(true);

    // Sync to codex-cli
    const codexSync = await app.inject({
      method: 'POST',
      url: '/api/assistants/codex-cli/commands/sync'
    });
    expect(codexSync.statusCode).toBe(200);
    const codexResults = JSON.parse(codexSync.payload).results;
    const codexTestCmd = codexResults.find((r: any) => r.name === 'kf-test-command');
    expect(codexTestCmd).toBeDefined();
    expect(codexTestCmd.action).toBe('created');
    expect(fs.existsSync(path.join(codexPromptsDir, 'kf-test-command.md'))).toBe(true);

    // Verify both files have the same content
    const claudeContent = fs.readFileSync(path.join(userCommandsDir, 'kf-test-command.md'), 'utf8');
    const codexContent = fs.readFileSync(path.join(codexPromptsDir, 'kf-test-command.md'), 'utf8');
    expect(claudeContent).toBe(codexContent);

    // Re-sync should report unchanged
    const claudeResync = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands/sync'
    });
    const resyncResults = JSON.parse(claudeResync.payload).results;
    const resyncTestCmd = resyncResults.find((r: any) => r.name === 'kf-test-command');
    expect(resyncTestCmd.action).toBe('unchanged');
  });

  it('returns compact results by default, full content with compact=false', async () => {
    // Create a command with content
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/commands',
      payload: {
        name: 'Compact Test',
        description: 'Test description',
        content: 'This is the command content',
        scope: 'user',
        type: 'command'
      }
    });
    expect(createRes.statusCode).toBe(201);

    // List without compact param - should return compact (no content)
    const listCompact = await app.inject({
      method: 'GET',
      url: '/api/assistants/claude-code/commands?scope=user&type=command'
    });
    expect(listCompact.statusCode).toBe(200);
    const compactBody = JSON.parse(listCompact.payload);
    expect(compactBody.commands).toHaveLength(1);
    expect(compactBody.commands[0].name).toBe('Compact Test');
    expect(compactBody.commands[0].content).toBeUndefined();

    // List with compact=false - should return full content
    const listFull = await app.inject({
      method: 'GET',
      url: '/api/assistants/claude-code/commands?scope=user&type=command&compact=false'
    });
    expect(listFull.statusCode).toBe(200);
    const fullBody = JSON.parse(listFull.payload);
    expect(fullBody.commands).toHaveLength(1);
    expect(fullBody.commands[0].name).toBe('Compact Test');
    expect(fullBody.commands[0].content).toBe('This is the command content');

    // Get by name - should always return full content
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/assistants/claude-code/commands/Compact%20Test?scope=user&type=command'
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.payload);
    expect(getBody.command.name).toBe('Compact Test');
    expect(getBody.command.content).toBe('This is the command content');
  });
});
