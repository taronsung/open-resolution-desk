// webmcp.js - offers the page's operations to browser agents through WebMCP
// (document.modelContext.registerTool), when the browser supports it. The tools
// call the same page methods as the buttons and the built-in assistant, and the
// page still asks the visitor before contacting another site or recording a step
// that cannot be undone. Without WebMCP support this module does nothing.

/**
 * Register tools with the browser's model context, if there is one.
 *
 * :param tools: [{name, description, inputSchema, annotations, run}] where run
 *   returns plain data.
 * :return: The number of tools registered.
 */
export async function exposeWebMcpTools(tools) {
  const context = (typeof document !== "undefined" && document.modelContext)
    || (typeof navigator !== "undefined" && navigator.modelContext);
  if (!context || typeof context.registerTool !== "function") return 0;
  let count = 0;
  for (const tool of tools) {
    try {
      await context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations || {},
        execute: async (args) => JSON.stringify(await tool.run(args || {})),
      });
      count += 1;
    } catch (error) {
      console.warn(`WebMCP: could not register ${tool.name}`, error);
    }
  }
  return count;
}
