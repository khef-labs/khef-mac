import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { getMcpServers, McpServer } from '../services/mcp-servers';

interface AssistantIssues {
  handle: string;
  name: string;
  issues: number;
  servers: McpServer[];
}

const mcpServersRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/mcp-servers/health - Aggregate MCP server health across all assistants
  fastify.get('/health', async () => {
    // Get all assistants
    const assistants = await query<{ handle: string; name: string }>(
      'SELECT handle, name FROM assistants ORDER BY name'
    );

    let totalIssues = 0;
    const byAssistant: AssistantIssues[] = [];

    for (const assistant of assistants) {
      const result = await getMcpServers(assistant.handle);
      totalIssues += result.issues;

      if (result.servers.length > 0) {
        byAssistant.push({
          handle: assistant.handle,
          name: assistant.name,
          issues: result.issues,
          servers: result.servers,
        });
      }
    }

    return {
      issues: totalIssues,
      assistants: byAssistant,
    };
  });
};

export default mcpServersRoutes;
