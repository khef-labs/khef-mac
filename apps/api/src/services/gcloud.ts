/**
 * Shared gcloud CLI utilities.
 * Uses spawn() with argument arrays to avoid shell interpretation.
 */

import { spawn } from 'child_process'

// Common gcloud installation paths
const GCLOUD_PATHS = [
  '/opt/homebrew/share/google-cloud-sdk/bin',
  '/usr/local/google-cloud-sdk/bin',
  '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin',
  `${process.env.HOME}/google-cloud-sdk/bin`,
]

// Get PATH with gcloud locations included
function getEnhancedPath(): string {
  const currentPath = process.env.PATH || ''
  const additionalPaths = GCLOUD_PATHS.filter(p => !currentPath.includes(p))
  return [...additionalPaths, currentPath].join(':')
}

const spawnEnv = { ...process.env, PATH: getEnhancedPath() }

/**
 * Run a command with spawn() (no shell) and return stdout.
 * Rejects if the process exits non-zero.
 */
export function spawnAsync(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { env: spawnEnv })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}

/**
 * Check if gcloud CLI is in PATH.
 */
export async function isGcloudInstalled(): Promise<boolean> {
  try {
    await spawnAsync('which', ['gcloud'])
    return true
  } catch {
    return false
  }
}

/**
 * Get the current gcloud account email, or null if unset.
 */
export async function getGcloudAccount(): Promise<string | null> {
  const stdout = await spawnAsync('gcloud', ['config', 'get-value', 'account'])
  const email = stdout.trim()
  return (!email || email === '(unset)') ? null : email
}

/**
 * Get an access token from gcloud, optionally for a specific account.
 */
export async function getGcloudAccessToken(account?: string): Promise<string> {
  const args = ['auth', 'print-access-token']
  if (account) args.push(account)
  const stdout = await spawnAsync('gcloud', args)
  return stdout.trim()
}

export interface GcloudAccountInfo {
  account: string
  active: boolean
}

/**
 * List authenticated gcloud accounts and their active state.
 */
export async function listGcloudAccounts(): Promise<GcloudAccountInfo[]> {
  const stdout = await spawnAsync('gcloud', ['auth', 'list', '--format=json'])
  const parsed = JSON.parse(stdout) as Array<{ account?: string; status?: string }>
  return parsed
    .filter(row => typeof row.account === 'string' && row.account.length > 0)
    .map(row => ({
      account: row.account as string,
      active: row.status === 'ACTIVE',
    }))
}

/**
 * Set the active gcloud account.
 */
export async function setGcloudAccount(account: string): Promise<void> {
  await spawnAsync('gcloud', ['config', 'set', 'account', account])
}
