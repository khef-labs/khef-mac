import './env';
import Fastify from 'fastify';
import { logger } from './lib/logger';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { closePool } from './db/client';
import projectRoutes from './routes/projects';
import projectMemoryRoutes from './routes/project-memories';
import memoryRoutes from './routes/memories';
import memoryTypeRoutes from './routes/memory-types';
import tagRoutes from './routes/tags';
import relationRoutes from './routes/relations';
import relationTypeRoutes from './routes/relation-types';
import memoryRelationsRoutes from './routes/memory-relations';
import sessionRoutes from './routes/session';
import diagramRoutes from './routes/diagram';
import editorRoutes from './routes/editor';
import settingsRoutes from './routes/settings';
import { projectFileRoutes, globalFileRoutes } from './routes/files';
import projectKnowledgeRoutes from './routes/project-knowledge';
import projectStatsRoutes from './routes/project-stats';
import assistantRoutes from './routes/assistants';
import configRoutes from './routes/assistant-configs';
import projectConfigRoutes from './routes/project-configs';
import projectPlansRoutes from './routes/project-plans';
import rulesRoutes from './routes/rules';
import mcpServersRoutes from './routes/mcp-servers';
import commentRoutes from './routes/comments';
import globalCommentRoutes from './routes/global-comments';
import memoryExportRoutes from './routes/memory-export';
import assistantSessionRoutes from './routes/assistant-sessions';
import assistantPlanRoutes from './routes/assistant-plans';
import planRoutes from './routes/plans';
import statsRoutes from './routes/stats';
import notificationRoutes from './routes/notifications';
import { startMemoryWatcher, stopMemoryWatcher } from './services/memory-watcher';
import { startSessionContextWatcher, stopSessionContextWatcher } from './services/session-context-watcher';
import memorySectionsRoutes from './routes/memory-sections';
import vectorSearchRoutes from './routes/vector-search';
import gitRoutes from './routes/git';
import { projectDiffRoutes, globalDiffRoutes, diffCommentRoutes } from './routes/diffs';
import googleRoutes from './routes/google';
import gcloudRoutes from './routes/gcloud';
import memorySnapshotRoutes from './routes/memory-snapshots';
import { runStartupDiscovery } from './services/startup';
import { startVectorSyncWorker, stopVectorSyncWorker } from './services/vector-sync';
import { startPlanFileWatcher, stopPlanFileWatcher } from './services/plans';
import assistantMemoryRoutes from './routes/assistant-memories';
import promptsRoutes from './routes/prompts';
import geminiRoutes from './routes/gemini';
import { startMemoryFileWatcher, stopMemoryFileWatcher } from './services/assistant-memories';
import { startSessionSyncWorker, stopSessionSyncWorker } from './services/session-worker';
import { startSessionWatcher, stopSessionWatcher } from './services/session-watcher';
import { startSessionEventBus, stopSessionEventBus } from './services/session-events';
import sessionEventRoutes from './routes/session-events';
import { startSessionBackupWorker, stopSessionBackupWorker } from './services/session-backup-worker';
import sessionSearchRoutes from './routes/session-search';
import kdagJobRoutes from './routes/kdag-jobs';
import kdagDefinitionRoutes from './routes/kdag-definitions';
import definitionSnapshotRoutes from './routes/kdag-definition-snapshots';
import kdagInputTypeRoutes from './routes/kdag-input-types';
import activeSessionRoutes from './routes/active-sessions';
import kvecRoutes from './routes/kvec';
import kapiRoutes from './routes/kapi';
import assistantChatRoutes, { chatByIdRoutes } from './routes/assistant-chat';
import backupRoutes from './routes/backups';
import slackRoutes from './routes/slack';
import seedRoutes from './routes/seed';
import collectionRoutes, { globalCollectionsRoute, memoryCollectionsRoute } from './routes/collections';
import liveMessageRoutes from './routes/live-messages';
import agentQuestionRoutes from './routes/agent-questions';
import filesystemRoutes from './routes/filesystem';
import systemHealthRoutes from './routes/system-health';
import { startBackgroundScanner, stopBackgroundScanner } from './services/active-sessions';
import { connectRedis, closeRedis } from './services/redis';
import { initJobQueue } from './services/kdag-executor';
import { ensureDefaultCollections } from './services/kvec-service';
import kvecAutoEmbedRoutes from './routes/kvec-auto-embed';
import unifiedSearchRoutes from './routes/unified-search';
import metricsProxyRoutes from './routes/metrics-proxy';
import dbxRoutes from './routes/dbx';
import sessionTeamRoutes from './routes/session-teams';
import { startAutoEmbedScheduler, stopAutoEmbedScheduler } from './services/kvec-auto-embed';
import metricsPlugin from './plugins/metrics';

