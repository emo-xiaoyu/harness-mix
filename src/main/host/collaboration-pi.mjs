import catalog from './collaboration-tools.js';
import transport from './collaboration-mcp.cjs';

// Pi's native extension surface, with the same schemas and Host transport as MCP.
export default function install(pi) {
  for (const tool of catalog.tools) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    async execute(_id, args) {
      try {
        const result = await transport.call(tool.name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
      } catch (error) {
        return { content: [{ type: 'text', text: `Collaboration error: ${error.message}` }], details: {}, isError: true };
      }
    },
  });
}
