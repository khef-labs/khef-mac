import { PlansPage } from '../PlansPage'

interface Props {
  handle: string
}

export function PlansSection({ handle }: Props) {
  return <PlansPage handle={handle} embedded />
}
