import { AssistantToolPage } from './AssistantToolPage'

interface Props {
  assistantHandle: string
  skillName: string
}

export function SkillPage({ assistantHandle, skillName }: Props) {
  return (
    <AssistantToolPage
      assistantHandle={assistantHandle}
      itemName={skillName}
      kind="skill"
      routeSection="skills"
    />
  )
}
