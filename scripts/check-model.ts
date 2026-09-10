/** Check the configured LiteLLM key/model without a database or source document. */
import { callLiteLLM, getLiteLLMConfig } from "../lib/litellm";

async function main() {
  const config = getLiteLLMConfig();
  console.log(`Requested model: ${config.model}`);

  // One small real request verifies model access, not just key syntax.
  const result = await callLiteLLM(
    "This is a connection test. Reply with exactly OK.",
    "Confirm the connection.",
    config
  );
  if (!result.content || !result.model) {
    throw new Error("Incomplete response");
  }

  console.log("Connection successful.");
  console.log(`Returned model: ${result.model}`);
  console.log(
    `Tokens: ${result.promptTokens} input, ${result.completionTokens} output`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const status = /^LiteLLM error (\d+):/.exec(message)?.[1];

  // Provider error bodies can contain credentials; never print them here.
  if (message.startsWith("Missing env var:")) {
    console.error(`${message}. Fill it in .env.local and try again.`);
  } else if (status) {
    console.error(`Connection failed (HTTP ${status}).`);
    console.error(
      "Check the proxy URL, API key, allowed model ID, and available quota."
    );
  } else {
    console.error(
      "Connection failed or the proxy returned an incomplete response. Check the proxy URL and network access."
    );
  }
  process.exitCode = 1;
});
