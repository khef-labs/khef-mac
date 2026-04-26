import { Route, Switch, Redirect } from 'wouter-preact'
import { AppShell, PageMeta, PageMetaProvider } from './components/layout'
import { ToastProvider } from './components/ui'
import {
  SearchPage,
  ProjectsPage,
  ProjectPage,
  ProjectConfigsPage,
  ProjectAgentsPage,
  ProjectAgentPage,
  ProjectSessionsPage,
  ProjectSessionTranscriptsPage,
  MemoryPage,
  GraphPage,
  SessionPage,
  SessionFilePage,
  SettingsPage,
  SettingsLayout,
  StatsPage,
  AssistantsPage,
  AssistantPage,
  AssistantLayout,
  ConfigPage,
  AgentPage,
  CommandPage,
  SkillPage,
  PlanPage,
  ProjectPlansPage,
  ProjectMemoryFilesPage,
  MemoryFilePage,
  ProjectDiffPage,
  CustomTypeFormPage,
  PromptsPage,
  PromptPage,
  SessionsPage,
  TeamsPage,
  TeamBoardPage,
  KvecPage,
  KvecCollectionPage,
  KdagPage,
  JobsPage,
  JobPage,
  DefinitionsPage,
  DefinitionEditorPage,
  ChatPage,
  CollectionsPage,
  CollectionPage,
  ProjectFilesPage,
  EditorPage,
  DatabasePage,
  KapiPage,
} from './pages'

