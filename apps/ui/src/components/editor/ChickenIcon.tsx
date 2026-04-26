interface ChickenIconProps {
  size?: number
  class?: string
}

export function ChickenIcon({ size = 14, class: className }: ChickenIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      aria-hidden="true"
    >
      <path d="M16 4 L16.5 3 L17 4 L17.5 3 L18 4" />
      <circle cx="17" cy="6" r="2" />
      <path d="M19 6 L20.5 6 L19.3 7" />
      <path d="M17.5 8 L17.5 9" />
      <path d="M15.8 7.6 C14.5 9, 13.5 10.5, 13 11.5" />
      <ellipse cx="9" cy="15" rx="6" ry="4" />
      <path d="M7 14 C8.5 15.5, 11 15.5, 12.5 14" />
      <path d="M3 13 L1.5 11 M3 14.5 L1 13.5 M3 16 L1.5 16" />
      <line x1="7.5" y1="19" x2="7" y2="22" />
      <line x1="11" y1="19" x2="11.5" y2="22" />
    </svg>
  )
}
