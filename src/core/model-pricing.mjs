function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function priceFromTiers(pricing, key) {
  const tiers = Array.isArray(pricing?.tiers) ? pricing.tiers : [];
  const tier = tiers
    .map((item) => ({ size: numeric(item?.tier?.size), value: numeric(item?.[key]) }))
    .filter((item) => item.size !== null && item.value !== null)
    .sort((left, right) => right.size - left.size)[0];
  return tier?.value ?? numeric(pricing?.[key]);
}

export function normalizeModelPrice(model, { provider = model?.provider || null } = {}) {
  const pricing = model?.pricing || {};
  return {
    model_id: String(model?.model_id || ""),
    model_name: String(model?.model_name || model?.model_id || ""),
    provider,
    input_price_per_million: priceFromTiers(pricing, "input"),
    output_price_per_million: priceFromTiers(pricing, "output"),
    currency: pricing.currency || "USD",
    pricing_unit: "per_million_tokens",
    retire_stage: model?.retire_stage || null,
    last_updated: model?.last_updated || null
  };
}

export function normalizeOpenRouterPrice(model) {
  const perMillion = (value) => {
    const parsed = numeric(value);
    return parsed === null ? null : parsed * 1_000_000;
  };
  return {
    model_id: String(model?.model_id || model?.id || ""),
    model_name: String(model?.model_name || model?.name || model?.id || ""),
    provider: "openrouter",
    input_price_per_million: perMillion(model?.pricing?.prompt),
    output_price_per_million: perMillion(model?.pricing?.completion),
    currency: "USD",
    pricing_unit: "per_million_tokens",
    retire_stage: null,
    last_updated: null
  };
}

export function createPriceSnapshot(models, { source = "unknown", provider = null, fetchedAt = new Date().toISOString() } = {}) {
  const entries = models
    .map((model) => model?.pricing ? normalizeModelPrice(model, { provider }) : { ...model, provider: model.provider || provider })
    .filter((model) => model.model_id)
    .reduce((result, model) => ({ ...result, [model.model_id]: model }), {});
  return {
    schema_version: 2,
    provider,
    source,
    fetched_at: fetchedAt,
    pricing_unit: "per_million_tokens",
    models: entries
  };
}

export function findModelPrice(snapshot, modelId, provider = null) {
  if (!provider) return null;
  if (provider && snapshot?.provider !== provider) return null;
  return snapshot?.models?.[modelId] || null;
}
