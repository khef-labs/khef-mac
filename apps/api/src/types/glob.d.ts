declare module 'glob' {
  interface GlobOptions {
    cwd?: string
    absolute?: boolean
    ignore?: string | string[]
    dot?: boolean
    nodir?: boolean
  }

  interface Glob {
    sync(pattern: string, options?: GlobOptions): string[]
  }

  export const glob: Glob
}
