export class KhefClient {
  constructor(private baseUrl: string) {}

  async request(path: string, options?: RequestInit) {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(options?.headers as Record<string, string>),
    };
    // Only set Content-Type when there's a body to avoid Fastify empty JSON body errors
    if (options?.body) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    return response.json();
  }

  async getProjects(name?: string, handle?: string, favorite?: boolean) {
    const qs = new URLSearchParams();
    if (name) qs.set("name", name);
    if (handle) qs.set("handle", handle);
    if (favorite !== undefined) qs.set("favorite", String(favorite));
    const params = qs.toString() ? `?${qs.toString()}` : "";
    return this.request(`/api/projects${params}`);
  }

  async getProject(identifier: string) {
    if (this.isUuid(identifier)) {
      return this.request(`/api/projects/${identifier}`);
    }
    // Try handle first
    const byHandle = await this.getProjects(undefined, identifier);
    if (byHandle.projects && byHandle.projects.length > 0) {
      return { project: byHandle.projects[0] };
    }
    // Fallback to name
    const byName = await this.getProjects(identifier, undefined);
    if (byName.projects && byName.projects.length > 0) {
      return { project: byName.projects[0] };
    }
    throw new Error(`Project not found: ${identifier}`);
  }

  async createProject(name: string, description?: string, path?: string) {
    return this.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, description, path }),
    });
  }

  async updateProject(
    projectId: string,
    updates: {
      name?: string;
      display_name?: string;
      description?: string;
      path?: string;
      is_favorite?: boolean;
    }
  ) {
    const id = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  async resolveProjectId(identifier: string): Promise<string> {
    if (!identifier) throw new Error("project_id is required");
    if (this.isUuid(identifier)) return identifier;
    const result = await this.getProject(identifier);
    if (!result?.project?.id) throw new Error(`Project not found: ${identifier}`);
    return result.project.id;
  }

  private async resolveProjectFromMemory(memoryId: string): Promise<string> {
    const result = await this.getGlobalMemory(memoryId);
    if (!result?.memory?.project_id) throw new Error(`Memory not found: ${memoryId}`);
    return result.memory.project_id;
  }

  async searchMemories(
    projectId: string | undefined,
    options: {
      q?: string;
      search_mode?: 'all' | 'content' | 'tags';
      type?: string;
      tag?: string;
      status?: string;
      project_name?: string;
      project_handle?: string;
      handle?: string;
      name?: string;
      limit?: number;
      offset?: number;
      compact?: boolean;
      pinned?: boolean;
    } = {}
  ) {
    const params = new URLSearchParams();
    if (options.q) params.set("q", options.q);
    if (options.search_mode) params.set("search_mode", options.search_mode);
    if (options.type) params.set("type", options.type);
    if (options.tag) params.set("tag", options.tag);
    if (options.status) params.set("status", options.status);
    if (options.project_name) params.set("project_name", options.project_name);
    if (options.project_handle) params.set("project_handle", options.project_handle);
    if (options.handle) params.set("handle", options.handle);
    if (options.name) params.set("name", options.name);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.compact !== undefined) params.set("compact", String(options.compact));
    if (options.pinned !== undefined) params.set("pinned", String(options.pinned));

    const query = params.toString();

    // Use global memories endpoint if no project specified, otherwise project-scoped
    if (projectId) {
      const pid = await this.resolveProjectId(projectId);
      return this.request(
        `/api/projects/${pid}/memories${query ? `?${query}` : ""}`
      );
    } else {
      return this.request(`/api/memories${query ? `?${query}` : ""}`);
    }
  }

  async semanticSearch(options: {
    q: string;
    project_id?: string;
    type?: string;
    limit?: number;
    compact?: boolean;
  }) {
    const params = new URLSearchParams();
    params.set("q", options.q);
    if (options.project_id) params.set("project_id", options.project_id);
    if (options.type) params.set("type", options.type);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.compact !== undefined) params.set("compact", String(options.compact));

    return this.request(`/api/vector/search?${params}`);
  }

  async searchSourceCode(options: {
    q: string;
    language?: string;
    repo?: string;
    branch?: string;
    commit?: string;
    limit?: number;
    min_score?: number;
    context?: number;
  }) {
    const params = new URLSearchParams();
    params.set("q", options.q);
    if (options.language) params.set("language", options.language);
    if (options.repo) params.set("repo", options.repo);
    if (options.branch) params.set("branch", options.branch);
    if (options.commit) params.set("commit", options.commit);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.min_score) params.set("min_score", String(options.min_score));
    if (options.context) params.set("context", String(options.context));

    return this.request(`/api/vector/source/search?${params}`);
  }

  async viewSourceCodeFile(options: {
    repo?: string;
    path?: string;
    abs_path?: string;
    start?: number;
    end?: number;
    ref?: string;
  }) {
    const params = new URLSearchParams();
    if (options.repo) params.set("repo", options.repo);
    if (options.path) params.set("path", options.path);
    if (options.abs_path) params.set("abs_path", options.abs_path);
    if (options.start !== undefined) params.set("start", String(options.start));
    if (options.end !== undefined) params.set("end", String(options.end));
    if (options.ref) params.set("ref", options.ref);

    return this.request(`/api/vector/source/file?${params}`);
  }

  async searchCommits(options: {
    q: string;
    repo?: string;
    author?: string;
    since?: string;
    until?: string;
    branch?: string;
    limit?: number;
    offset?: number;
    min_score?: number;
  }) {
    const params = new URLSearchParams();
    params.set("q", options.q);
    if (options.repo) params.set("repo", options.repo);
    if (options.author) params.set("author", options.author);
    if (options.since) params.set("since", options.since);
    if (options.until) params.set("until", options.until);
    if (options.branch) params.set("branch", options.branch);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.min_score) params.set("min_score", String(options.min_score));

    return this.request(`/api/vector/commits/search?${params}`);
  }

  async searchDocs(options: {
    q: string;
    project?: string;
    tag?: string;
    file_type?: string;
    limit?: number;
    min_score?: number;
  }) {
    const params = new URLSearchParams();
    params.set("q", options.q);
    if (options.project) params.set("project", options.project);
    if (options.tag) params.set("tag", options.tag);
    if (options.file_type) params.set("file_type", options.file_type);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.min_score) params.set("min_score", String(options.min_score));

    return this.request(`/api/vector/docs/search?${params}`);
  }

  async getDocContent(options: {
    document_id: string;
    limit?: number;
    offset?: number;
  }) {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    const encodedId = encodeURIComponent(options.document_id);
    const qs = params.toString() ? `?${params}` : "";
    return this.request(`/api/vector/docs/${encodedId}/content${qs}`);
  }

  async unifiedSearch(options: {
    q: string;
    project?: string;
    repo?: string;
    limit?: number;
    excludeSessionId?: string;
  }) {
    const params = new URLSearchParams();
    params.set("q", options.q);
    if (options.project) params.set("project", options.project);
    if (options.repo) params.set("repo", options.repo);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.excludeSessionId) params.set("exclude_session_id", options.excludeSessionId);

    return this.request(`/api/search?${params}`);
  }

  async getMemory(projectId: string, memoryId: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/memories/${memoryId}`);
  }

  async resolveMemoryId(handle: string, projectId: string): Promise<string> {
    const pid = await this.resolveProjectId(projectId);
    const result = await this.request(
      `/api/projects/${pid}/memories?handle=${encodeURIComponent(handle)}&compact=true`
    );
    const memories = result.memories || [];
    if (memories.length === 0) {
      throw new Error(`No memory found with handle "${handle}" in project "${projectId}"`);
    }
    return memories[0].id;
  }

  async getGlobalMemory(memoryId: string, includeResolved: boolean = false) {
    return this.request(`/api/memories/${memoryId}?comments=true&include_resolved=${includeResolved}`);
  }

  async createMemory(
    projectId: string,
    handle: string,
    title: string,
    content: string,
    type: string,
    tags?: string[],
    metadata?: Record<string, string>
  ) {
    const pid = await this.resolveProjectId(projectId);
    const body: Record<string, unknown> = { handle, title, content, type, tags };
    if (metadata && Object.keys(metadata).length > 0) body.metadata = metadata;
    return this.request(`/api/projects/${pid}/memories?compact=true`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateMemory(
    projectId: string | undefined,
    memoryId: string,
    updates: {
      title?: string;
      content?: string;
      type?: string;
      tags?: string[];
      metadata?: Record<string, string>;
    },
    newProjectId?: string
  ) {
    const pid = projectId
      ? await this.resolveProjectId(projectId)
      : await this.resolveProjectFromMemory(memoryId);
    const body: Record<string, unknown> = { ...updates };
    if (newProjectId) {
      body.project_id = await this.resolveProjectId(newProjectId);
    }
    return this.request(`/api/projects/${pid}/memories/${memoryId}?compact=true`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async syncExternalSnapshot(memoryId: string, includeComments: boolean = true) {
    return this.request(`/api/memories/${memoryId}/sync-external?mode=snapshot`, {
      method: "POST",
      body: JSON.stringify({ includeComments }),
    });
  }

  async createMemorySnapshot(projectId: string | undefined, memoryId: string) {
    const pid = projectId
      ? await this.resolveProjectId(projectId)
      : await this.resolveProjectFromMemory(memoryId);
    return this.request(`/api/projects/${pid}/memories/${memoryId}?snapshot=true&compact=true`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
  }

  async compareMemorySnapshots(
    memoryId: string,
    from: string,
    to: string,
    context?: number,
    limit?: number,
    offset?: number
  ) {
    const qs = new URLSearchParams();
    qs.set("from", from);
    qs.set("to", to);
    if (context !== undefined) qs.set("context", String(context));
    if (limit !== undefined) qs.set("limit", String(limit));
    if (offset !== undefined) qs.set("offset", String(offset));
    return this.request(`/api/memories/${memoryId}/snapshots/diff?${qs.toString()}`);
  }

  async listMemorySnapshots(memoryId: string) {
    return this.request(`/api/memories/${memoryId}/snapshots`);
  }

  async restoreMemorySnapshot(memoryId: string, snapshotNumber: number) {
    return this.request(`/api/memories/${memoryId}/snapshots/${snapshotNumber}/restore`, {
      method: "POST",
    });
  }

  async deleteMemorySnapshot(memoryId: string, snapshotNumber: number) {
    return this.request(`/api/memories/${memoryId}/snapshots/${snapshotNumber}`, {
      method: "DELETE",
    });
  }

  async bulkDeleteMemorySnapshots(memoryId: string, snapshotNumbers: number[]) {
    return this.request(`/api/memories/${memoryId}/snapshots/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ snapshot_numbers: snapshotNumbers }),
    });
  }

  async appendMemory(
    projectId: string | undefined,
    memoryId: string,
    content: string,
    separator?: string
  ) {
    const pid = projectId
      ? await this.resolveProjectId(projectId)
      : await this.resolveProjectFromMemory(memoryId);
    return this.request(`/api/projects/${pid}/memories/${memoryId}/append?compact=true`, {
      method: "POST",
      body: JSON.stringify({ content, separator }),
    });
  }

  async deleteMemory(projectId: string | undefined, memoryId: string) {
    const pid = projectId
      ? await this.resolveProjectId(projectId)
      : await this.resolveProjectFromMemory(memoryId);
    const url = `${this.baseUrl}/api/projects/${pid}/memories/${memoryId}`;
    const response = await fetch(url, { method: "DELETE" });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    // DELETE returns 204 No Content
    return { success: true, memory_id: memoryId };
  }

  async getMemoryTypeStatuses(memoryType: string) {
    return this.request(`/api/memory-types/${memoryType}/statuses`);
  }

  async getMemoryStatus(projectId: string | undefined, memoryId: string) {
    const pid = projectId
      ? await this.resolveProjectId(projectId)
      : await this.resolveProjectFromMemory(memoryId);
    return this.request(`/api/projects/${pid}/memories/${memoryId}/status`);
  }

  async updateMemoryStatus(projectId: string | undefined, memoryId: string, status: string) {
    const pid = projectId
      ? await this.resolveProjectId(projectId)
      : await this.resolveProjectFromMemory(memoryId);
    return this.request(
      `/api/projects/${pid}/memories/${memoryId}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ status }),
      }
    );
  }

  async createRelation(
    sourceMemoryId: string,
    targetMemoryId: string,
    relationType: string
  ) {
    return this.request("/api/relations", {
      method: "POST",
      body: JSON.stringify({
        source_memory_id: sourceMemoryId,
        target_memory_id: targetMemoryId,
        relation_type: relationType,
      }),
    });
  }

  async getMemoryGraph(memoryId: string, depth: number = 2, format: string = 'json') {
    const qs = new URLSearchParams();
    qs.set('depth', String(depth));
    if (format) qs.set('format', format);
    const url = `${this.baseUrl}/api/memories/${memoryId}/relations/graph?${qs}`;
    if (format === 'text') {
      const response = await fetch(url);
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${response.status} ${error}`);
      }
      return response.text();
    }
    return this.request(`/api/memories/${memoryId}/relations/graph?${qs}`);
  }

  async getProjectGraph(projectId: string, options: { max_nodes?: number; max_edges?: number; format?: string; type?: string; tag?: string } = {}) {
    const resolvedId = await this.resolveProjectId(projectId);
    const qs = new URLSearchParams();
    if (options.max_nodes) qs.set('max_nodes', String(options.max_nodes));
    if (options.max_edges) qs.set('max_edges', String(options.max_edges));
    if (options.format) qs.set('format', options.format);
    if (options.type) qs.set('type', options.type);
    if (options.tag) qs.set('tag', options.tag);
    const params = qs.toString() ? `?${qs}` : '';
    const url = `${this.baseUrl}/api/projects/${resolvedId}/graph${params}`;
    if (options.format === 'text') {
      const response = await fetch(url);
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${response.status} ${error}`);
      }
      return response.text();
    }
    return this.request(`/api/projects/${resolvedId}/graph${params}`);
  }

  async getTags() {
    return this.request("/api/tags");
  }

  async getTagMemories(tagName: string) {
    return this.request(`/api/tags/${encodeURIComponent(tagName)}/memories`);
  }

  async createTag(name: string) {
    return this.request("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async renameTag(tagId: string, name: string) {
    return this.request(`/api/tags/${tagId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async deleteTag(tagId: string) {
    // DELETE may return 204 No Content; avoid JSON parsing on empty body
    const url = `${this.baseUrl}/api/tags/${tagId}`;
    const response = await fetch(url, { method: "DELETE" });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    return { success: true, tag_id: tagId };
  }

  // --- Collections ---

  async getCollections(projectId: string, limit?: number, offset?: number, parent_id?: string) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    if (parent_id) params.set('parent_id', parent_id);
    const qs = params.toString();
    const resolvedId = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${resolvedId}/collections${qs ? `?${qs}` : ''}`);
  }

  async createCollection(projectId: string, handle: string, name: string, description?: string, parent_id?: string, view_mode?: string) {
    const resolvedId = await this.resolveProjectId(projectId);
    const body: Record<string, unknown> = { handle, name };
    if (description) body.description = description;
    if (parent_id) body.parent_id = parent_id;
    if (view_mode) body.view_mode = view_mode;
    return this.request(`/api/projects/${resolvedId}/collections`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getCollection(projectId: string, collectionId: string) {
    const resolvedId = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${resolvedId}/collections/${collectionId}`);
  }

  async updateCollection(projectId: string, collectionId: string, data: Record<string, unknown>) {
    const resolvedId = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${resolvedId}/collections/${collectionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteCollection(projectId: string, collectionId: string) {
    const resolvedId = await this.resolveProjectId(projectId);
    const url = `${this.baseUrl}/api/projects/${resolvedId}/collections/${collectionId}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, collection_id: collectionId };
  }

  async addToCollection(projectId: string, collectionId: string, memoryId: string, position?: number) {
    const resolvedId = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${resolvedId}/collections/${collectionId}/memories`, {
      method: 'POST',
      body: JSON.stringify({ memory_id: memoryId, position }),
    });
  }

  async reorderCollection(projectId: string, collectionId: string, items: { memory_id: string; position: number }[]) {
    const resolvedId = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${resolvedId}/collections/${collectionId}/memories/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    });
  }

  async removeFromCollection(projectId: string, collectionId: string, memoryId: string) {
    const resolvedId = await this.resolveProjectId(projectId);
    const url = `${this.baseUrl}/api/projects/${resolvedId}/collections/${collectionId}/memories/${memoryId}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, collection_id: collectionId, memory_id: memoryId };
  }

  async getSessionContext(handle?: string, id?: string, name?: string) {
    // Accepts optional identifiers; only send provided params
    const params = new URLSearchParams();
    if (id) params.set('project_id', id);
    if (handle) params.set('project_handle', handle);
    if (name) params.set('project_name', name);
    const qs = params.toString();
    return this.request(`/api/initialize_session${qs ? `?${qs}` : ''}`);
  }

  async scanActiveSessions() {
    return this.request('/api/active-sessions/scan', { method: 'POST' });
  }

  async getActiveSessionBySessionId(sessionId: string) {
    return this.request(`/api/active-sessions/by-session-id/${encodeURIComponent(sessionId)}`);
  }

  async claimNickname(sessionId: string, nickname: string) {
    return this.request(`/api/active-sessions/${encodeURIComponent(sessionId)}/nickname`, {
      method: 'POST',
      body: JSON.stringify({ nickname }),
    });
  }

  async getSessionLineage(nickname: string) {
    return this.request(`/api/sessions/by-nickname/${encodeURIComponent(nickname)}`);
  }

  async exportSessionLineage(nickname: string, path?: string) {
    return this.request(`/api/sessions/by-nickname/${encodeURIComponent(nickname)}/export`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  async getSessionLineageTokenCount(nickname: string) {
    return this.request(`/api/sessions/by-nickname/${encodeURIComponent(nickname)}/token-count`);
  }

  async getGraphHealth(projectId: string) {
    return this.request(`/api/projects/${projectId}/graph-health`);
  }

  async getStats() {
    // Use the overview sub-endpoint — formatStats() only reads the overview
    // fields (memories/projects/tags/relations/files/database). Skipping the
    // aggregate avoids paying for process gathering and claude usage aggregates.
    return this.request('/api/stats/overview');
  }

  async getSystemHealth() {
    return this.request('/api/system/health');
  }

  async getProjectMemoryTypes(projectId: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/memory-types`);
  }

  async getProjectMemoryTypeStatuses(projectId: string, memoryType: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/memory-types/${memoryType}/statuses`);
  }

  async suggestRelations(projectId: string, memoryId: string, limit?: number) {
    const pid = await this.resolveProjectId(projectId);
    const params = limit ? `?limit=${limit}` : '';
    return this.request(`/api/projects/${pid}/memories/${memoryId}/suggestions${params}`);
  }

  // Project Knowledge methods
  async getProjectKnowledge(projectId: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/knowledge`);
  }

  async setProjectCommands(projectId: string, content: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/knowledge/commands`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  }

  async setProjectContext(projectId: string, handle: string, title: string, content: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/knowledge/context/${handle}`, {
      method: "PUT",
      body: JSON.stringify({ title, content }),
    });
  }

  async setProjectPattern(projectId: string, handle: string, title: string, content: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/knowledge/patterns/${handle}`, {
      method: "PUT",
      body: JSON.stringify({ title, content }),
    });
  }

  async deleteProjectContext(projectId: string, handle: string) {
    const pid = await this.resolveProjectId(projectId);
    const url = `${this.baseUrl}/api/projects/${pid}/knowledge/context/${handle}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  async deleteProjectPattern(projectId: string, handle: string) {
    const pid = await this.resolveProjectId(projectId);
    const url = `${this.baseUrl}/api/projects/${pid}/knowledge/patterns/${handle}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  async syncProjectKnowledge(projectId: string, location?: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/knowledge/sync`, {
      method: "POST",
      body: JSON.stringify({ location: location || undefined }),
    });
  }

  async syncGlossary(projectId: string, location?: string) {
    const pid = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${pid}/knowledge/glossary/sync`, {
      method: "POST",
      body: JSON.stringify({ location: location || undefined }),
    });
  }

  async syncProjectRules(projectHandle: string, location?: string) {
    return this.request(`/api/rules/sync/project/${encodeURIComponent(projectHandle)}`, {
      method: "POST",
      body: JSON.stringify({ location: location || undefined }),
    });
  }

  async runSeed(project?: string) {
    return this.request('/api/seed', {
      method: "POST",
      body: JSON.stringify({ project: project || undefined }),
    });
  }

  // Agent management methods
  async getUserAgents(assistantHandle: string) {
    return this.request(`/api/assistants/${assistantHandle}/agents`);
  }

  async getProjectAgents(assistantHandle: string, projectId: string) {
    return this.request(`/api/assistants/${assistantHandle}/agents/project/${projectId}`);
  }

  async getUserAgent(assistantHandle: string, agentName: string) {
    return this.request(`/api/assistants/${assistantHandle}/agents/${encodeURIComponent(agentName)}`);
  }

  async getProjectAgent(assistantHandle: string, agentName: string, projectId: string) {
    return this.request(`/api/assistants/${assistantHandle}/agents/project/${projectId}/${encodeURIComponent(agentName)}`);
  }

  async createUserAgent(
    assistantHandle: string,
    agent: {
      name: string;
      description: string;
      prompt: string;
      model?: string;
      tools?: string[];
      disallowedTools?: string[];
      permissionMode?: string;
      skills?: string[];
    }
  ) {
    return this.request(`/api/assistants/${assistantHandle}/agents`, {
      method: "POST",
      body: JSON.stringify(agent),
    });
  }

  async createProjectAgent(
    assistantHandle: string,
    projectId: string,
    agent: {
      name: string;
      description: string;
      prompt: string;
      model?: string;
      tools?: string[];
      disallowedTools?: string[];
      permissionMode?: string;
      skills?: string[];
    }
  ) {
    return this.request(`/api/assistants/${assistantHandle}/agents/project/${projectId}`, {
      method: "POST",
      body: JSON.stringify(agent),
    });
  }

  async updateUserAgent(
    assistantHandle: string,
    agentName: string,
    updates: {
      name?: string;
      description?: string;
      prompt?: string;
      model?: string;
      tools?: string[];
      disallowedTools?: string[];
      permissionMode?: string;
      skills?: string[];
    }
  ) {
    return this.request(`/api/assistants/${assistantHandle}/agents/${encodeURIComponent(agentName)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async updateProjectAgent(
    assistantHandle: string,
    agentName: string,
    projectId: string,
    updates: {
      name?: string;
      description?: string;
      prompt?: string;
      model?: string;
      tools?: string[];
      disallowedTools?: string[];
      permissionMode?: string;
      skills?: string[];
    }
  ) {
    return this.request(`/api/assistants/${assistantHandle}/agents/project/${projectId}/${encodeURIComponent(agentName)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async deleteUserAgent(assistantHandle: string, agentName: string) {
    const url = `${this.baseUrl}/api/assistants/${assistantHandle}/agents/${encodeURIComponent(agentName)}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, agent_name: agentName };
  }

  async deleteProjectAgent(assistantHandle: string, agentName: string, projectId: string) {
    const url = `${this.baseUrl}/api/assistants/${assistantHandle}/agents/project/${projectId}/${encodeURIComponent(agentName)}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, agent_name: agentName };
  }

  async exportMemory(memoryId: string, format: 'markdown' | 'docx' | 'slack' | 'csv' | 'xlsx' | 'html'): Promise<string> {
    const url = `${this.baseUrl}/api/memories/${memoryId}/export?format=${format}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    // For binary formats, return base64-encoded
    if (format === 'docx' || format === 'xlsx') {
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    }

    // For text formats (markdown, slack, csv), return plain text
    return response.text();
  }

  async bulkExportMemories(
    projectId: string,
    options: { type?: string; tag?: string; status?: string; format?: string } = {}
  ): Promise<string> {
    const pid = await this.resolveProjectId(projectId);
    const params = new URLSearchParams();
    if (options.type) params.set("type", options.type);
    if (options.tag) params.set("tag", options.tag);
    if (options.status) params.set("status", options.status);
    if (options.format) params.set("format", options.format);
    const qs = params.toString();
    const url = `${this.baseUrl}/api/projects/${pid}/memories/export${qs ? `?${qs}` : ""}`;
    const response = await fetch(url);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    // Always returns a zip — encode as base64
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  }

  async syncBuiltinCommands(assistantHandle: string) {
    const url = `${this.baseUrl}/api/assistants/${assistantHandle}/commands/sync`;
    const response = await fetch(url, { method: "POST" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return response.json();
  }

  // Comment methods
  async listComments(
    memoryId: string,
    options: { limit?: number; offset?: number; order?: string; status?: string } = {}
  ) {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.order) params.set("order", options.order);
    if (options.status) params.set("status", options.status);
    const qs = params.toString();
    return this.request(`/api/memories/${memoryId}/comments${qs ? `?${qs}` : ""}`);
  }

  async createComment(
    memoryId: string,
    content: string,
    author?: string,
    parentCommentId?: string,
    anchorText?: string,
    anchorPrefix?: string,
    anchorSuffix?: string
  ) {
    return this.request(`/api/memories/${memoryId}/comments`, {
      method: "POST",
      body: JSON.stringify({
        content,
        author: author ?? undefined,
        parent_comment_id: parentCommentId ?? undefined,
        anchor_text: anchorText ?? undefined,
        anchor_prefix: anchorPrefix ?? undefined,
        anchor_suffix: anchorSuffix ?? undefined,
      }),
    });
  }

  async updateComment(
    memoryId: string,
    commentId: string,
    updates: {
      content?: string;
      anchor_text?: string;
      anchor_prefix?: string;
      anchor_suffix?: string;
      status?: string;
    }
  ) {
    return this.request(`/api/memories/${memoryId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async deleteComment(memoryId: string, commentId: string) {
    const url = `${this.baseUrl}/api/memories/${memoryId}/comments/${commentId}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, comment_id: commentId };
  }

  async deleteComments(
    memoryId: string,
    options: { status?: string; confirm?: boolean } = {}
  ) {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.confirm) params.set("confirm", "true");
    const qs = params.toString();
    return this.request(`/api/memories/${memoryId}/comments${qs ? `?${qs}` : ""}`, {
      method: "DELETE",
    });
  }

  async getCommentById(commentId: string) {
    return this.request(`/api/comments/${commentId}`);
  }

  // Plan comment methods
  async listPlanComments(
    planId: string,
    options: { limit?: number; offset?: number; order?: string; status?: string } = {}
  ) {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.order) params.set("order", options.order);
    if (options.status) params.set("status", options.status);
    const qs = params.toString();
    return this.request(`/api/plans/${planId}/comments${qs ? `?${qs}` : ""}`);
  }

  async createPlanComment(
    planId: string,
    content: string,
    author?: string,
    parentCommentId?: string,
    anchorText?: string,
    anchorPrefix?: string,
    anchorSuffix?: string
  ) {
    return this.request(`/api/plans/${planId}/comments`, {
      method: "POST",
      body: JSON.stringify({
        content,
        author: author ?? undefined,
        parent_comment_id: parentCommentId ?? undefined,
        anchor_text: anchorText ?? undefined,
        anchor_prefix: anchorPrefix ?? undefined,
        anchor_suffix: anchorSuffix ?? undefined,
      }),
    });
  }

  async updatePlanComment(
    planId: string,
    commentId: string,
    updates: {
      content?: string;
      anchor_text?: string;
      anchor_prefix?: string;
      anchor_suffix?: string;
      status?: string;
    }
  ) {
    return this.request(`/api/plans/${planId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async deletePlanComment(planId: string, commentId: string) {
    const url = `${this.baseUrl}/api/plans/${planId}/comments/${commentId}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, comment_id: commentId };
  }

  // Get plan by ID with comments
  async getPlanById(planId: string) {
    return this.request(`/api/plans/${planId}`);
  }

  // Get plan by filename (returns current/latest version)
  async getPlanByName(assistantHandle: string, filename: string) {
    return this.request(
      `/api/assistants/${assistantHandle}/plans/${encodeURIComponent(filename)}`
    );
  }

  // Session management methods
  async listSessionProjects(assistantHandle: string) {
    return this.request(`/api/assistants/${assistantHandle}/sessions`);
  }

  async listSessions(
    assistantHandle: string,
    projectDir: string,
    options: { sort?: string; order?: string; limit?: number; offset?: number } = {}
  ) {
    const params = new URLSearchParams();
    if (options.sort) params.set("sort", options.sort);
    if (options.order) params.set("order", options.order);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return this.request(
      `/api/assistants/${assistantHandle}/sessions/${encodeURIComponent(projectDir)}${qs ? `?${qs}` : ""}`
    );
  }

  async readSession(
    assistantHandle: string,
    projectDir: string,
    sessionId: string,
    options: { limit?: number; offset?: number } = {}
  ) {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return this.request(
      `/api/assistants/${assistantHandle}/sessions/${encodeURIComponent(projectDir)}/${sessionId}${qs ? `?${qs}` : ""}`
    );
  }

  async getSessionLoadedContext(
    assistantHandle: string,
    projectDir: string,
    sessionId: string
  ) {
    return this.request(
      `/api/assistants/${assistantHandle}/sessions/${encodeURIComponent(projectDir)}/${sessionId}/loaded-context`
    );
  }

  async deleteSessionFile(assistantHandle: string, projectDir: string, sessionId: string) {
    const url = `${this.baseUrl}/api/assistants/${assistantHandle}/sessions/${encodeURIComponent(projectDir)}/${sessionId}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true, session_id: sessionId };
  }

  async bulkDeleteSessions(
    assistantHandle: string,
    body: { projectDir?: string; before?: string; sessionIds?: string[] }
  ) {
    return this.request(`/api/assistants/${assistantHandle}/sessions/bulk-delete`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Session embedding methods
  async syncSessionEmbeddings(
    assistantHandle: string,
    options?: { projectDir?: string; sessionId?: string; force?: boolean }
  ) {
    const params = new URLSearchParams();
    if (options?.projectDir) params.set('projectDir', options.projectDir);
    if (options?.sessionId) params.set('sessionId', options.sessionId);
    if (options?.force) params.set('force', 'true');
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/assistants/${assistantHandle}/sessions/sync-embeddings${qs}`, {
      method: 'POST',
    });
  }

  async getSessionEmbeddingStatus(assistantHandle: string, projectDir?: string) {
    const params = new URLSearchParams();
    if (projectDir) params.set('projectDir', projectDir);
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/assistants/${assistantHandle}/sessions/sync-embeddings/status${qs}`);
  }

  async searchSessions(
    query: string,
    options?: { assistantHandle?: string; projectDir?: string; sessionId?: string; excludeSessionId?: string; limit?: number; includeThinking?: boolean; includeToolCalls?: boolean; mode?: 'keyword' | 'semantic' | 'fulltext' }
  ) {
    // Fulltext mode uses PostgreSQL-based session search
    if (options?.mode === 'fulltext') {
      const params = new URLSearchParams();
      params.set('q', query);
      if (options?.assistantHandle) params.set('assistant', options.assistantHandle);
      if (options?.projectDir) params.set('project', options.projectDir);
      if (options?.sessionId) params.set('session_id', options.sessionId);
      if (options?.excludeSessionId) params.set('exclude_session_id', options.excludeSessionId);
      if (options?.limit) params.set('limit', String(options.limit));
      return this.request(`/api/sessions/search?${params}`);
    }

    // Keyword/semantic modes use vector-based session search
    const params = new URLSearchParams();
    params.set('q', query);
    if (options?.projectDir) params.set('projectDir', options.projectDir);
    if (options?.sessionId) params.set('sessionId', options.sessionId);
    if (options?.excludeSessionId) params.set('excludeSessionId', options.excludeSessionId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.includeThinking === false) params.set('includeThinking', 'false');
    if (options?.includeToolCalls === true) params.set('includeToolCalls', 'true');
    if (options?.mode) params.set('mode', options.mode);
    const handle = options?.assistantHandle || 'claude-code';
    return this.request(`/api/assistants/${handle}/sessions/search?${params}`);
  }

  async grepSessions(body: {
    pattern: string;
    is_regex?: boolean;
    case_sensitive?: boolean;
    session_id?: string;
    nickname?: string;
    project_dir?: string;
    assistant_handle?: string;
    limit?: number;
    context_lines?: number;
  }) {
    return this.request(`/api/sessions/grep`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async listSyncedSessions(options?: { assistant?: string; project?: string; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (options?.assistant) params.set('assistant', options.assistant);
    if (options?.project) params.set('project', options.project);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/sessions${qs}`);
  }

  async getSyncedSession(id: string, includeChunks?: boolean) {
    const params = includeChunks ? '?include_chunks=true' : '';
    return this.request(`/api/sessions/${id}${params}`);
  }

  async getSyncedSessionByUuid(sessionUuid: string, includeChunks?: boolean) {
    const params = includeChunks ? '?include_chunks=true' : '';
    return this.request(`/api/sessions/by-session-id/${sessionUuid}${params}`);
  }

  async updateSession(id: string, data: { summary?: string; name?: string }) {
    return this.request(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async triggerSessionSync(force?: boolean) {
    const params = force ? '?force=true' : '';
    return this.request(`/api/sessions/sync${params}`, { method: 'POST' });
  }

  async getSessionSyncStatus() {
    return this.request('/api/sessions/sync/status');
  }

  async getSessionSummary(sessionDbId: string) {
    return this.request(`/api/sessions/${sessionDbId}/summary`);
  }

  // Memory section methods
  async getMemoryOutline(memoryId: string, includeContent?: boolean) {
    const params = new URLSearchParams();
    if (includeContent === false) params.set('include_content', 'false');
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/memories/${memoryId}/outline${qs}`);
  }

  async getMemorySection(memoryId: string, heading: string, includeSubsections?: boolean, index?: number) {
    const params = new URLSearchParams();
    if (includeSubsections === false) params.set('include_subsections', 'false');
    if (index !== undefined && index > 0) params.set('index', String(index));
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/memories/${memoryId}/sections/${encodeURIComponent(heading)}${qs}`);
  }

  async searchWithinMemory(memoryId: string, query: string) {
    const params = new URLSearchParams({ q: query });
    return this.request(`/api/memories/${memoryId}/search?${params}`);
  }

  async updateMemorySection(memoryId: string, heading: string, content: string, newHeading?: string, index?: number, replaceSubsections?: boolean) {
    const body: { content: string; new_heading?: string; index?: number; replace_subsections?: boolean } = { content };
    if (newHeading) body.new_heading = newHeading;
    if (index !== undefined && index > 0) body.index = index;
    if (replaceSubsections) body.replace_subsections = true;
    return this.request(`/api/memories/${memoryId}/sections/${encodeURIComponent(heading)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // Git/Diff methods
  async getCommits(
    projectId: string,
    options?: { branch?: string; limit?: number; path?: string }
  ) {
    const id = await this.resolveProjectId(projectId);
    const params = new URLSearchParams();
    if (options?.branch) params.set('branch', options.branch);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.path) params.set('path', options.path);
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/projects/${id}/git/commits${qs}`);
  }

  async getDiff(projectId: string, commitSha?: string, path?: string) {
    const id = await this.resolveProjectId(projectId);
    const params = new URLSearchParams();
    if (commitSha) params.set('commit_sha', commitSha);
    if (path) params.set('path', path);
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/projects/${id}/git/diff${qs}`);
  }

  async getWorkingDiff(projectId: string, path?: string) {
    const id = await this.resolveProjectId(projectId);
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/projects/${id}/git/diff/working${qs}`);
  }

  async createDiffRecord(
    projectId: string,
    body: { branch: string; commit_sha?: string; parent_sha?: string; path?: string }
  ) {
    const id = await this.resolveProjectId(projectId);
    return this.request(`/api/projects/${id}/diffs`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getDiffById(diffId: string) {
    return this.request(`/api/diffs/${diffId}`);
  }

  async getDiffByCommit(projectId: string, commitSha: string, path?: string) {
    const id = await this.resolveProjectId(projectId);
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    const qs = params.toString() ? `?${params}` : '';
    // Use by-ref which supports short SHA prefix matching (7+ chars)
    return this.request(`/api/projects/${id}/diffs/by-ref/${commitSha}${qs}`);
  }

  async createDiffComment(
    diffId: string,
    body: {
      content: string;
      author?: string;
      anchor_text?: string;
      anchor_prefix?: string;
      anchor_suffix?: string;
      anchor_path?: string;
      anchor_line?: number;
    }
  ) {
    return this.request(`/api/diffs/${diffId}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async annotateDiff(
    projectId: string,
    commitSha: string,
    comment: {
      content: string;
      author?: string;
      anchor_text?: string;
      anchor_prefix?: string;
      anchor_suffix?: string;
      anchor_path?: string;
      anchor_line?: number;
    },
    path?: string
  ) {
    const id = await this.resolveProjectId(projectId);
    // Use the lazy diff creation endpoint - creates diff record if needed
    return this.request(`/api/projects/${id}/diffs/by-ref/${commitSha}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        branch: 'main', // Default branch for new diff records
        content: comment.content,
        author: comment.author || 'claude-code',
        path: path || null,
        anchor_text: comment.anchor_text,
        anchor_prefix: comment.anchor_prefix,
        anchor_suffix: comment.anchor_suffix,
        anchor_path: comment.anchor_path,
        anchor_line: comment.anchor_line,
      }),
    });
  }

  async getCommitComments(projectId: string, commitSha: string, path?: string) {
    try {
      const result = await this.getDiffByCommit(projectId, commitSha, path);
      return { comments: result.comments || [] };
    } catch (error: any) {
      // No diff record exists for this commit = no comments
      if (error?.message?.includes('404')) {
        return { comments: [] };
      }
      throw error;
    }
  }

  async getDiffByRef(projectId: string, ref: string, path?: string) {
    const id = await this.resolveProjectId(projectId);
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    const qs = params.toString() ? `?${params}` : '';
    return this.request(`/api/projects/${id}/diffs/by-ref/${encodeURIComponent(ref)}${qs}`);
  }

  // Memory types CRUD
  async listMemoryTypes() {
    return this.request('/api/memory-types');
  }

  async getMemoryType(typeNameOrId: string) {
    return this.request(`/api/memory-types/${encodeURIComponent(typeNameOrId)}`);
  }

  async createMemoryType(
    name: string,
    description?: string,
    statuses?: Array<{
      value: string;
      display_name?: string;
      description?: string;
      sort_order?: number;
    }>
  ) {
    return this.request('/api/memory-types', {
      method: 'POST',
      body: JSON.stringify({ name, description, statuses }),
    });
  }

  async updateMemoryType(typeName: string, updates: { name?: string; description?: string }) {
    return this.request(`/api/memory-types/${encodeURIComponent(typeName)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteMemoryType(typeName: string) {
    const response = await fetch(`${this.baseUrl}/api/memory-types/${encodeURIComponent(typeName)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { deleted: true };
  }

  // --- Kdag (pipeline orchestration) ---

  async listJobDefinitions() {
    return this.request('/api/kdag/definitions?limit=200');
  }

  async getJobDefinition(key: string) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}`);
  }

  async createJobDefinition(body: {
    key: string;
    name: string;
    description?: string;
    steps: Array<{
      key: string;
      name: string;
      step_type?: string;
      assistant_handle?: string | null;
      model?: string | null;
      prompt_handle?: string | null;
      input_source?: string;
      input_config?: Record<string, unknown>;
      config?: Record<string, unknown>;
      timeout_ms?: number;
    }>;
    inputs?: Array<{
      input_type: string;
      required?: boolean;
      description?: string;
    }>;
  }) {
    return this.request('/api/kdag/definitions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateJobDefinition(key: string, body: {
    name?: string;
    description?: string;
    steps?: Array<{
      key: string;
      name: string;
      step_type?: string;
      assistant_handle?: string | null;
      model?: string | null;
      prompt_handle?: string | null;
      input_source?: string;
      input_config?: Record<string, unknown>;
      config?: Record<string, unknown>;
      timeout_ms?: number;
    }>;
    inputs?: Array<{
      input_type: string;
      required?: boolean;
      description?: string;
    }>;
  }) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async deleteJobDefinition(key: string) {
    const response = await fetch(`${this.baseUrl}/api/kdag/definitions/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { deleted: true };
  }

  async cloneJobDefinition(key: string, newKey: string, newName?: string) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}/clone`, {
      method: 'POST',
      body: JSON.stringify({ new_key: newKey, new_name: newName }),
    });
  }

  // ── Definition Snapshots ────────────────────────────────────────────

  async listDefinitionSnapshots(key: string) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}/snapshots`);
  }

  async getDefinitionSnapshot(key: string, num: number) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}/snapshots/${num}`);
  }

  async createDefinitionSnapshot(key: string) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}/snapshots`, {
      method: 'POST',
    });
  }

  async restoreDefinitionSnapshot(key: string, num: number) {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}/snapshots/${num}/restore`, {
      method: 'POST',
    });
  }

  async exportJobDefinition(key: string): Promise<{ definition_key: string; files: Array<{ path: string; content: string }> }> {
    return this.request(`/api/kdag/definitions/${encodeURIComponent(key)}/export`) as any;
  }

  async createKdagJob(body: {
    definition_key: string;
    assistant_handle?: string;
    inputs?: Record<string, string>;
    project_id?: string;
  }) {
    return this.request('/api/kdag/job', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async runKdagJob(jobId: string, opts?: { from_step?: string; from_batch?: number; model?: string; step_timeout_ms?: number; batch_delay_ms?: number; queue?: boolean }) {
    const body: Record<string, unknown> = {};
    if (opts?.model) body.model = opts.model;
    if (opts?.step_timeout_ms) body.step_timeout_ms = opts.step_timeout_ms;
    if (opts?.batch_delay_ms) body.batch_delay_ms = opts.batch_delay_ms;
    if (opts?.queue !== undefined) body.queue = opts.queue;
    if (opts?.from_step) {
      body.from_step = opts.from_step;
      if (opts.from_batch != null) body.from_batch = opts.from_batch;
      return this.request(`/api/kdag/job/${jobId}/rerun`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    return this.request(`/api/kdag/job/${jobId}/run`, {
      method: 'POST',
      ...(Object.keys(body).length > 0 && { body: JSON.stringify(body) }),
    });
  }

  async deleteKdagJob(jobId: string) {
    const response = await fetch(`${this.baseUrl}/api/kdag/jobs/${jobId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { deleted: true };
  }

  async getKdagJob(jobId: string, includeContent = false) {
    const qs = includeContent ? '?include_content=true' : '';
    return this.request(`/api/kdag/job/${jobId}${qs}`);
  }

  async getKdagStep(jobId: string, stepKey: string) {
    return this.request(`/api/kdag/job/${jobId}/steps/${encodeURIComponent(stepKey)}`);
  }

  async listKdagJobs(options?: {
    status?: string;
    job_type?: string;
    definition_key?: string;
    project?: string;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (options?.status) qs.set('status', options.status);
    if (options?.job_type) qs.set('job_type', options.job_type);
    if (options?.definition_key) qs.set('definition_key', options.definition_key);
    if (options?.project) qs.set('project', options.project);
    if (options?.limit) qs.set('limit', String(options.limit));
    if (options?.offset) qs.set('offset', String(options.offset));
    const params = qs.toString() ? `?${qs}` : '';
    return this.request(`/api/kdag/jobs${params}`);
  }

  // ── Kdag Input Types ────────────────────────────────────────────────

  async listKdagInputTypes() {
    return this.request('/api/kdag/input-types');
  }

  async createKdagInputType(body: { key: string; description?: string; format?: string }) {
    return this.request('/api/kdag/input-types', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // ── Prompts ──────────────────────────────────────────────────────────

  async listPrompts(options?: {
    q?: string;
    assistant?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (options?.q) qs.set('q', options.q);
    if (options?.assistant) qs.set('assistant', options.assistant);
    if (options?.type) qs.set('type', options.type);
    qs.set('compact', 'true');
    if (options?.limit) qs.set('limit', String(options.limit));
    if (options?.offset) qs.set('offset', String(options.offset));
    const params = qs.toString() ? `?${qs}` : '';
    return this.request(`/api/prompts${params}`);
  }

  async getPrompt(promptId: string) {
    return this.request(`/api/prompts/${promptId}`);
  }

  async createPrompt(
    handle: string,
    title: string,
    content: string,
    description?: string,
    assistants?: Array<{
      assistant_handle: string;
      prompt_type: string;
      source_path?: string;
    }>
  ) {
    return this.request('/api/prompts?compact=true', {
      method: 'POST',
      body: JSON.stringify({ handle, title, content, description: description || null, assistants }),
    });
  }

  async updatePrompt(
    promptId: string,
    updates: {
      title?: string;
      content?: string;
      description?: string;
      snapshot?: boolean;
    }
  ) {
    return this.request(`/api/prompts/${promptId}?compact=true`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deletePrompt(promptId: string) {
    const url = `${this.baseUrl}/api/prompts/${promptId}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  // ── DBX Saved Queries ────────────────────────────────────────────

  async listSavedQueries(options?: {
    connection_id?: string;
    session_id?: string;
    favorite?: boolean;
    shared?: boolean;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (options?.connection_id) qs.set('connection_id', options.connection_id);
    if (options?.session_id) qs.set('session_id', options.session_id);
    if (options?.favorite) qs.set('favorite', 'true');
    if (options?.shared) qs.set('shared', 'true');
    if (options?.q) qs.set('q', options.q);
    if (options?.limit) qs.set('limit', String(options.limit));
    if (options?.offset) qs.set('offset', String(options.offset));
    const params = qs.toString() ? `?${qs}` : '';
    return this.request(`/api/dbx/saved-queries${params}`);
  }

  async getSavedQuery(id: string, sessionId?: string) {
    const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    return this.request(`/api/dbx/saved-queries/${id}${params}`);
  }

  async createSavedQuery(input: {
    connection_id?: string | null;
    name: string;
    handle: string;
    description?: string;
    sql?: string;
    schema_scope?: string;
    is_shared?: boolean;
    is_readonly?: boolean;
    owner_session_id?: string;
    params?: Array<{
      name: string;
      value_type?: 'text' | 'number' | 'bool' | 'enum';
      required?: boolean;
      default_value?: string;
      options?: string[];
      sort_order?: number;
    }>;
  }) {
    return this.request('/api/dbx/saved-queries', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async updateSavedQuery(id: string, updates: {
    connection_id?: string | null;
    name?: string;
    handle?: string;
    description?: string;
    sql?: string;
    schema_scope?: string;
    is_shared?: boolean;
    is_readonly?: boolean;
    params?: Array<{
      name: string;
      value_type?: 'text' | 'number' | 'bool' | 'enum';
      required?: boolean;
      default_value?: string;
      options?: string[];
      sort_order?: number;
    }>;
    edited_by?: string;
  }) {
    return this.request(`/api/dbx/saved-queries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteSavedQuery(id: string) {
    const url = `${this.baseUrl}/api/dbx/saved-queries/${id}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  async runSavedQuery(
    id: string,
    body: {
      params?: Record<string, unknown>;
      session_id?: string;
      timeout?: number;
      maxRows?: number;
    },
  ) {
    return this.request(`/api/dbx/saved-queries/${id}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async listSavedQuerySnapshots(id: string) {
    return this.request(`/api/dbx/saved-queries/${id}/snapshots`);
  }

  async createSavedQuerySnapshot(id: string, editedBy?: string) {
    return this.request(`/api/dbx/saved-queries/${id}/snapshots`, {
      method: 'POST',
      body: JSON.stringify(editedBy ? { edited_by: editedBy } : {}),
    });
  }

  async restoreSavedQuerySnapshot(id: string, num: number, editedBy?: string) {
    return this.request(`/api/dbx/saved-queries/${id}/snapshots/${num}/restore`, {
      method: 'POST',
      body: JSON.stringify(editedBy ? { edited_by: editedBy } : {}),
    });
  }

  async deleteSavedQuerySnapshot(id: string, num: number) {
    const url = `${this.baseUrl}/api/dbx/saved-queries/${id}/snapshots/${num}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  // ── Assistant Chat ────────────────────────────────────────────

  async assistantChat(
    handle: string,
    promptText: string,
    messages?: Array<{ role: string; content: string }>,
    model?: string,
    chatId?: string,
    parentTurnId?: string,
    projectId?: string,
    title?: string,
    callerHandle?: string,
    useGoogleSearch?: boolean,
    useThinking?: boolean,
    thinkingBudget?: number,
  ) {
    const body: Record<string, any> = { prompt_text: promptText, source: 'mcp' };
    if (messages) body.messages = messages;
    if (model) body.model = model;
    if (chatId) body.chat_id = chatId;
    if (parentTurnId) body.parent_turn_id = parentTurnId;
    if (title) body.title = title;
    if (callerHandle) body.caller_handle = callerHandle;
    if (projectId) {
      body.project_id = projectId;
    }
    if (useGoogleSearch) body.use_google_search = useGoogleSearch;
    if (useThinking) body.use_thinking = useThinking;
    if (thinkingBudget != null) body.thinking_budget = thinkingBudget;
    return this.request(`/api/assistants/${encodeURIComponent(handle)}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async listAssistantChats(handle: string, projectId?: string, limit?: number, offset?: number) {
    const qs = new URLSearchParams();
    if (projectId) qs.set("project_id", projectId);
    if (limit) qs.set("limit", String(limit));
    if (offset) qs.set("offset", String(offset));
    const params = qs.toString() ? `?${qs}` : "";
    return this.request(`/api/assistants/${encodeURIComponent(handle)}/chats${params}`);
  }

  async getAssistantChat(handle: string | undefined, chatId: string, includeMessages?: boolean) {
    const qs = includeMessages ? "?include_messages=true" : "";
    if (handle) {
      return this.request(`/api/assistants/${encodeURIComponent(handle)}/chats/${chatId}${qs}`);
    }
    return this.request(`/api/chats/${chatId}${qs}`);
  }

  async getAssistantChatMessages(handle: string, chatId: string, limit?: number, offset?: number, order?: string) {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (offset) qs.set("offset", String(offset));
    if (order) qs.set("order", order);
    const params = qs.toString() ? `?${qs}` : "";
    return this.request(`/api/assistants/${encodeURIComponent(handle)}/chats/${chatId}/messages${params}`);
  }

  async deleteAssistantChat(handle: string | undefined, chatId: string) {
    const path = handle
      ? `/api/assistants/${encodeURIComponent(handle)}/chats/${chatId}`
      : `/api/chats/${chatId}`;
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  // ── Slack ────────────────────────────────────────────────────────────

  async ingestSlack(body: {
    content?: string;
    path?: string;
    document_id: string;
    channel: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request('/api/slack/ingest', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async ingestSlackDir(body: {
    path: string;
    channel?: string;
    workspace?: string;
    team?: string;
    topic?: string;
    date_range?: string;
  }) {
    return this.request('/api/slack/ingest-dir', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async searchSlack(q: string, options?: { mode?: 'keyword' | 'semantic'; channel?: string; workspace?: string; limit?: number; since?: string; until?: string }) {
    const qs = new URLSearchParams();
    qs.set('q', q);
    if (options?.mode) qs.set('mode', options.mode);
    if (options?.channel) qs.set('channel', options.channel);
    if (options?.workspace) qs.set('workspace', options.workspace);
    if (options?.since) qs.set('since', options.since);
    if (options?.until) qs.set('until', options.until);
    if (options?.limit) qs.set('limit', String(options.limit));
    return this.request(`/api/slack/search?${qs}`);
  }

  async listSlackChannels(channel?: string) {
    const qs = new URLSearchParams();
    if (channel) qs.set('channel', channel);
    const params = qs.toString() ? `?${qs}` : '';
    return this.request(`/api/slack/channels${params}`);
  }

  async listSlackDocuments(opts?: { channel?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (opts?.channel) qs.set('channel', opts.channel);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.offset) qs.set('offset', String(opts.offset));
    const params = qs.toString() ? `?${qs}` : '';
    return this.request(`/api/slack/documents${params}`);
  }

  async deleteSlackDocument(documentId: string) {
    const url = `${this.baseUrl}/api/slack/documents/${encodeURIComponent(documentId)}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  // ── Registered Slack Channels ───────────────────────────────────────

  async listRegisteredSlackChannels(workspace?: string) {
    const qs = new URLSearchParams();
    if (workspace) qs.set('workspace', workspace);
    const params = qs.toString() ? `?${qs}` : '';
    return this.request(`/api/slack/channels/registered${params}`);
  }

  async registerSlackChannel(body: {
    channel_id: string;
    workspace_id: string;
    workspace_name?: string;
    channel_name: string;
    channel_type?: string;
    export_path?: string;
  }) {
    return this.request('/api/slack/channels/register', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async syncSlackChannel(id: string) {
    return this.request(`/api/slack/channels/registered/${id}/sync`, {
      method: 'POST',
    });
  }

  // ── kvec ─────────────────────────────────────────────────────────────

  async bulkDeleteKvecFiles(collectionName: string, ids: string[]) {
    return this.request(
      `/api/kvec/collections/${encodeURIComponent(collectionName)}/files/bulk-delete`,
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }
    );
  }

  async deleteAllKvecFilesByCollection(collectionName: string) {
    return this.request(
      `/api/kvec/collections/${encodeURIComponent(collectionName)}/files`,
      {
        method: 'DELETE',
      }
    );
  }

  async deleteKvecFilesByChannel(collectionName: string, channel: string) {
    return this.request(
      `/api/kvec/collections/${encodeURIComponent(collectionName)}/files/by-channel/${encodeURIComponent(channel)}`,
      {
        method: 'DELETE',
      }
    );
  }

  async getEmbedHealth() {
    return this.request('/api/kvec/embed/health');
  }

  async deleteAssistantChatMessage(handle: string, chatId: string, messageId: string) {
    const url = `${this.baseUrl}/api/assistants/${encodeURIComponent(handle)}/chats/${chatId}/messages/${messageId}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { success: true };
  }

  // Live messages (ephemeral, Redis-backed)

  async sendLiveMessage(toSessionId: string, fromSessionId: string, content: string, fromNickname?: string) {
    return this.request(`/api/live-messages/${encodeURIComponent(toSessionId)}`, {
      method: 'POST',
      body: JSON.stringify({ from_session_id: fromSessionId, content, from_nickname: fromNickname }),
    });
  }

  async checkLiveMessages(sessionId: string, opts?: { limit?: number; peek?: boolean }) {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.peek) params.set('peek', 'true');
    const qs = params.toString();
    return this.request(`/api/live-messages/${encodeURIComponent(sessionId)}${qs ? `?${qs}` : ''}`);
  }

  async deleteLiveMessage(toSessionId: string, messageId: string, fromSessionId: string) {
    const params = new URLSearchParams({ from_session_id: fromSessionId });
    return this.request(
      `/api/live-messages/${encodeURIComponent(toSessionId)}/messages/${encodeURIComponent(messageId)}?${params}`,
      { method: 'DELETE' }
    );
  }

  async countLiveMessages(sessionId: string) {
    return this.request(`/api/live-messages/${encodeURIComponent(sessionId)}/count`);
  }

  async getLiveMessageHealth() {
    return this.request('/api/live-messages/health');
  }

  // Agent questions (ephemeral, Redis-backed)

  async createAgentQuestion(body: {
    title: string;
    description?: string;
    fields: unknown;
    agent?: { session_id?: string; nickname?: string; assistant_handle?: string };
    ttl_seconds?: number;
  }) {
    return this.request('/api/agent-questions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getAgentQuestion(id: string) {
    return this.request(`/api/agent-questions/${encodeURIComponent(id)}`);
  }

  async listAgentQuestions(opts?: { nickname?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.nickname) params.set('nickname', opts.nickname);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request(`/api/agent-questions${qs ? `?${qs}` : ''}`);
  }

  async cancelAgentQuestion(id: string) {
    return this.request(`/api/agent-questions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Long-poll for question resolution. Returns a discriminated union by status.
   * Does not throw on 408 (expired) or 410 (canceled).
   */
  async waitForAgentAnswer(id: string, timeoutMs: number): Promise<{
    status: 'answered' | 'expired' | 'canceled';
    answer?: unknown;
    question?: unknown;
  }> {
    const url = `${this.baseUrl}/api/agent-questions/${encodeURIComponent(id)}/wait?timeout_ms=${timeoutMs}`;
    const response = await fetch(url);
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }
    if (response.status === 200) {
      return { status: 'answered', answer: body?.answer ?? null, question: body?.question ?? null };
    }
    if (response.status === 408) {
      return { status: 'expired' };
    }
    if (response.status === 410) {
      return { status: 'canceled', question: body?.question ?? null };
    }
    throw new Error(`API request failed: ${response.status} ${text}`);
  }

  async getJobErrors(opts?: { limit?: number; jobId?: string; definitionKey?: string }) {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.jobId) params.set('job_id', opts.jobId);
    if (opts?.definitionKey) params.set('definition_key', opts.definitionKey);
    const qs = params.toString();
    return this.request(`/api/kdag/errors${qs ? `?${qs}` : ''}`);
  }

  async clearJobErrors() {
    return this.request('/api/kdag/errors', { method: 'DELETE' });
  }

  async getGoogleStatus() {
    return this.request('/api/google/status');
  }

  async pushToGoogleDoc(docId: string, memoryId: string, mode?: string) {
    return this.request(`/api/google/docs/${encodeURIComponent(docId)}/push`, {
      method: 'POST',
      body: JSON.stringify({ memory_id: memoryId, mode }),
    });
  }

  async importGoogleDoc(
    docId: string,
    projectId: string,
    options?: { handle?: string; type?: string; subtype?: string; tags?: string[]; includeComments?: boolean }
  ) {
    return this.request(`/api/google/docs/${encodeURIComponent(docId)}/import`, {
      method: 'POST',
      body: JSON.stringify({
        project_id: projectId,
        handle: options?.handle,
        type: options?.type,
        subtype: options?.subtype,
        tags: options?.tags,
        includeComments: options?.includeComments,
      }),
    });
  }

  // Session Teams
  async listSessionTeams(project?: string) {
    const qs = project ? `?project=${encodeURIComponent(project)}` : '';
    return this.request(`/api/session-teams${qs}`);
  }

  async getSessionTeam(teamId: string) {
    return this.request(`/api/session-teams/${teamId}`);
  }

  async createSessionTeam(data: { name: string; description?: string; project?: string }) {
    return this.request('/api/session-teams', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSessionTeam(teamId: string, data: { name?: string; description?: string }) {
    return this.request(`/api/session-teams/${teamId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteSessionTeam(teamId: string) {
    const url = `${this.baseUrl}/api/session-teams/${teamId}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { deleted: true };
  }

  async addTeamMembers(teamId: string, sessionIds: string[]) {
    return this.request(`/api/session-teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ session_ids: sessionIds }),
    });
  }

  async reorderTeamMembers(teamId: string, sessionIds: string[]) {
    return this.request(`/api/session-teams/${teamId}/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ session_ids: sessionIds }),
    });
  }

  async removeTeamMember(teamId: string, sessionId: string) {
    const url = `${this.baseUrl}/api/session-teams/${teamId}/members/${sessionId}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }
    return { removed: true };
  }

  async broadcastToTeam(teamId: string, content: string, fromSessionId = 'mcp') {
    return this.request(`/api/session-teams/${teamId}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ content, from_session_id: fromSessionId }),
    });
  }

  // ========== kapi (built-in API tool) ==========
  // Collections are kapi's top-level grouping; they replace the previous
  // per-public-project ownership. Identifiers below accept either a UUID
  // or a kebab-case handle — the API's resolveCollection handles both.

  async listKapiCollections() {
    return this.request(`/api/kapi/collections`);
  }

  async createKapiCollection(input: {
    handle: string;
    name: string;
    description?: string | null;
  }) {
    return this.request(`/api/kapi/collections`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getKapiCollection(idOrHandle: string) {
    return this.request(`/api/kapi/collections/${idOrHandle}`);
  }

  async updateKapiCollection(id: string, input: Record<string, unknown>) {
    return this.request(`/api/kapi/collections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteKapiCollection(id: string) {
    const response = await fetch(`${this.baseUrl}/api/kapi/collections/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${await response.text()}`);
    }
    return { deleted: true };
  }

  async listKapiDefinitions(collectionIdOrHandle: string) {
    return this.request(
      `/api/kapi/collections/${collectionIdOrHandle}/definitions`
    );
  }

  async createKapiDefinition(
    collectionIdOrHandle: string,
    input: {
      handle: string;
      name: string;
      description?: string | null;
      base_url?: string | null;
      default_auth?: Record<string, unknown>;
    }
  ) {
    return this.request(`/api/kapi/collections/${collectionIdOrHandle}/definitions`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateKapiDefinition(
    id: string,
    input: Record<string, unknown>
  ) {
    return this.request(`/api/kapi/definitions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteKapiDefinition(id: string) {
    const response = await fetch(`${this.baseUrl}/api/kapi/definitions/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${await response.text()}`);
    }
    return { deleted: true };
  }

  async listKapiRequests(definitionId: string) {
    return this.request(`/api/kapi/definitions/${definitionId}/requests`);
  }

  async addKapiRequest(
    definitionId: string,
    input: {
      name: string;
      method: string;
      path?: string;
      headers?: Array<{ key: string; value: string; enabled?: boolean }>;
      query_params?: Array<{ key: string; value: string; enabled?: boolean }>;
      body_type?: string;
      body_content?: string;
      body_language?: string;
    }
  ) {
    return this.request(`/api/kapi/definitions/${definitionId}/requests`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateKapiRequest(id: string, input: Record<string, unknown>) {
    return this.request(`/api/kapi/requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteKapiRequest(id: string) {
    const response = await fetch(`${this.baseUrl}/api/kapi/requests/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${await response.text()}`);
    }
    return { deleted: true };
  }

  async runKapiRequest(
    requestId: string,
    options?: {
      allow_insecure_tls?: boolean;
      timeout_ms?: number;
    }
  ) {
    return this.request(`/api/kapi/requests/${requestId}/run`, {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  }

  async runKapiAdHoc(
    collectionIdOrHandle: string,
    input: {
      method: string;
      url: string;
      headers?: Array<{ key: string; value: string; enabled?: boolean }>;
      body?: string | null;
      environment_id?: string | null;
    }
  ) {
    return this.request(`/api/kapi/collections/${collectionIdOrHandle}/runs`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listKapiRuns(
    collectionIdOrHandle: string,
    params?: { request_id?: string; limit?: number }
  ) {
    const qs = new URLSearchParams();
    if (params?.request_id) qs.set("request_id", params.request_id);
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request(
      `/api/kapi/collections/${collectionIdOrHandle}/runs${suffix}`
    );
  }

  async getKapiRun(id: string) {
    return this.request(`/api/kapi/runs/${id}`);
  }

  async listKapiEnvironments(collectionIdOrHandle: string) {
    return this.request(
      `/api/kapi/collections/${collectionIdOrHandle}/environments`
    );
  }

  async createKapiEnvironment(
    collectionIdOrHandle: string,
    input: { handle: string; name: string; is_active?: boolean }
  ) {
    return this.request(`/api/kapi/collections/${collectionIdOrHandle}/environments`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async activateKapiEnvironment(id: string) {
    return this.request(`/api/kapi/environments/${id}/activate`, {
      method: "POST",
    });
  }

  async setKapiEnvVar(
    environmentId: string,
    input: { key: string; value: string; is_secret?: boolean; description?: string | null }
  ) {
    return this.request(`/api/kapi/environments/${environmentId}/vars`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listKapiEnvVars(environmentId: string) {
    return this.request(`/api/kapi/environments/${environmentId}/vars`);
  }

  async getKapiRequest(requestId: string) {
    return this.request(`/api/kapi/requests/${requestId}`);
  }

  // ── Notifications (debug-only, gated to NODE_ENV !== 'production') ──

  async debugRaiseNotification(input: {
    id?: string;
    kind?: string;
    severity?: 'info' | 'warning' | 'error';
    title?: string;
    body?: string;
  }) {
    return this.request(`/api/notifications/_debug-raise`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async debugClearNotification(id: string) {
    return this.request(`/api/notifications/${encodeURIComponent(id)}/_debug-clear`, {
      method: 'POST',
    });
  }
}
