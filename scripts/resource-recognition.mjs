#!/usr/bin/env node
import {
  classifyResource,
  normalizeContextName,
  sanitizeFileName,
  suggestSavedName
} from "./cloud-save-common.mjs";

/**
 * Resolve all naming inputs once. Provider adapters must pass the same canonical
 * context to this module rather than applying provider-specific normalization.
 */
function resolveResourceContext({
  contextName = "",
  shareTitle = "",
  resourceType = "auto",
  items = []
} = {}) {
  const normalizedShareTitle = normalizeContextName(shareTitle);
  const canonicalName = normalizeContextName(contextName || normalizedShareTitle);
  const classification = classifyResource({
    resourceType,
    contextName: canonicalName,
    shareTitle: normalizedShareTitle,
    items
  });
  return {
    canonicalName,
    shareTitle: normalizedShareTitle,
    resourceType: classification.type,
    classification
  };
}

/**
 * Generate a provider-neutral rename plan. No provider IDs or paths are
 * included here; adapters map itemIndex to their own copied-file identifiers.
 */
function buildResourceRenamePlan({
  resourceType = "auto",
  contextName = "",
  shareTitle = "",
  selectedItems = []
} = {}) {
  const context = resolveResourceContext({
    resourceType,
    contextName,
    shareTitle,
    items: selectedItems
  });
  const baseName = sanitizeFileName(context.canonicalName);
  if (!baseName) return [];

  return selectedItems.flatMap((item, itemIndex) => {
    const suggestedName = suggestSavedName({
      baseName,
      item,
      selectedCount: selectedItems.length,
      isSeries: context.classification.isSeries
    });
    if (!suggestedName || suggestedName === item.name) return [];
    return [{
      itemIndex,
      rank: Number(item.rank || itemIndex + 1),
      originalName: item.name,
      suggestedName,
      reason: context.classification.isSeries
        ? "按统一资源识别规则修正剧集文件名"
        : "按统一资源识别规则修正保存名称"
    }];
  });
}

/**
 * Validate Agent decisions against the selected list and return the same
 * provider-neutral shape as buildResourceRenamePlan.
 */
function resolveAgentRenamePlan({
  selectedItems = [],
  agentRenamePlan = []
} = {}) {
  if (!Array.isArray(agentRenamePlan)) {
    throw new Error("Agent rename plan must be a JSON array");
  }
  const seen = new Set();
  const plan = [];
  for (const decision of agentRenamePlan) {
    const rank = Number(decision?.rank ?? decision?.index);
    if (!Number.isInteger(rank) || rank < 1) {
      throw new Error("Agent rename plan item is missing a valid rank/index");
    }
    if (seen.has(rank)) {
      throw new Error(`Agent rename plan contains duplicate rank/index: ${rank}`);
    }
    seen.add(rank);
    const selectedIndex = selectedItems.findIndex((item) => Number(item.rank) === rank);
    const itemIndex = selectedIndex >= 0 ? selectedIndex : (selectedItems[rank - 1] ? rank - 1 : -1);
    if (itemIndex < 0) {
      throw new Error(`Agent rename plan rank is not selected: ${rank}`);
    }
    const item = selectedItems[itemIndex];
    const suggestedName = sanitizeFileName(decision.name || decision.suggestedName || "");
    if (!suggestedName) {
      throw new Error(`Agent rename plan item is missing name/suggestedName: ${rank}`);
    }
    if (suggestedName === item.name) continue;
    plan.push({
      itemIndex,
      rank,
      originalName: item.name,
      suggestedName,
      reason: decision.reason || "Agent 指定重命名"
    });
  }
  return plan;
}

export {
  buildResourceRenamePlan,
  resolveAgentRenamePlan,
  resolveResourceContext
};
