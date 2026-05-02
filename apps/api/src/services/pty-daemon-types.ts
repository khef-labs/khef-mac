export interface PtySpawnConfig {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  name: string;
  command: string;
  args: string[];
  fallbackCommand: string;
  fallbackArgs: string[];
  missingCommandMessage?: string;
}

export interface PtyAttachResult {
  ptyId: string;
  pid: number;
  reused: boolean;
  warning?: string;
}

export type PtyDaemonRequest =
  | {
      type: 'create_or_attach';
      requestId: string;
      key: string;
      config: PtySpawnConfig;
      // When set and the requested key has no existing PTY, look for a
      // managed PTY whose child process pid matches; if found, register
      // `key` as an alias and return that PTY (reused: true). Lets the
      // browser reconnect with a sessionId-based key onto a PTY originally
      // spawned with a cwd-based key.
      adoptByPid?: number;
    }
  | {
      type: 'write';
      requestId: string;
      ptyId: string;
      data: string;
    }
  | {
      type: 'resize';
      requestId: string;
      ptyId: string;
      cols: number;
      rows: number;
    }
  | {
      type: 'kill';
      requestId: string;
      ptyId: string;
    }
  | {
      type: 'list_pids';
      requestId: string;
    }
  | {
      type: 'find_by_key';
      requestId: string;
      key: string;
    }
  | {
      type: 'find_by_pid';
      requestId: string;
      pid: number;
    }
  | {
      type: 'shutdown';
      requestId: string;
    };

export type PtyDaemonResponse =
  | {
      type: 'daemon_ready';
    }
  | {
      type: 'response';
      requestId: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: 'response';
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: 'pty_data';
      ptyId: string;
      data: string;
    }
  | {
      type: 'pty_exit';
      ptyId: string;
      code: number;
      signal: number | null;
    };
