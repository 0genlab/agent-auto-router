function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function normalizeUsage(raw = {}) {
  const usage = raw.usage || raw;
  const inputTokens = numeric(usage.input_tokens ?? usage.prompt_tokens ?? usage.input);
  const outputTokens = numeric(usage.output_tokens ?? usage.completion_tokens ?? usage.output);
  const cacheReadTokens = numeric(usage.cache_read_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = numeric(usage.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens);
  const totalTokens = numeric(usage.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return {
    api_calls: numeric(usage.api_calls),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd: numeric(usage.cost_usd ?? usage.estimated_cost_usd)
  };
}

export function calculateCostUsd(usage, { inputPricePerMillion = null, outputPricePerMillion = null } = {}) {
  const normalized = normalizeUsage(usage);
  if (normalized.cost_usd !== null) return normalized.cost_usd;
  if (normalized.input_tokens === null || normalized.output_tokens === null) return null;
  if (!Number.isFinite(inputPricePerMillion) || !Number.isFinite(outputPricePerMillion)) return null;
  return (normalized.input_tokens * inputPricePerMillion + normalized.output_tokens * outputPricePerMillion) / 1_000_000;
}
