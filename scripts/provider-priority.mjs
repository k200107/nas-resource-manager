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

/**
 * 按优先级轮转交替排列候选，而不是把同一网盘的结果全部堆在前面。
 *
 * 与 sortCloudLinksByPriority 的区别：排序会把全部 aliyun 结果排到最前，一旦调用方随后
 * 按数量截断（例如只取前 10 条），排在后面的 quark/baidu 候选会被整体丢弃。轮转保证每轮
 * 每个网盘最多取一条，优先级只决定同一轮内的先后，因此截断后仍能覆盖多个网盘。
 *
 * 组内保持原有顺序（上游相关度），未知网盘的组排在已知网盘之后。
 */
function interleaveByProviderPriority(links = []) {
  const buckets = new Map();
  const unknown = [];
  for (const link of links) {
    const priority = providerPriority(link?.diskType ?? link?.provider);
    // 未知网盘不参与轮转，统一追加在末尾，与 sortCloudLinksByPriority 的约定保持一致。
    if (priority === Number.MAX_SAFE_INTEGER) {
      unknown.push(link);
      continue;
    }
    if (!buckets.has(priority)) buckets.set(priority, []);
    buckets.get(priority).push(link);
  }

  const priorities = [...buckets.keys()].sort((a, b) => a - b);
  const longest = priorities.reduce((max, priority) => Math.max(max, buckets.get(priority).length), 0);
  const interleaved = [];
  for (let offset = 0; offset < longest; offset += 1) {
    for (const priority of priorities) {
      const bucket = buckets.get(priority);
      if (offset < bucket.length) interleaved.push(bucket[offset]);
    }
  }
  return [...interleaved, ...unknown];
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
  interleaveByProviderPriority,
  orderAvailableProviders,
  providerPriority,
  resolveProviderForShareUrl,
  sortCloudLinksByPriority
};
