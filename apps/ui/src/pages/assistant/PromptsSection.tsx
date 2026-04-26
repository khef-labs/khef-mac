import { PromptsPage } from '../PromptsPage'

interface Props {
  handle: string
}

export function PromptsSection({ handle }: Props) {
  return <PromptsPage handle={handle} embedded />
}
