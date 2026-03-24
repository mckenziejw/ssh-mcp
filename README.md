# ssh-mcp

An MCP (Model Context Protocol) server that gives AI agents access to remote systems via SSH. Designed for use with [Cline](https://github.com/cline/cline) in VSCode, but compatible with any MCP client.

The server maintains a persistent SSH connection and exposes tools for command execution, file I/O, and directory management over SFTP.

## Tools

| Tool | Description |
|------|-------------|
| `ssh_execute` | Run shell commands with optional working directory and timeout |
| `ssh_read_file` | Read file contents via SFTP (with offset/limit for large files) |
| `ssh_write_file` | Write or append to files via SFTP |
| `ssh_list_directory` | List directory contents with file type, size, and modification time |
| `ssh_file_info` | Get file metadata (type, size, permissions, ownership, timestamps) |
| `ssh_directory_create` | Create directories (recursive by default) |
| `ssh_file_delete` | Delete files or directories |

## Setup

### Build from source

```bash
git clone https://github.com/mckenziejw/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

### Configure in Cline

Add the server to your Cline MCP settings. This file is typically located at:

```
~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
```

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-remote-host",
        "SSH_PORT": "22",
        "SSH_USERNAME": "your-username",
        "SSH_PRIVATE_KEY_PATH": "/home/you/.ssh/id_ed25519"
      }
    }
  }
}
```

### Configure in Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-mcp/dist/index.js"],
      "env": {
        "SSH_HOST": "your-remote-host",
        "SSH_USERNAME": "your-username",
        "SSH_PRIVATE_KEY_PATH": "/home/you/.ssh/id_ed25519"
      }
    }
  }
}
```

## Authentication

Set **one** of the following in the `env` block:

### Private key (recommended)

```json
{
  "SSH_PRIVATE_KEY_PATH": "/home/you/.ssh/id_ed25519",
  "SSH_PASSPHRASE": "optional-key-passphrase"
}
```

### Password

```json
{
  "SSH_PASSWORD": "your-password"
}
```

### SSH agent

The server uses the `SSH_AUTH_SOCK` environment variable automatically if no key or password is configured. You can also set it explicitly:

```json
{
  "SSH_AGENT_SOCKET": "/run/user/1000/ssh-agent.socket"
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SSH_HOST` | Yes | — | Remote hostname or IP |
| `SSH_PORT` | No | `22` | SSH port |
| `SSH_USERNAME` | No | `$USER` | Remote username |
| `SSH_PRIVATE_KEY_PATH` | No | — | Path to private key file |
| `SSH_PASSPHRASE` | No | — | Passphrase for the private key |
| `SSH_PASSWORD` | No | — | Password authentication |
| `SSH_AGENT_SOCKET` | No | `$SSH_AUTH_SOCK` | Path to SSH agent socket |

## Safety Limits

- File reads are capped at **1 MB** per request (use `offset`/`limit` for larger files)
- Command stdout/stderr is capped at **10 MB** each
- Directory listings are capped at **10,000 entries**
- Commands have a default **30-second timeout** (configurable per call)
- Binary files are detected and not dumped as text

## License

MIT
