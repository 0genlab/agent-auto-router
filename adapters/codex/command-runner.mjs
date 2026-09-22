import { spawn } from "node:child_process";
import fs from "node:fs";
import { calculateCostUsd, normalizeUsage } from "../../src/core/usage-cost.mjs";
import { findModelPrice } from "../../src/core/model-pricing.mjs";

export function runRecordedCommand({ cli, command, args = [], cwd, role, model, startArgs = [], recordArgs = [], usageFile = null, priceSnapshot = null, inputPricePerMillion = null, outputPricePerMillion = null }) {
  const modelPrice = findModelPrice(priceSnapshot, model);
  const resolvedInputPrice = inputPricePerMillion ?? modelPrice?.input_price_per_million;
  const resolvedOutputPrice = outputPricePerMillion ?? modelPrice?.output_price_per_million;
  const runId = cli.start(startArgs);
  const startedAt = Date.now();
  const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });

  return new Promise((resolve, reject) => {
    const usageArgs = () => {
      if (!usageFile || !fs.existsSync(usageFile)) return [];
      const usage = normalizeUsage(JSON.parse(fs.readFileSync(usageFile, "utf8")));
      const cost = calculateCostUsd(usage, { inputPricePerMillion: resolvedInputPrice, outputPricePerMillion: resolvedOutputPrice });
      return [
        "--input-tokens", String(usage.input_tokens ?? ""),
        "--output-tokens", String(usage.output_tokens ?? ""),
        "--total-tokens", String(usage.total_tokens ?? ""),
        "--cost-usd", String(cost ?? "")
      ];
    };
    child.once("error", (error) => {
      try {
        cli.record([
          "--run-id", runId,
          "--role", role,
          "--model", model,
          "--status", "failed",
          "--latency-ms", String(Date.now() - startedAt),
          "--note", error.message,
          ...usageArgs(),
          ...recordArgs
        ]);
      } catch (recordError) {
        reject(recordError);
        return;
      }
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      const status = exitCode === 0 ? "success" : "failed";
      cli.record([
        "--run-id", runId,
        "--role", role,
        "--model", model,
        "--status", status,
        "--latency-ms", String(Date.now() - startedAt),
        "--note", signal ? `terminated by ${signal}` : `exit code ${exitCode}`,
        ...usageArgs(),
        ...recordArgs
      ]);
      resolve({ runId, exitCode, signal, status });
    });
  });
}
