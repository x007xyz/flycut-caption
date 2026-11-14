#!/usr/bin/env node
import { createMcpStdioServer } from './protocol';
import { createFlycutMcpTools } from './tools';

declare const __FLYCUT_MCP_VERSION__: string | undefined;
const MCP_VERSION = typeof __FLYCUT_MCP_VERSION__ === 'string' ? __FLYCUT_MCP_VERSION__ : '2.0.2';

const HELP_TEXT = `FlyCut Caption MCP Server (stdio JSON-RPC 2.0)

Usage:
  flycut-mcp [options]

Options:
  --host <url>         FlyCut Host URL (or FLYCUT_HOST_URL)
  --token <token>      FlyCut Host Bearer token (or FLYCUT_HOST_TOKEN)
  --token-file <path>  File containing Host Bearer token
  --home <dir>         Host home directory (default ~/.flycut-caption/host)
  -h, --help           Show help
  -v, --version        Show version
`;

function parseArgs(argv: string[]) {
  let host: string | undefined;
  let token: string | undefined;
  let tokenFile: string | undefined;
  let home: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { help = true; continue; }
    if (arg === '-v' || arg === '--version') { version = true; continue; }
    if (arg.startsWith('--host=')) { host = arg.slice('--host='.length); continue; }
    if (arg === '--host') { host = argv[++i]; continue; }
    if (arg.startsWith('--token=')) { token = arg.slice('--token='.length); continue; }
    if (arg === '--token') { token = argv[++i]; continue; }
    if (arg.startsWith('--token-file=')) { tokenFile = arg.slice('--token-file='.length); continue; }
    if (arg === '--token-file') { tokenFile = argv[++i]; continue; }
    if (arg.startsWith('--home=')) { home = arg.slice('--home='.length); continue; }
    if (arg === '--home') { home = argv[++i]; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { host, token, tokenFile, home, help, version };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write(`${MCP_VERSION}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const { tools, resources } = createFlycutMcpTools({
    host: args.host,
    token: args.token,
    tokenFile: args.tokenFile,
    home: args.home,
    version: MCP_VERSION,
  });

  const server = createMcpStdioServer({
    name: 'flycut-caption',
    version: MCP_VERSION,
    instructions: [
      'FlyCut Caption MCP server exposes project, media, transcription, review-only edit suggestions, export, and job tools.',
      'Edit suggestions never modify formal subtitles, EDL, or exports until confirmed by the user in the FlyCut UI.',
      'Destructive actions (trash/purge project, remove video, overwrite existing file) create client confirmation requests that only the FlyCut UI user can approve.',
    ].join(' '),
    tools,
    resources,
  });

  if (args.token) server.registerSecret(args.token);
  if (process.env.FLYCUT_HOST_TOKEN) server.registerSecret(process.env.FLYCUT_HOST_TOKEN);

  await server.run();
  return 0;
}

const code = await main().catch(error => {
  process.stderr.write(`[flycut-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
process.exit(code);

