import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..', '..');

function safeReadFile(path: string): string {
  try {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  } catch {
    // ignore read errors
  }
  return `File not found: ${path}`;
}

export function registerResources(server: McpServer): void {
  server.resource(
    'api-documentation',
    'orion://api-docs',
    {
      description: 'Complete Orion API documentation covering all 20 modules, REST endpoints, and Edge Functions',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: 'orion://api-docs',
          mimeType: 'text/markdown',
          text: safeReadFile(resolve(projectRoot, 'postman', 'API_DOCUMENTATION.md')),
        },
      ],
    }),
  );

  server.resource(
    'postman-environment',
    'orion://postman-environment',
    {
      description: 'Postman environment variables for Orion API',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'orion://postman-environment',
          mimeType: 'application/json',
          text: safeReadFile(resolve(projectRoot, 'postman', 'orion.postman_environment.json')),
        },
      ],
    }),
  );

  server.resource(
    'postman-collection',
    'orion://postman-collection',
    {
      description: 'Postman collection with all Orion API requests',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'orion://postman-collection',
          mimeType: 'application/json',
          text: safeReadFile(resolve(projectRoot, 'postman', 'orion.postman_collection.json')),
        },
      ],
    }),
  );
}