const fastify = Fastify({
  loggerInstance: logger
});

fastify.register(metricsPlugin);

const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST || '127.0.0.1';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5174,http://localhost:5173').split(',');
fastify.register(cors, {
  origin: CORS_ORIGINS,
});

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '5000', 10);
if (RATE_LIMIT_MAX > 0) {
  fastify.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });
}

fastify.register(projectRoutes, { prefix: '/api/projects' });
fastify.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
fastify.register(memoryRoutes, { prefix: '/api/memories' });
fastify.register(memoryRelationsRoutes, { prefix: '/api/memories/:memoryId/relations' });
fastify.register(commentRoutes, { prefix: '/api/memories/:memoryId/comments' });
fastify.register(globalCommentRoutes, { prefix: '/api/comments' });
fastify.register(memoryTypeRoutes, { prefix: '/api/memory-types' });
fastify.register(tagRoutes, { prefix: '/api/tags' });
fastify.register(relationRoutes, { prefix: '/api/relations' });
fastify.register(relationTypeRoutes, { prefix: '/api/relation-types' });
fastify.register(sessionRoutes, { prefix: '/api' });
fastify.register(diagramRoutes, { prefix: '/api/diagram' });
fastify.register(editorRoutes, { prefix: '/api/editor' });
fastify.register(settingsRoutes, { prefix: '/api/settings' });
fastify.register(projectFileRoutes, { prefix: '/api/projects/:projectId/files' });
fastify.register(globalFileRoutes, { prefix: '/api/files' });
fastify.register(projectKnowledgeRoutes, { prefix: '/api/projects/:projectId/knowledge' });
fastify.register(projectStatsRoutes, { prefix: '/api/projects/:projectId/stats' });
fastify.register(assistantRoutes, { prefix: '/api/assistants' });
fastify.register(configRoutes, { prefix: '/api/configs' });
fastify.register(projectConfigRoutes, { prefix: '/api/projects/:projectId/configs' });
fastify.register(projectPlansRoutes, { prefix: '/api/projects/:projectId/plans' });
fastify.register(rulesRoutes, { prefix: '/api/rules' });
fastify.register(mcpServersRoutes, { prefix: '/api/mcp-servers' });
fastify.register(memoryExportRoutes, { prefix: '/api/memories' });
fastify.register(memorySectionsRoutes, { prefix: '/api/memories' });
fastify.register(assistantSessionRoutes, { prefix: '/api/assistants/:handle/sessions' });
fastify.register(assistantPlanRoutes, { prefix: '/api/assistants/:handle/plans' });
fastify.register(assistantMemoryRoutes, { prefix: '/api/assistants/:handle/memories' });
fastify.register(promptsRoutes, { prefix: '/api/prompts' });
fastify.register(planRoutes, { prefix: '/api/plans' });
fastify.register(statsRoutes, { prefix: '/api/stats' });
fastify.register(notificationRoutes, { prefix: '/api/notifications' });
fastify.register(systemHealthRoutes, { prefix: '/api/system/health' });
fastify.register(vectorSearchRoutes, { prefix: '/api/vector' });
fastify.register(unifiedSearchRoutes, { prefix: '/api/search' });
fastify.register(gitRoutes, { prefix: '/api/projects/:projectId/git' });
fastify.register(projectDiffRoutes, { prefix: '/api/projects/:projectId/diffs' });
fastify.register(globalDiffRoutes, { prefix: '/api/diffs/:diffId' });
fastify.register(diffCommentRoutes, { prefix: '/api/diffs/:diffId/comments' });
fastify.register(googleRoutes, { prefix: '/api/google' });
fastify.register(gcloudRoutes, { prefix: '/api/gcloud' });
fastify.register(memorySnapshotRoutes, { prefix: '/api/memories/:memoryId/snapshots' });
fastify.register(geminiRoutes, { prefix: '/api/gemini' });
fastify.register(sessionSearchRoutes, { prefix: '/api/sessions' });
fastify.register(kdagJobRoutes, { prefix: '/api/kdag' });
fastify.register(kdagDefinitionRoutes, { prefix: '/api/kdag/definitions' });
fastify.register(definitionSnapshotRoutes, { prefix: '/api/kdag/definitions/:key/snapshots' });
fastify.register(kdagInputTypeRoutes, { prefix: '/api/kdag/input-types' });
fastify.register(activeSessionRoutes, { prefix: '/api/active-sessions' });
fastify.register(kvecRoutes, { prefix: '/api/kvec' });
fastify.register(kvecAutoEmbedRoutes, { prefix: '/api/kvec/auto-embed' });
fastify.register(kapiRoutes, { prefix: '/api/kapi' });
fastify.register(assistantChatRoutes, { prefix: '/api/assistants' });
fastify.register(chatByIdRoutes, { prefix: '/api/chats' });
fastify.register(backupRoutes, { prefix: '/api/backups' });
fastify.register(slackRoutes, { prefix: '/api/slack' });
fastify.register(seedRoutes, { prefix: '/api/seed' });
fastify.register(collectionRoutes, { prefix: '/api/projects/:projectId/collections' });
fastify.register(globalCollectionsRoute, { prefix: '/api/collections' });
fastify.register(memoryCollectionsRoute, { prefix: '/api/projects/:projectId/memories/:memoryId/collections' });
fastify.register(filesystemRoutes, { prefix: '/api/fs' });
fastify.register(liveMessageRoutes, { prefix: '/api/live-messages' });
fastify.register(agentQuestionRoutes, { prefix: '/api/agent-questions' });
fastify.register(metricsProxyRoutes, { prefix: '/api/metrics' });
fastify.register(dbxRoutes, { prefix: '/api/dbx' });
fastify.register(sessionTeamRoutes, { prefix: '/api/session-teams' });
fastify.register(sessionEventRoutes, { prefix: '/api/sse' });

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });

    // Run startup tasks (non-blocking)
    runStartupDiscovery().catch((err) => {
      logger.warn({ err }, 'Discovery error');
    });

    // Start vector sync worker if enabled
    startVectorSyncWorker().catch((err) => {
      logger.warn({ err }, 'Vector sync worker error');
    });

    // Ensure default kvec collections exist for UI and ready-to-use search endpoints.
    ensureDefaultCollections().catch((err) => {
      logger.warn({ err }, 'Default kvec collection initialization error');
    });

    // Start plan file watcher for auto-discovery
    startPlanFileWatcher().catch((err) => {
      logger.warn({ err }, 'Plan file watcher error');
    });

    // Start memory file watcher for auto-discovery
    startMemoryFileWatcher().catch((err) => {
      logger.warn({ err }, 'Memory file watcher error');
    });

    // Start session sync worker (embedding loop + polled reconciliation)
    startSessionSyncWorker().catch((err) => {
      logger.warn({ err }, 'Session sync worker failed to start');
    });

    // Start push-based session watcher (phase 1: logs deltas, runs alongside polled sync)
    if (process.env.SESSION_WATCHER_ENABLED === 'true') {
      startSessionWatcher().catch((err) => {
        logger.warn({ err }, 'Session watcher failed to start');
      });
      startSessionEventBus().catch((err) => {
        logger.warn({ err }, 'Session event bus failed to start');
      });
    }

    // Start session backup worker (persistent JSONL copy)
    startSessionBackupWorker();

    // Start active session background scanner
    startBackgroundScanner();

    // Connect Redis for live messaging (non-blocking)
    connectRedis().catch((err) => {
      logger.warn({ err }, 'Redis connection error');
    });

    // Recover any queued/orphaned kdag jobs from previous session
    initJobQueue().catch((err) => {
      logger.warn({ err }, 'Job queue initialization error');
    });

    // Start kvec auto-embed scheduler (30-min interval)
    startAutoEmbedScheduler();

    // Start memory watcher (raises notifications when tracked apps exceed thresholds)
    startMemoryWatcher();

    // Start session context watcher (raises notifications at 50%/75%/90% of context window)
    startSessionContextWatcher();
  } catch (err) {
    fastify.log.error(err);
    await closePool();
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  stopVectorSyncWorker();
  stopPlanFileWatcher();
  stopMemoryFileWatcher();
  stopSessionSyncWorker();
  await stopSessionWatcher();
  await stopSessionEventBus();
  stopSessionBackupWorker();
  stopBackgroundScanner();
  stopAutoEmbedScheduler();
  stopMemoryWatcher();
  stopSessionContextWatcher();
  await closeRedis();
  await fastify.close();
  await closePool();
  process.exit(0);
});

start();
