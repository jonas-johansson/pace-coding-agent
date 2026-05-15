import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolDefinition } from "../provider";
import { formatSkillsForToolDescription } from "../skill";
import { registerTool, tools, type ToolDescriptor } from "./core";
import { readTool, writeTool, editTool } from "./files";
import { bashTool } from "./bash";
import { scriptTool } from "./script";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";
import { skillTool, setCurrentSkills, getCurrentSkills } from "./skill";

const builtInTools: ToolDescriptor[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  scriptTool,
  webFetchTool,
  webSearchTool,
  skillTool,
];

builtInTools.forEach(registerTool);

export * from "./core";
export { truncateToolOutputIfNeeded } from "./output";
export { setCurrentSkills };

function makeAnthropicToolsFromCustomTools() {
  let transformedTools: Anthropic.Tool[] = [];
  for (let i = 0; i < tools.length; i++) {
    transformedTools.push({
      name: tools[i].name,
      description: tools[i].description,
      input_schema: z.toJSONSchema(tools[i].inputSchema) as Anthropic.Tool["input_schema"],
    });
  }
  return transformedTools;
}

export const toolsTransformedToAnthropicStyle: Anthropic.Tool[] = makeAnthropicToolsFromCustomTools();

/**
 * Provider-agnostic tool definitions. Used by the provider abstraction layer
 * so each provider can serialise tools into its own API format.
 *
 * The skill tool's description is dynamically augmented with the current
 * skill listing so the model can see available skills in the tool schema.
 */
export function getProviderToolDefinitions(): ToolDefinition[] {
  const currentSkills = getCurrentSkills();

  return tools.map((t) => {
    let description = t.description;

    // Dynamically append skill listing to the skill tool
    if (t.name === "skill" && currentSkills.length > 0) {
      const listing = formatSkillsForToolDescription(currentSkills);
      if (listing) {
        description = `${description}\n\nAvailable skills:\n${listing}`;
      }
    }

    return {
      name: t.name,
      description,
      inputSchema: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
    };
  });
}
