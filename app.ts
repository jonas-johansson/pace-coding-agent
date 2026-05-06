import Anthropic from "@anthropic-ai/sdk"
import { getUserInput } from "./input"

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];

async function main() {
  console.log("READY");
  while (true) {
    // User
    const input = await getUserInput("User: ");
    messages.push({ role: "user", content: [ { type: "text", text: input } ]});
    // Assistant
    const response = await ant.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1000,
      messages,
    });
    messages.push({ role: "assistant", content: response.content })
    if (response.content.length > 0 && response.content[0].type === "text") {
      console.log(response.content[0].text);
    }
  }
}

main();
