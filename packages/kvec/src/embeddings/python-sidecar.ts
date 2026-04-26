import { spawn } from 'child_process';
import { EmbeddingProvider, EmbeddingConfig } from '../types';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:9100';
const DEFAULT_MODEL = 'all-mpnet-base-v2';
const SERVER_CHECK_INTERVAL_SUCCESS = 60_000;
const SERVER_CHECK_INTERVAL_FAILURE = 5_000;

interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

const KNOWN_DIMENSIONS: Record<string, number> = {
  'all-mpnet-base-v2': 768,
  'all-MiniLM-L6-v2': 384,
  'all-MiniLM-L12-v2': 384,
  'paraphrase-multilingual-mpnet-base-v2': 768,
};

export class PythonSidecarProvider implements EmbeddingProvider {
  private serverUrl: string;
  private scriptPath: string | undefined;
  private modelName: string;

  private serverAvailable: boolean | null = null;
  private serverLastCheck = 0;

  constructor(config: EmbeddingConfig) {
    this.serverUrl = config.serverUrl ?? DEFAULT_SERVER_URL;
    this.scriptPath = config.scriptPath;
    this.modelName = config.model ?? DEFAULT_MODEL;
  }

  model(): string {
    return this.modelName;
  }

  dimensions(): number {
    return KNOWN_DIMENSIONS[this.modelName] ?? 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Try persistent server first
    if (await this.isServerRunning()) {
      return this.embedViaServer(texts);
    }

    // Fallback to spawning Python
    if (this.scriptPath) {
      return this.embedViaSpawn(texts);
    }

    throw new Error(
      `Embed server not running at ${this.serverUrl} and no scriptPath configured for fallback`
    );
  }

  private async isServerRunning(): Promise<boolean> {
    const now = Date.now();
    const interval = this.serverAvailable
      ? SERVER_CHECK_INTERVAL_SUCCESS
      : SERVER_CHECK_INTERVAL_FAILURE;

    if (this.serverAvailable !== null && now - this.serverLastCheck < interval) {
      return this.serverAvailable;
    }

    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(500),
      });
      this.serverAvailable = response.ok;
    } catch {
      this.serverAvailable = false;
    }
    this.serverLastCheck = now;
    return this.serverAvailable;
  }

  private async embedViaServer(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.serverUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embed server error: ${error}`);
    }

    const result = (await response.json()) as EmbeddingResponse;
    return result.embeddings;
  }

  private embedViaSpawn(texts: string[]): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      const python = spawn('python3', [this.scriptPath!]);

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          try {
            const errorObj = JSON.parse(stderr);
            reject(new Error(errorObj.error));
          } catch {
            reject(new Error(`Embedding failed (code ${code}): ${stderr || 'Unknown error'}`));
          }
          return;
        }

        try {
          const result = JSON.parse(stdout) as EmbeddingResponse;
          resolve(result.embeddings);
        } catch {
          reject(new Error(`Failed to parse embedding result: ${stdout}`));
        }
      });

      python.on('error', (err) => {
        reject(new Error(`Failed to spawn Python: ${err.message}`));
      });

      // Absorb EPIPE errors (child may exit before stdin is consumed)
      python.stdin.on('error', () => {});

      const input = JSON.stringify({ texts, model: this.modelName });
      python.stdin.write(input);
      python.stdin.end();
    });
  }
}
