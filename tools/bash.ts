import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { spawn } from "child_process";
import { z } from "zod";
import { defineTool, isAbortError, throwIfAborted, type ToolOutput } from "./core";
import {
  TOOL_OUTPUT_TRUNCATION_BYTES,
  TOOL_OUTPUT_TRUNCATION_HEAD_BYTES,
  TOOL_OUTPUT_TRUNCATION_TAIL_BYTES,
  buildTruncatedToolOutputFromParts,
  createToolOutputPath,
  finishWriteStream,
  shouldPersistLargeToolOutput,
  truncateUtf8Prefix,
  truncateUtf8Suffix,
} from "./output";

const BASH_DEFAULT_TIMEOUT = 10_000;

export const bashTool = defineTool({
  name: "bash",
  description: "Execute a bash command in the current working directory.",
  concurrency: "exclusive",
  inputSchema: z.object({
    command: z.string(),
  }),
  titleFormatter: (input) => `bash: ${input.command ?? ""}`,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const timeoutMs = (BASH_DEFAULT_TIMEOUT / 1000) * 1000;
    try {
      // Use spawn with detached: true so the shell and all its children
      // form their own process group. This lets us kill the entire tree
      // (e.g. "sleep 15") instantly via process.kill(-pid, SIGTERM)
      // instead of only killing the wrapper shell.
      const child = spawn("/bin/sh", ["-c", input.command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const shouldPersistLargeOutput = shouldPersistLargeToolOutput();
      const fullOutputPath = shouldPersistLargeOutput ? await createToolOutputPath("bash") : undefined;
      const fullOutputStream = fullOutputPath ? createWriteStream(fullOutputPath, { encoding: "utf8" }) : undefined;
      let stdout = "";
      let stderr = "";
      let previewHead = "";
      let previewTail = "";
      let outputBytes = 0;
      let killed = false;
      let killSignal: string | null = null;

      const captureChunk = (chunk: string, streamName: "stdout" | "stderr") => {
        fullOutputStream?.write(chunk);
        outputBytes += Buffer.byteLength(chunk, "utf8");

        if (shouldPersistLargeOutput) {
          previewHead = truncateUtf8Prefix(previewHead + chunk, TOOL_OUTPUT_TRUNCATION_HEAD_BYTES);
          previewTail = truncateUtf8Suffix(previewTail + chunk, TOOL_OUTPUT_TRUNCATION_TAIL_BYTES);
        }

        if (!shouldPersistLargeOutput || outputBytes <= TOOL_OUTPUT_TRUNCATION_BYTES) {
          if (streamName === "stdout") stdout += chunk;
          else stderr += chunk;
        }
      };

      child.stdout.on("data", (data: Buffer) => {
        captureChunk(data.toString("utf8"), "stdout");
      });

      child.stderr.on("data", (data: Buffer) => {
        captureChunk(data.toString("utf8"), "stderr");
      });

      // Kill the entire process group so children are also terminated
      const killTree = () => {
        killed = true;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch {}
        }
        child.kill("SIGTERM");
      };

      // Set up timeout
      const timer = setTimeout(() => {
        killSignal = "SIGTERM";
        killTree();
      }, timeoutMs);

      // Set up abort signal
      if (signal) {
        const onAbort = () => { killTree(); };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("exit", () => signal.removeEventListener("abort", onAbort));
      }

      // Wait for the process to exit
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode) => resolve(exitCode));
      });

      clearTimeout(timer);
      if (fullOutputStream) {
        await finishWriteStream(fullOutputStream);
      }

      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const outputWasTruncated = shouldPersistLargeOutput && outputBytes > TOOL_OUTPUT_TRUNCATION_BYTES;
      if (fullOutputPath && !outputWasTruncated) {
        await unlink(fullOutputPath).catch(() => undefined);
      }

      const bashOutput = outputWasTruncated && fullOutputPath
        ? buildTruncatedToolOutputFromParts(previewHead, previewTail, outputBytes, fullOutputPath)
        : [stdout, stderr].filter(Boolean).join("\n");

      if (killed && killSignal === "SIGTERM") {
        const message = bashOutput
          ? `Command timed out after ${Math.floor(timeoutMs / 1000)} seconds. Partial output:\n${bashOutput}`
          : `Command timed out after ${Math.floor(timeoutMs / 1000)} seconds.`;
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          is_error: true,
        };
      }

      if (code !== 0 && code !== null) {
        const message = [bashOutput, `Command exited with code ${code}`].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
        };
      }

      return {
        content: [{ type: "text", text: bashOutput }]
      };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
      };
    }
  }
})
