/**
 * Stable default order for resource-provider candidates.
 * Explicit source URLs are never rerouted; this helper only orders search results.
 */
const CLOUD_PROVIDER_PRIORITY = Object.freeze(["aliyun", "quark", "baidu"]);
const PRIORITY_INDEX = new Map(CLOUD_PROVIDER_PRIORITY.map((provider, index) => [provider, index]));

function providerPriority(provider) {
  return PRIORITY_INDEX.get(String(provider || "").trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

function sortCloudLinksByPriority(links = []) {
  return links
    .map((link, index) => ({ link, index }))
    .sort((a, b) => providerPriority(a.link?.diskType ?? a.link?.provider) - providerPriority(b.link?.diskType ?? b.link?.provider) || a.index - b.index)
    .map(({ link }) => link);
}

function orderAvailableProviders(providers = []) {
  const unique = [...new Set(providers.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
  return unique.sort((a, b) => providerPriority(a) - providerPriority(b));
}

function resolveProviderForShareUrl(url, requestedProvider = "") {
  const explicit = String(requestedProvider || "").trim().toLowerCase();
  if (explicit) return explicit;
  const value = String(url || "");
  if (/aliyundrive\.com|alipan\.com/i.test(value)) return "aliyun";
  if (/pan\.quark\.cn/i.test(value)) return "quark";
  if (/pan\.baidu\.com/i.test(value)) return "baidu";
  return "";
}

export {
  CLOUD_PROVIDER_PRIORITY,
  orderAvailableProviders,
  providerPriority,
  resolveProviderForShareUrl,
  sortCloudLinksByPriority
};
