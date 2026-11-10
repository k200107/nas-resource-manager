#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// CMD 默认代码页可能不是 UTF-8；在 npm 生命周期脚本中提前切换，
// 让后续 media-plan 子进程接收并输出中文路径时使用 UTF-8。
if (process.platform === "win32" && (process.stdout.isTTY || process.stderr.isTTY)) {
  spawnSync("chcp 65001 >NUL", { shell: true, stdio: "ignore" });
}
