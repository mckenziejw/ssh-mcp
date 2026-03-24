import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { readFileSync } from "node:fs";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ConnectionState {
  client: Client | null;
  sftp: SFTPWrapper | null;
  connecting: Promise<Client> | null;
  sftpConnecting: Promise<SFTPWrapper> | null;
}

const state: ConnectionState = {
  client: null,
  sftp: null,
  connecting: null,
  sftpConnecting: null,
};

const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB per stream

function getConnectConfig(): ConnectConfig {
  const host = process.env.SSH_HOST;
  if (!host) {
    throw new Error("SSH_HOST environment variable is required");
  }

  const port = parseInt(process.env.SSH_PORT || "22", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SSH_PORT: ${process.env.SSH_PORT}`);
  }

  const config: ConnectConfig = {
    host,
    port,
    username: process.env.SSH_USERNAME || process.env.USER || "root",
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };

  if (process.env.SSH_PRIVATE_KEY_PATH) {
    config.privateKey = readFileSync(process.env.SSH_PRIVATE_KEY_PATH);
    if (process.env.SSH_PASSPHRASE) {
      config.passphrase = process.env.SSH_PASSPHRASE;
    }
  } else if (process.env.SSH_PASSWORD) {
    config.password = process.env.SSH_PASSWORD;
  } else if (process.env.SSH_AUTH_SOCK || process.env.SSH_AGENT_SOCKET) {
    config.agent = process.env.SSH_AGENT_SOCKET || process.env.SSH_AUTH_SOCK;
  }

  return config;
}

export async function getConnection(): Promise<Client> {
  if (state.client) {
    return state.client;
  }

  if (state.connecting) {
    return state.connecting;
  }

  state.connecting = new Promise<Client>((resolve, reject) => {
    const client = new Client();

    client.on("ready", () => {
      state.client = client;
      state.connecting = null;
      resolve(client);
    });

    client.on("error", (err) => {
      // Only clear state if this is still the active client
      if (state.client === client || state.client === null) {
        state.client = null;
        state.sftp = null;
        state.connecting = null;
        state.sftpConnecting = null;
      }
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    client.on("close", () => {
      // Only clear state if this is still the active client
      if (state.client === client) {
        state.client = null;
        state.sftp = null;
        state.sftpConnecting = null;
      }
    });

    client.connect(getConnectConfig());
  });

  return state.connecting;
}

export async function getSftp(): Promise<SFTPWrapper> {
  if (state.sftp) {
    return state.sftp;
  }

  if (state.sftpConnecting) {
    return state.sftpConnecting;
  }

  // Assign the promise synchronously before any await to prevent
  // concurrent callers from creating duplicate SFTP sessions
  state.sftpConnecting = (async () => {
    const client = await getConnection();
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          state.sftpConnecting = null;
          reject(new Error(`SFTP session error: ${err.message}`));
          return;
        }
        state.sftp = sftp;
        state.sftpConnecting = null;
        resolve(sftp);
      });
    });
  })();

  return state.sftpConnecting;
}

export async function execCommand(
  command: string,
  options?: { cwd?: string; timeout?: number },
): Promise<ExecResult> {
  const client = await getConnection();
  const timeout = options?.timeout ?? 30000;

  const fullCommand = options?.cwd
    ? `cd ${shellQuote(options.cwd)} && ${command}`
    : command;

  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(fullCommand, (err, stream) => {
      if (err) {
        reject(new Error(`Command execution error: ${err.message}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let exitCode: number | null = null;
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          stream.close();
          resolve({
            stdout,
            stderr: stderr + "\n[Command timed out]",
            exitCode: -1,
          });
        }
      }, timeout);

      stream.on("data", (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += data.toString();
          if (stdout.length > MAX_OUTPUT) {
            stdout = stdout.slice(0, MAX_OUTPUT);
            stdoutTruncated = true;
          }
        }
      });

      stream.stderr.on("data", (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT) {
          stderr += data.toString();
          if (stderr.length > MAX_OUTPUT) {
            stderr = stderr.slice(0, MAX_OUTPUT);
            stderrTruncated = true;
          }
        }
      });

      // Exit code comes via the 'exit' event, not 'close'
      stream.on("exit", (code: number | null, signal?: string) => {
        exitCode = code;
        if (signal) {
          stderr += `\n[Process killed by signal: ${signal}]`;
        }
      });

      stream.on("close", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (stdoutTruncated) {
            stdout += "\n[Output truncated at 10MB]";
          }
          if (stderrTruncated) {
            stderr += "\n[Stderr truncated at 10MB]";
          }
          resolve({
            stdout,
            stderr,
            exitCode: exitCode ?? -1,
          });
        }
      });

      stream.on("error", (err: Error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`Stream error: ${err.message}`));
        }
      });
    });
  });
}

export async function disconnect(): Promise<void> {
  const client = state.client;
  state.client = null;
  state.sftp = null;
  state.connecting = null;
  state.sftpConnecting = null;
  if (client) {
    client.end();
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