export function App() {
  return (
    <ToastProvider>
      <PageMetaProvider>
        <AppShell>
          <Switch>
            <Route path="/">
              <Redirect to="/projects" />
            </Route>

            <Route path="/search">
              <PageMeta label="SearchPage" templateFiles={['src/pages/SearchPage.tsx']}>
                <SearchPage />
              </PageMeta>
            </Route>

            <Route path="/projects">
              <PageMeta label="ProjectsPage" templateFiles={['src/pages/ProjectsPage.tsx']}>
                <ProjectsPage />
              </PageMeta>
            </Route>

            <Route path="/projects/:id/graph">
              {(params) => (
                <PageMeta label="GraphPage" templateFiles={['src/pages/GraphPage.tsx']}>
                  <GraphPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/configs">
              {(params) => (
                <PageMeta label="ProjectConfigsPage" templateFiles={['src/pages/ProjectConfigsPage.tsx']}>
                  <ProjectConfigsPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/agents">
              {(params) => (
                <PageMeta label="ProjectAgentsPage" templateFiles={['src/pages/ProjectAgentsPage.tsx']}>
                  <ProjectAgentsPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/agents/:name">
              {(params) => (
                <PageMeta label="ProjectAgentPage" templateFiles={['src/pages/ProjectAgentPage.tsx']}>
                  <ProjectAgentPage projectId={params.id} agentName={decodeURIComponent(params.name)} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/sessions/files/:sessionId">
              {(params) => (
                <PageMeta label="SessionFilePage" templateFiles={['src/pages/SessionFilePage.tsx']}>
                  <SessionFilePage projectId={params.id} sessionId={decodeURIComponent(params.sessionId)} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/sessions/files">
              {(params) => (
                <PageMeta label="ProjectSessionsPage" templateFiles={['src/pages/ProjectSessionsPage.tsx']}>
                  <ProjectSessionsPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/sessions/transcripts/:sessionId">
              {(params) => (
                <PageMeta label="SessionPage" templateFiles={['src/pages/SessionPage.tsx']}>
                  <SessionPage id={params.sessionId} projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/sessions/transcripts">
              {(params) => (
                <PageMeta label="ProjectSessionTranscriptsPage" templateFiles={['src/pages/ProjectSessionTranscriptsPage.tsx']}>
                  <ProjectSessionTranscriptsPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/sessions/:sessionId">
              {(params) => (
                <PageMeta label="SessionPage" templateFiles={['src/pages/SessionPage.tsx']}>
                  <SessionPage id={params.sessionId} projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/sessions">
              {(params) => <Redirect to={`/sessions?project=${params.id}`} />}
            </Route>

            <Route path="/projects/:id/plans/:filename">
              {(params) => (
                <PageMeta label="PlanPage" templateFiles={['src/pages/PlanPage.tsx']}>
                  <PlanPage
                    handle="claude-code"
                    filename={decodeURIComponent(params.filename)}
                    projectId={params.id}
                  />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/plans">
              {(params) => (
                <PageMeta label="ProjectPlansPage" templateFiles={['src/pages/ProjectPlansPage.tsx']}>
                  <ProjectPlansPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/memory-files/:filename">
              {(params) => (
                <PageMeta label="MemoryFilePage" templateFiles={['src/pages/MemoryFilePage.tsx']}>
                  <MemoryFilePage
                    projectId={params.id}
                    filename={decodeURIComponent(params.filename)}
                  />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/memory-files">
              {(params) => (
                <PageMeta label="ProjectMemoryFilesPage" templateFiles={['src/pages/ProjectMemoryFilesPage.tsx']}>
                  <ProjectMemoryFilesPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/files">
              {(params) => (
                <PageMeta label="ProjectFilesPage" templateFiles={['src/pages/ProjectFilesPage.tsx']}>
                  <ProjectFilesPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/collections/:collectionId">
              {(params) => (
                <PageMeta label="CollectionPage" templateFiles={['src/pages/CollectionPage.tsx']}>
                  <CollectionPage projectId={params.id} collectionId={params.collectionId} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/collections">
              {(params) => (
                <PageMeta label="CollectionsPage" templateFiles={['src/pages/CollectionsPage.tsx']}>
                  <CollectionsPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/projects/:id/diff">
              {(params) => (
                <PageMeta label="ProjectDiffPage" templateFiles={['src/pages/ProjectDiffPage.tsx']}>
                  <ProjectDiffPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/kapi/:handle">
              {(params) => (
                <PageMeta label="KapiPage" templateFiles={['src/pages/KapiPage.tsx']}>
                  <KapiPage initialCollectionHandle={params.handle} />
                </PageMeta>
              )}
            </Route>

            <Route path="/kapi">
              <PageMeta label="KapiPage" templateFiles={['src/pages/KapiPage.tsx']}>
                <KapiPage />
              </PageMeta>
            </Route>

            <Route path="/projects/:id">
              {(params) => (
                <PageMeta label="ProjectPage" templateFiles={['src/pages/ProjectPage.tsx']}>
                  <ProjectPage projectId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/memories/:id">
              {(params) => (
                <PageMeta label="MemoryPage" templateFiles={['src/pages/MemoryPage.tsx']}>
                  <MemoryPage id={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/memories/:id/graph">
              {(params) => (
                <PageMeta label="GraphPage" templateFiles={['src/pages/GraphPage.tsx']}>
                  <GraphPage memoryId={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/stats">
              <PageMeta label="StatsPage" templateFiles={['src/pages/StatsPage.tsx']}>
                <StatsPage />
              </PageMeta>
            </Route>

            <Route path="/teams">
              <PageMeta label="TeamsPage" templateFiles={['src/pages/TeamsPage.tsx']}>
                <TeamsPage />
              </PageMeta>
            </Route>

            <Route path="/teams/:id">
              {(params) => (
                <PageMeta label="TeamBoardPage" templateFiles={['src/pages/TeamBoardPage.tsx']}>
                  <TeamBoardPage id={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/sessions">
              <PageMeta label="SessionsPage" templateFiles={['src/pages/SessionsPage.tsx']}>
                <SessionsPage />
              </PageMeta>
            </Route>

            <Route path="/sessions/:id">
              {(params) => (
                <PageMeta label="SessionPage" templateFiles={['src/pages/SessionPage.tsx']}>
                  <SessionPage id={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/settings/custom-types/new">
              <PageMeta label="CustomTypeFormPage" templateFiles={['src/pages/CustomTypeFormPage.tsx']}>
                <SettingsLayout section="custom-types" hideContentHeader>
                  <CustomTypeFormPage />
                </SettingsLayout>
              </PageMeta>
            </Route>

            <Route path="/settings/custom-types/:name/edit">
              {(params) => (
                <PageMeta label="CustomTypeFormPage" templateFiles={['src/pages/CustomTypeFormPage.tsx']}>
                  <SettingsLayout section="custom-types" hideContentHeader>
                    <CustomTypeFormPage typeName={decodeURIComponent(params.name)} />
                  </SettingsLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/settings/editor/:subsection">
              {(params) => (
                <PageMeta label="SettingsPage" templateFiles={['src/pages/settings/SettingsPage.tsx']}>
                  <SettingsPage section={`editor/${params.subsection}`} />
                </PageMeta>
              )}
            </Route>

            <Route path="/settings/editor">
              <Redirect to="/settings/editor/scratch" />
            </Route>

            <Route path="/settings/:section">
              {(params) => (
                <PageMeta label="SettingsPage" templateFiles={['src/pages/settings/SettingsPage.tsx']}>
                  <SettingsPage section={params.section} />
                </PageMeta>
              )}
            </Route>

            <Route path="/settings">
              <PageMeta label="SettingsPage" templateFiles={['src/pages/settings/SettingsPage.tsx']}>
                <SettingsPage />
              </PageMeta>
            </Route>

            <Route path="/assistants">
              <PageMeta label="AssistantsPage" templateFiles={['src/pages/AssistantsPage.tsx']}>
                <AssistantsPage />
              </PageMeta>
            </Route>

            <Route path="/assistants/:handle/sessions/:dirName/:sessionId">
              {(params) => (
                <PageMeta label="SessionFilePage" templateFiles={['src/pages/SessionFilePage.tsx']}>
                  <AssistantLayout handle={params.handle} section="repos" hideContentHeader>
                    <SessionFilePage
                      handle={params.handle}
                      dirName={decodeURIComponent(params.dirName)}
                      sessionId={decodeURIComponent(params.sessionId)}
                    />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/sessions/:dirName">
              {(params) => (
                <PageMeta label="ProjectSessionsPage" templateFiles={['src/pages/ProjectSessionsPage.tsx']}>
                  <AssistantLayout handle={params.handle} section="repos" hideContentHeader>
                    <ProjectSessionsPage
                      handle={params.handle}
                      dirName={decodeURIComponent(params.dirName)}
                    />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/configs/:id">
              {(params) => (
                <PageMeta label="ConfigPage" templateFiles={['src/pages/ConfigPage.tsx']}>
                  <AssistantLayout handle={params.handle} section="configs" hideContentHeader>
                    <ConfigPage assistantHandle={params.handle} configId={params.id} />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/agents/:name">
              {(params) => (
                <PageMeta label="AgentPage" templateFiles={['src/pages/AgentPage.tsx']}>
                  <AssistantLayout handle={params.handle} section="agents" hideContentHeader>
                    <AgentPage assistantHandle={params.handle} agentName={decodeURIComponent(params.name)} />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/commands/:name">
              {(params) => (
                <PageMeta label="CommandPage" templateFiles={['src/pages/CommandPage.tsx']}>
                  <AssistantLayout handle={params.handle} section="commands" hideContentHeader>
                    <CommandPage assistantHandle={params.handle} commandName={decodeURIComponent(params.name)} />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/skills/:name">
              {(params) => (
                <PageMeta label="SkillPage" templateFiles={['src/pages/SkillPage.tsx']}>
                  <AssistantLayout handle={params.handle} section="skills" hideContentHeader>
                    <SkillPage assistantHandle={params.handle} skillName={decodeURIComponent(params.name)} />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/plans/:filename">
              {(params) => (
                <PageMeta label="PlanPage" templateFiles={['src/pages/PlanPage.tsx']}>
                  <AssistantLayout handle={params.handle} section="plans" hideContentHeader>
                    <PlanPage handle={params.handle} filename={decodeURIComponent(params.filename)} />
                  </AssistantLayout>
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle/:section">
              {(params) => (
                <PageMeta label="AssistantPage" templateFiles={['src/pages/assistant/AssistantPage.tsx']}>
                  <AssistantPage handle={params.handle} section={params.section} />
                </PageMeta>
              )}
            </Route>

            <Route path="/assistants/:handle">
              {(params) => (
                <PageMeta label="AssistantPage" templateFiles={['src/pages/assistant/AssistantPage.tsx']}>
                  <AssistantPage handle={params.handle} />
                </PageMeta>
              )}
            </Route>

            <Route path="/prompts/new">
              <PageMeta label="PromptPage" templateFiles={['src/pages/PromptPage.tsx']}>
                <PromptPage isNew />
              </PageMeta>
            </Route>

            <Route path="/prompts/:id">
              {(params) => (
                <PageMeta label="PromptPage" templateFiles={['src/pages/PromptPage.tsx']}>
                  <PromptPage id={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/prompts">
              <PageMeta label="PromptsPage" templateFiles={['src/pages/PromptsPage.tsx']}>
                <PromptsPage />
              </PageMeta>
            </Route>

            <Route path="/chat/new">
              <PageMeta label="ChatPage" templateFiles={['src/pages/ChatPage.tsx']}>
                <ChatPage isNew />
              </PageMeta>
            </Route>

            <Route path="/chat/:id">
              {(params) => (
                <PageMeta label="ChatPage" templateFiles={['src/pages/ChatPage.tsx']}>
                  <ChatPage id={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/chat">
              <PageMeta label="ChatPage" templateFiles={['src/pages/ChatPage.tsx']}>
                <ChatPage />
              </PageMeta>
            </Route>

            <Route path="/kvec">
              <PageMeta label="KvecPage" templateFiles={['src/pages/KvecPage.tsx']}>
                <KvecPage />
              </PageMeta>
            </Route>

            <Route path="/kvec/:name">
              {(params) => (
                <PageMeta label="KvecCollectionPage" templateFiles={['src/pages/KvecCollectionPage.tsx']}>
                  <KvecCollectionPage name={decodeURIComponent(params.name)} />
                </PageMeta>
              )}
            </Route>

            <Route path="/editor">
              <PageMeta label="EditorPage" templateFiles={['src/pages/EditorPage.tsx']}>
                <EditorPage />
              </PageMeta>
            </Route>

            <Route path="/database">
              <PageMeta label="DatabasePage" templateFiles={['src/pages/database-page/DatabasePage.tsx']}>
                <DatabasePage />
              </PageMeta>
            </Route>

            <Route path="/kdag/definitions/new">
              <PageMeta label="DefinitionEditorPage" templateFiles={['src/pages/DefinitionEditorPage.tsx']}>
                <DefinitionEditorPage isNew />
              </PageMeta>
            </Route>

            <Route path="/kdag/definitions/:key">
              {(params) => (
                <PageMeta label="DefinitionEditorPage" templateFiles={['src/pages/DefinitionEditorPage.tsx']}>
                  <DefinitionEditorPage defKey={params.key} />
                </PageMeta>
              )}
            </Route>

            <Route path="/kdag/definitions">
              <PageMeta label="DefinitionsPage" templateFiles={['src/pages/DefinitionsPage.tsx']}>
                <DefinitionsPage />
              </PageMeta>
            </Route>

            <Route path="/kdag/jobs/:id">
              {(params) => (
                <PageMeta label="JobPage" templateFiles={['src/pages/JobPage.tsx']}>
                  <JobPage id={params.id} />
                </PageMeta>
              )}
            </Route>

            <Route path="/kdag/jobs">
              <PageMeta label="JobsPage" templateFiles={['src/pages/JobsPage.tsx']}>
                <JobsPage />
              </PageMeta>
            </Route>

            <Route path="/kdag">
              <PageMeta label="KdagPage" templateFiles={['src/pages/KdagPage.tsx']}>
                <KdagPage />
              </PageMeta>
            </Route>

            <Route>
              <PageMeta label="NotFound" templateFiles={['src/app.tsx']}>
                <div style={{ padding: 'var(--space-6)' }}>
                  <h1>404 - Not Found</h1>
                  <p style={{ color: 'var(--muted)' }}>Page not found</p>
                </div>
              </PageMeta>
            </Route>
          </Switch>
        </AppShell>
      </PageMetaProvider>
    </ToastProvider>
  )
}
