#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execCommand, getSftp, disconnect, shellQuote } from "./ssh.js";

const server = new McpServer({
  name: "ssh-mcp",
  version: "1.0.0",
});

// --- ssh_execute ---
server.tool(
  "ssh_execute",
  "Execute a shell command on the remote SSH host",
  {
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory for the command"),
    timeout: z
      .number()
      .optional()
      .default(30000)
      .describe("Timeout in milliseconds (default 30000)"),
  },
  async ({ command, cwd, timeout }) => {
    try {
      const result = await execCommand(command, { cwd, timeout });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: result.exitCode !== 0,
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- ssh_read_file ---
server.tool(
  "ssh_read_file",
  "Read the contents of a file on the remote host",
  {
    path: z.string().describe("Absolute path to the file"),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe("Byte offset to start reading from"),
    limit: z
      .number()
      .min(1)
      .optional()
      .describe("Maximum number of bytes to read"),
  },
  async ({ path, offset, limit }) => {
    try {
      const sftp = await getSftp();
      const maxSize = 1024 * 1024; // 1MB

      // Check file size first
      const stats = await sftpStat(sftp, path);

      // Handle zero-size files (including special files like /proc/*)
      if (stats.size === 0) {
        // Try reading anyway — special files report size 0 but have content
        // Cap at maxSize to prevent OOM on files like /proc/kcore
        const content = await readStreamToString(sftp, path, { end: maxSize - 1 });
        return {
          content: [{ type: "text" as const, text: content }],
        };
      }

      const start = offset ?? 0;

      // Validate offset is within file bounds
      if (start >= stats.size) {
        return {
          content: [
            {
              type: "text" as const,
              text: `[Offset ${start} is past end of file (${stats.size} bytes)]`,
            },
          ],
        };
      }

      // Clamp limit to maxSize to prevent OOM
      const effectiveLimit = limit
        ? Math.min(limit, maxSize)
        : maxSize;
      const end = Math.min(start + effectiveLimit - 1, stats.size - 1);

      const content = await readStreamToString(sftp, path, { start, end });

      let text = content;
      if (
        stats.size > end - start + 1 &&
        !content.startsWith("[Binary")
      ) {
        text += `\n\n[Showing bytes ${start}-${end} of ${stats.size} total]`;
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- ssh_write_file ---
server.tool(
  "ssh_write_file",
  "Write content to a file on the remote host",
  {
    path: z.string().describe("Absolute path for the file"),
    content: z.string().describe("Content to write"),
    mode: z
      .enum(["overwrite", "append"])
      .optional()
      .default("overwrite")
      .describe("Write mode: 'overwrite' or 'append'"),
    createDirectories: z
      .boolean()
      .optional()
      .default(false)
      .describe("Create parent directories if they don't exist"),
  },
  async ({ path, content, mode, createDirectories }) => {
    try {
      if (createDirectories) {
        const dir = path.substring(0, path.lastIndexOf("/"));
        if (dir) {
          await execCommand(`mkdir -p ${shellQuote(dir)}`);
        }
      }

      const sftp = await getSftp();
      const flags = mode === "append" ? "a" : "w";

      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(path, { flags });
        let settled = false;
        stream.on("error", (err: Error) => {
          if (!settled) {
            settled = true;
            reject(new Error(`Write error: ${err.message}`));
          }
          stream.destroy();
        });
        stream.on("finish", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        stream.on("close", () => {
          if (!settled) {
            settled = true;
            reject(new Error("Write stream closed unexpectedly"));
          }
        });
        stream.end(content, "utf-8");
      });

      const stats = await sftpStat(sftp, path);

      return {
        content: [
          {
            type: "text" as const,
            text: `File written: ${path} (${stats.size} bytes)`,
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- ssh_list_directory ---
server.tool(
  "ssh_list_directory",
  "List contents of a directory on the remote host",
  {
    path: z.string().describe("Absolute path to the directory"),
    showHidden: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include hidden files (starting with '.')"),
  },
  async ({ path, showHidden }) => {
    try {
      const sftp = await getSftp();

      const entries = await new Promise<
        Array<{
          filename: string;
          longname: string;
          attrs: { size: number; mode: number; mtime: number };
        }>
      >((resolve, reject) => {
        sftp.readdir(path, (err, list) => {
          if (err)
            reject(new Error(`Cannot read directory: ${err.message}`));
          else resolve(list as any);
        });
      });

      const filtered = showHidden
        ? entries
        : entries.filter((e) => !e.filename.startsWith("."));

      filtered.sort((a, b) => a.filename.localeCompare(b.filename));

      // Cap output to prevent huge directory listings from blowing up context
      const maxEntries = 10000;
      const truncated = filtered.length > maxEntries;
      const display = truncated ? filtered.slice(0, maxEntries) : filtered;

      const lines = display.map((entry) => {
        const isDir = (entry.attrs.mode & 0o170000) === 0o040000;
        const isLink = (entry.attrs.mode & 0o170000) === 0o120000;
        const type = isDir ? "dir" : isLink ? "link" : "file";
        const size = isDir ? "-" : formatSize(entry.attrs.size);
        const modified = new Date(entry.attrs.mtime * 1000).toISOString();
        return `${type.padEnd(5)} ${size.padStart(10)}  ${modified}  ${entry.filename}`;
      });

      let header = `${filtered.length} entries in ${path}\n${"type".padEnd(5)} ${"size".padStart(10)}  ${"modified".padEnd(24)}  name`;
      let result = header + "\n" + lines.join("\n");
      if (truncated) {
        result += `\n\n[Showing first ${maxEntries} of ${filtered.length} entries]`;
      }

      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- ssh_file_info ---
server.tool(
  "ssh_file_info",
  "Get metadata about a file or directory on the remote host",
  {
    path: z.string().describe("Absolute path to check"),
  },
  async ({ path }) => {
    try {
      const sftp = await getSftp();

      const stats = await new Promise<any>((resolve, reject) => {
        sftp.lstat(path, (err, stats) => {
          if (err) {
            // Check for "no such file" — SFTP status code 2
            const code = (err as any).code;
            if (code === 2 || code === "ENOENT") {
              resolve(null);
            } else {
              reject(new Error(`Stat error: ${err.message}`));
            }
          } else {
            resolve(stats);
          }
        });
      });

      if (!stats) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ exists: false, path }, null, 2),
            },
          ],
        };
      }

      const modeNum = stats.mode & 0o170000;
      let fileType = "file";
      if (modeNum === 0o040000) fileType = "directory";
      else if (modeNum === 0o120000) fileType = "symlink";
      else if (modeNum === 0o060000) fileType = "block-device";
      else if (modeNum === 0o020000) fileType = "char-device";
      else if (modeNum === 0o010000) fileType = "fifo";
      else if (modeNum === 0o140000) fileType = "socket";

      const info = {
        exists: true,
        path,
        type: fileType,
        size: stats.size,
        permissions: "0" + (stats.mode & 0o7777).toString(8),
        uid: stats.uid,
        gid: stats.gid,
        modifiedAt: new Date(stats.mtime * 1000).toISOString(),
        accessedAt: new Date(stats.atime * 1000).toISOString(),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- ssh_directory_create ---
server.tool(
  "ssh_directory_create",
  "Create a directory on the remote host",
  {
    path: z.string().describe("Absolute path to create"),
    recursive: z
      .boolean()
      .optional()
      .default(true)
      .describe("Create parent directories if needed"),
  },
  async ({ path, recursive }) => {
    try {
      if (recursive) {
        const result = await execCommand(`mkdir -p ${shellQuote(path)}`);
        if (result.exitCode !== 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to create directory: ${result.stderr}`,
              },
            ],
            isError: true,
          };
        }
      } else {
        const sftp = await getSftp();
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(path, (err) => {
            if (err) reject(new Error(`mkdir error: ${err.message}`));
            else resolve();
          });
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory created: ${path}`,
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- ssh_file_delete ---
server.tool(
  "ssh_file_delete",
  "Delete a file or directory on the remote host",
  {
    path: z.string().describe("Absolute path to delete"),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe("For directories, delete recursively"),
  },
  async ({ path, recursive }) => {
    try {
      if (recursive) {
        const result = await execCommand(`rm -rf ${shellQuote(path)}`);
        if (result.exitCode !== 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to delete: ${result.stderr}`,
              },
            ],
            isError: true,
          };
        }
      } else {
        const sftp = await getSftp();

        // Try unlink first (works for files and symlinks), fall back to rmdir
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(path, (unlinkErr) => {
            if (!unlinkErr) {
              resolve();
              return;
            }
            // If unlink failed, try rmdir (for empty directories)
            sftp.rmdir(path, (rmdirErr) => {
              if (rmdirErr) {
                reject(
                  new Error(
                    `Delete failed: unlink: ${unlinkErr.message}, rmdir: ${rmdirErr.message}`,
                  ),
                );
              } else {
                resolve();
              }
            });
          });
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted: ${path}`,
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Helpers ---

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function sftpStat(
  sftp: Awaited<ReturnType<typeof getSftp>>,
  path: string,
): Promise<{ size: number; mode: number; mtime: number; atime: number; uid: number; gid: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(new Error(`Cannot stat file: ${err.message}`));
      else resolve(stats as any);
    });
  });
}

function readStreamToString(
  sftp: Awaited<ReturnType<typeof getSftp>>,
  path: string,
  opts: { start?: number; end?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path, opts);
    let settled = false;

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on("end", () => {
      if (settled) return;
      settled = true;
      const buffer = Buffer.concat(chunks);
      // Check for binary content (null bytes)
      if (buffer.includes(0)) {
        resolve(
          `[Binary file. Use ssh_execute with tools like xxd, base64, or file to inspect.]`,
        );
      } else {
        resolve(buffer.toString("utf-8"));
      }
    });

    stream.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error(`Read error: ${err.message}`));
    });

    stream.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Read stream closed unexpectedly before completing"));
      }
    });
  });
}

// --- Start server ---

async function main() {
  process.on("SIGINT", () => {
    disconnect().catch(() => {}).finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    disconnect().catch(() => {}).finally(() => process.exit(0));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
