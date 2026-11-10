/**
 * 三家网盘共用的目标目录解析编排。
 *
 * 安全边界（不可放宽）：
 * - "strict"：目录不存在即报错，保持旧行为，检查类命令必须用这个模式。
 * - "preview"：只记录将创建的路径，绝不调用 createSegment，保证预览只读。
 * - "create"：仅在用户明确确认后调用 createSegment，且同名目录一律复用，不覆盖、不删除。
 */

const DIRECTORY_MODES = Object.freeze(["strict", "preview", "create"]);

/**
 * 从命令行状态推导目录模式。
 *
 * --dry-run 优先于 --yes：即使同时传入两个参数，预览也必须是只读的。
 * --no-create-dir 优先于一切，用于完整退回旧行为。
 */
function resolveDirectoryMode({ yes = false, dryRun = false, noCreateDir = false } = {}) {
  if (noCreateDir) return "strict";
  if (dryRun) return "preview";
  if (yes) return "create";
  return "strict";
}

/**
 * 逐级解析目标目录；缺失时按 mode 决定报错、记录还是创建。
 *
 * @param {object} options
 * @param {string[]} options.segments 目标路径的逐级目录名
 * @param {(parent: object, segment: string) => Promise<object|null>} options.listSegment 只读查询子目录
 * @param {(parent: object, segment: string, pendingPath: string) => Promise<object>} options.createSegment 创建目录（仅 create 模式调用）
 * @param {(parent: object, segment: string, pendingPath: string) => object} options.placeholder 预览模式下的占位目录
 * @param {(parentPath: string, segment: string) => string} options.joinPath
 * @param {string} [options.mode]
 * @param {string} [options.providerLabel]
 */
async function resolveCloudDirectory({
  segments = [],
  listSegment,
  createSegment,
  placeholder,
  joinPath,
  mode = "strict",
  providerLabel = "网盘"
} = {}) {
  if (!DIRECTORY_MODES.includes(mode)) throw new Error(`Unsupported directory mode: ${mode}`);
  if (typeof listSegment !== "function") throw new Error("listSegment is required");
  if (mode === "create" && typeof createSegment !== "function") {
    throw new Error("createSegment is required in create mode");
  }
  if ((mode === "create" || mode === "preview") && typeof placeholder !== "function") {
    throw new Error("placeholder is required in create and preview modes");
  }

  const missingDirectories = [];
  const createdDirectories = [];
  let current = { id: "root", name: "/", path: "/" };

  for (const segment of segments) {
    const existing = await listSegment(current, segment);
    if (existing) {
      current = existing;
      continue;
    }
    const pendingPath = joinPath(current.path, segment);
    if (mode === "strict") {
      throw new Error(`${providerLabel}保存目录不存在：缺少目录 ${pendingPath}。请先在${providerLabel}中创建目录，或使用自动创建模式。`);
    }
    missingDirectories.push(pendingPath);
    if (mode === "create") {
      const created = await createSegment(current, segment, pendingPath);
      if (!created || !created.id) {
        throw new Error(`${providerLabel}创建目录失败：${pendingPath} 未返回有效的目录标识。`);
      }
      current = created;
      createdDirectories.push(pendingPath);
    } else {
      current = placeholder(current, segment, pendingPath);
    }
  }

  return {
    folder: current,
    missingDirectories,
    createdDirectories,
    resolved: missingDirectories.length === 0
  };
}

/** 把目录规划结果并入预览输出，让调用方看清"确认后将创建什么"。 */
function directoryPlanFields(plan = {}) {
  return {
    willCreateDirectories: plan.missingDirectories || [],
    createdDirectories: plan.createdDirectories || []
  };
}

export { DIRECTORY_MODES, directoryPlanFields, resolveCloudDirectory, resolveDirectoryMode };
