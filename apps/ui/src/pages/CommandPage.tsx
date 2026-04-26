import { AssistantToolPage } from './AssistantToolPage'

interface Props {
  assistantHandle: string
  commandName: string
}

export function CommandPage({ assistantHandle, commandName }: Props) {
  return (
    <AssistantToolPage
      assistantHandle={assistantHandle}
      itemName={commandName}
      kind="command"
      routeSection="commands"
    />
  )
}
