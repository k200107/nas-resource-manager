import test from "node:test";
import assert from "node:assert/strict";

import {
  applyEnvDefaults,
  buildBaiduSubagentPreview,
  buildBaiduCompactSave,
  applyBaiduRenamePlan,
  resumeBaiduRename,
  buildBaiduTransferRequest,
  extractBaiduShareContextFromHtml,
  normalizeBaiduShareItems,
  parseBaiduSavePath,
  parseBaiduShareUrl,
  renderBaiduShareItemsTable
} from "../scripts/baidu-save.mjs";

test("parseBaiduShareUrl extracts feature string, verify surl, and passcode", () => {
  assert.deepEqual(parseBaiduShareUrl("https://pan.baidu.com/s/1abcDEF?pwd=8888#/list/share"), {
    featureStr: "1abcDEF",
    verifySurl: "abcDEF",
    passcode: "8888",
    sharePageUrl: "https://pan.baidu.com/s/1abcDEF"
  });

  assert.deepEqual(parseBaiduShareUrl("https://pan.baidu.com/share/init?surl=xyz789&pwd=1234"), {
    featureStr: "1xyz789",
    verifySurl: "xyz789",
    passcode: "1234",
    sharePageUrl: "https://pan.baidu.com/s/1xyz789"
  });
});

test("applyEnvDefaults uses configured Baidu cookie and default save path", () => {
  const args = applyEnvDefaults(
    {
      shareUrl: "https://pan.baidu.com/s/1abcDEF?pwd=8888",
      savePath: "",
      cookieEnv: "BAIDU_COOKIE"
    },
    {
      BAIDU_COOKIE: "BDUSS=abc; STOKEN=def",
      BAIDU_DEFAULT_SAVE_PATH: "/我的资源/影视"
    }
  );

  assert.equal(args.savePath, "/我的资源/影视");
  assert.equal(args.env.BAIDU_COOKIE, "BDUSS=abc; STOKEN=def");
});

test("parseBaiduSavePath decodes Baidu folder URLs and keeps direct paths", () => {
  assert.equal(parseBaiduSavePath("/NAS资源下载"), "/NAS资源下载");
  assert.equal(
    parseBaiduSavePath(
      "https://pan.baidu.com/disk/main#/index?category=all&path=%2FNAS%E8%B5%84%E6%BA%90%E4%B8%8B%E8%BD%BD"
    ),
    "/NAS资源下载"
  );
});

test("applyEnvDefaults normalizes Baidu default save URL into cloud-drive path", () => {
  const args = applyEnvDefaults(
    {
      shareUrl: "https://pan.baidu.com/s/1abcDEF?pwd=8888",
      savePath: "",
      cookieEnv: "BAIDU_COOKIE"
    },
    {
      BAIDU_COOKIE: "BDUSS=abc; STOKEN=def",
      BAIDU_DEFAULT_SAVE_PATH:
        "https://pan.baidu.com/disk/main#/index?category=all&path=%2FNAS%E8%B5%84%E6%BA%90%E4%B8%8B%E8%BD%BD"
    }
  );

  assert.equal(args.savePath, "/NAS资源下载");
});

test("extractBaiduShareContextFromHtml reads transfer tokens and share files", () => {
  const context = extractBaiduShareContextFromHtml(`
<script>
window.yunData.setData({"loginstate":1,"bdstoken":"bd-token","shareid":12345,"share_uk":67890,"file_list":[{"fs_id":111,"server_filename":"蜘蛛侠.mkv","isdir":0,"size":2048,"server_mtime":1710000000}]});
</script>
`);

  assert.equal(context.bdstoken, "bd-token");
  assert.equal(context.shareId, "12345");
  assert.equal(context.shareUk, "67890");
  assert.equal(context.files[0].fs_id, 111);
});

test("extractBaiduShareContextFromHtml supports current yunData and locals.mset page shape", () => {
  const context = extractBaiduShareContextFromHtml(`
<script>
window.yunData={skinName:'white', neglect:1, bdstoken:'bd-token', uk:'4267601248', loginstate:'1', share_uk:"987654321", shareid:"12345678901"};
locals.mset({"bdstoken":"bd-token","share_uk":"987654321","shareid":12345678901,"file_list":[{"fs_id":756464633449793,"server_filename":"暗影蜘蛛","isdir":1,"size":0,"server_mtime":1779892650}]});
</script>
`);

  assert.equal(context.bdstoken, "bd-token");
  assert.equal(context.shareId, "12345678901");
  assert.equal(context.shareUk, "987654321");
  assert.equal(context.files[0].server_filename, "暗影蜘蛛");
});

test("extractBaiduShareContextFromHtml ignores yunData template references after passcode verification", () => {
  const context = extractBaiduShareContextFromHtml(`
<script>
window.yunData = {
  skinName: data.skinName,
  bdstoken: data.bdstoken,
  uk: data.uk,
  shareid: data.shareid,
  share_uk: data.share_uk
};
</script>
<script type="application/json" id="locals-data">
{"share_uk":"3716169814","shareid":11955819949,"bdstoken":"real-token"}
</script>
`);

  assert.equal(context.shareId, "11955819949");
  assert.equal(context.shareUk, "3716169814");
  assert.notEqual(context.shareId, "data.shareid");
  assert.notEqual(context.shareUk, "data.share_uk");
});

test("normalizeBaiduShareItems maps share rows into confirmable resources", () => {
  const items = normalizeBaiduShareItems([
    {
      fs_id: 111,
      server_filename: "蜘蛛侠.mkv",
      isdir: 0,
      size: 1536,
      server_mtime: 1710000000
    },
    {
      fs_id: 222,
      server_filename: "花絮",
      isdir: 1,
      size: 0,
      server_mtime: 1710100000
    }
  ]);

  assert.deepEqual(
    items.map((item) => ({
      rank: item.rank,
      fsId: item.fsId,
      name: item.name,
      isDir: item.isDir,
      sizeLabel: item.sizeLabel,
      updatedAtLabel: item.updatedAtLabel
    })),
    [
      {
        rank: 1,
        fsId: 111,
        name: "蜘蛛侠.mkv",
        isDir: false,
        sizeLabel: "1.5 KB",
        updatedAtLabel: "2024-03-09"
      },
      {
        rank: 2,
        fsId: 222,
        name: "花絮",
        isDir: true,
        sizeLabel: "-",
        updatedAtLabel: "2024-03-10"
      }
    ]
  );
});

test("buildBaiduTransferRequest creates a share transfer request", () => {
  const request = buildBaiduTransferRequest({
    apiBase: "https://pan.baidu.com",
    bdstoken: "bd-token",
    shareId: "12345",
    shareUk: "67890",
    savePath: "/我的资源/影视",
    selectedItems: [
      { fsId: 111 },
      { fsId: 222 }
    ]
  });

  assert.equal(request.url.origin, "https://pan.baidu.com");
  assert.equal(request.url.pathname, "/share/transfer");
  assert.equal(request.url.searchParams.get("shareid"), "12345");
  assert.equal(request.url.searchParams.get("from"), "67890");
  assert.equal(request.url.searchParams.get("bdstoken"), "bd-token");
  assert.equal(request.url.searchParams.get("ondup"), "newcopy");
  assert.equal(request.body.get("fsidlist"), "[111,222]");
  assert.equal(request.body.get("path"), "/我的资源/影视");
});

test("buildBaiduTransferRequest normalizes Baidu folder URL save path", () => {
  const request = buildBaiduTransferRequest({
    bdstoken: "bd-token",
    shareId: "12345",
    shareUk: "67890",
    savePath: "https://pan.baidu.com/disk/main#/index?category=all&path=%2FNAS%E8%B5%84%E6%BA%90%E4%B8%8B%E8%BD%BD",
    selectedItems: [{ fsId: 111 }]
  });

  assert.equal(request.body.get("path"), "/NAS资源下载");
  assert.equal(request.url.searchParams.has("sekey"), false);
});

test("buildBaiduTransferRequest forwards sekey for passcode-protected shares", () => {
  const request = buildBaiduTransferRequest({
    bdstoken: "bd-token",
    shareId: "12345",
    shareUk: "67890",
    savePath: "/影视库",
    sekey: "rand-sk",
    selectedItems: [{ fsId: 111 }]
  });

  assert.equal(request.url.searchParams.get("sekey"), "rand-sk");
  assert.equal(request.url.searchParams.get("bdstoken"), "bd-token");
  assert.equal(request.body.get("path"), "/影视库");
  assert.equal(request.body.get("fsidlist"), "[111]");
});

test("buildBaiduTransferRequest does not double-encode the verify randsk", () => {
  const randsk = "qOxamhf8exUJ2A%2BMYSpk3fKNU74nTlVEbQ%2BU26yx144%3D";
  const request = buildBaiduTransferRequest({
    bdstoken: "bd-token",
    shareId: "12345",
    shareUk: "67890",
    savePath: "/影视库",
    sekey: randsk,
    selectedItems: [{ fsId: 111 }]
  });

  assert.equal(request.url.searchParams.get("sekey"), decodeURIComponent(randsk));
  assert.equal(request.url.search.includes("%252B"), false);
  assert.equal(request.url.search.includes("%2B"), true);
});

test("renderBaiduShareItemsTable outputs a confirmation table", () => {
  const markdown = renderBaiduShareItemsTable({
    shareTitle: "蜘蛛侠合集",
    contextName: "蜘蛛侠合集",
    savePath: "/我的资源/影视",
    items: normalizeBaiduShareItems([
      {
        fs_id: 111,
        server_filename: "蜘蛛侠.mkv",
        isdir: 0,
        size: 1024,
        server_mtime: 1710000000
      }
    ])
  });

  assert.match(markdown, /### 百度网盘分享资源/);
  assert.match(markdown, /目标目录：\/我的资源\/影视/);
  assert.match(markdown, /资源类型：电影\/合集/);
  assert.match(markdown, /\| 1 \| 文件 \| 蜘蛛侠\.mkv \| 1 KB \| 2024-03-09 \|/);
});

test("buildBaiduSubagentPreview creates structured confirmation payload", () => {
  const items = normalizeBaiduShareItems([
    {
      fs_id: 111,
      server_filename: "暗影蜘蛛",
      isdir: 1,
      size: 0,
      server_mtime: 1710000000
    }
  ]);
  const payload = buildBaiduSubagentPreview({
    args: {
      shareUrl: "https://pan.baidu.com/s/1abcDEF?pwd=8888",
      savePath: "/NAS资源下载",
      dryRun: true
    },
    result: {
      shareTitle: "暗影蜘蛛",
      contextName: "暗影蜘蛛",
      savePath: "/NAS资源下载",
      classification: {
        type: "collection",
        isSeries: false,
        label: "合集",
        reason: "Agent 根据上下文判定为合集"
      },
      items,
      selectedPreview: items,
      renamePlan: []
    }
  });

  assert.equal(payload.provider, "baidu");
  assert.equal(payload.mode, "preview");
  assert.equal(payload.nextAction, "confirm_before_save");
  assert.equal(payload.confirmation.source, "https://pan.baidu.com/s/1abcDEF?pwd=8888");
  assert.equal(payload.confirmation.target.pathOrUrl, "/NAS资源下载");
  assert.equal(payload.confirmation.selectedItems[0].name, "暗影蜘蛛");
});


test("applyBaiduRenamePlan resolves extensions and reports the actual source path", async () => {
  const results = await applyBaiduRenamePlan({
    apiBase: "https://pan.baidu.com",
    cookie: "cookie",
    bdstoken: "token",
    targetRows: [{ fsId: 12, name: "movie.mkv", path: "/影视库/movie.mkv" }],
    renamePlan: [{ sourcePath: "/影视库/movie.mkv", originalName: "movie.mkv", suggestedName: "电影.mkv" }],
    renamePathImpl: async ({ sourcePath, newName }) => {
      assert.equal(sourcePath, "/影视库/movie.mkv");
      assert.equal(newName, "电影.mkv");
      return { errno: 0 };
    }
  });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].sourcePath, "/影视库/movie.mkv");
});

test("Baidu compact save distinguishes saved-but-rename-failed from transfer failure", () => {
  const payload = buildBaiduCompactSave({
    args: { shareUrl: "https://pan.baidu.com/s/1abc", savePath: "/影视库" },
    result: { savePath: "/影视库" },
    saveResult: {
      ok: false,
      state: "SAVED_RENAME_FAILED",
      transferResponse: { errno: 0 },
      selectedItems: [{ fsId: 1 }],
      renameResults: [{
        ok: false, originalName: "可能的爱 (2026)", suggestedName: "可能的爱",
        sourcePath: "/影视库/可能的爱 (2026)", recoverable: true, error: "timeout"
      }]
    }
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "SAVED_RENAME_FAILED");
  assert.equal(payload.nextAction, "resume_rename_without_resaving");
  assert.equal(payload.rename.failures[0].sourcePath, "/影视库/可能的爱 (2026)");
  assert.equal(payload.rename.failures[0].renameTo, "可能的爱");
});

test("resumeBaiduRename dry-run verifies the exact source and never writes", async () => {
  let renameCalls = 0;
  const result = await resumeBaiduRename({
    sourcePath: "/影视库/可能的爱 (2026)",
    newName: "可能的爱",
    cookie: "cookie",
    dryRun: true,
    getTokenImpl: async () => "token",
    listDirImpl: async () => [{ name: "可能的爱 (2026)" }],
    renamePathImpl: async () => { renameCalls += 1; }
  });
  assert.equal(result.state, "READY_TO_RENAME");
  assert.equal(result.targetPath, "/影视库/可能的爱");
  assert.equal(renameCalls, 0);
});

test("resumeBaiduRename completes and verifies an already-saved rename without transferring", async () => {
  let listCalls = 0;
  let renameCalls = 0;
  const result = await resumeBaiduRename({
    sourcePath: "/影视库/可能的爱 (2026)",
    newName: "可能的爱",
    cookie: "cookie",
    getTokenImpl: async () => "token",
    listDirImpl: async () => {
      listCalls += 1;
      return listCalls === 1 ? [{ name: "可能的爱 (2026)" }] : [{ name: "可能的爱" }];
    },
    renamePathImpl: async () => { renameCalls += 1; return { errno: 0, taskid: "task-1" }; },
    sleepImpl: async () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.taskId, "task-1");
  assert.equal(renameCalls, 1);
  assert.equal(listCalls, 2);
});

test("resumeBaiduRename is idempotent when the target name already exists", async () => {
  let renameCalls = 0;
  const result = await resumeBaiduRename({
    sourcePath: "/影视库/可能的爱 (2026)",
    newName: "可能的爱",
    cookie: "cookie",
    getTokenImpl: async () => "token",
    listDirImpl: async () => [{ name: "可能的爱" }],
    renamePathImpl: async () => { renameCalls += 1; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, "ALREADY_COMPLETED");
  assert.equal(renameCalls, 0);
});

test("resumeBaiduRename refuses to overwrite an existing target", async () => {
  let renameCalls = 0;
  const result = await resumeBaiduRename({
    sourcePath: "/影视库/可能的爱 (2026)",
    newName: "可能的爱",
    cookie: "cookie",
    getTokenImpl: async () => "token",
    listDirImpl: async () => [{ name: "可能的爱 (2026)" }, { name: "可能的爱" }],
    renamePathImpl: async () => { renameCalls += 1; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "TARGET_CONFLICT");
  assert.equal(renameCalls, 0);
});

test("resumeBaiduRename reports a recoverable failure without hiding the source path", async () => {
  const result = await resumeBaiduRename({
    sourcePath: "/影视库/可能的爱 (2026)",
    newName: "可能的爱",
    cookie: "cookie",
    getTokenImpl: async () => "token",
    listDirImpl: async () => [{ name: "可能的爱 (2026)" }],
    renamePathImpl: async () => { throw new Error("network timeout"); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "SAVED_RENAME_FAILED");
  assert.equal(result.recoverable, true);
  assert.equal(result.sourcePath, "/影视库/可能的爱 (2026)");
});

test("resumeBaiduRename rejects path traversal and nested rename targets", async () => {
  await assert.rejects(
    resumeBaiduRename({ sourcePath: "/影视库/../其他/片名", newName: "新名", getTokenImpl: async () => "token" }),
    /absolute Baidu path/
  );
  await assert.rejects(
    resumeBaiduRename({ sourcePath: "/影视库/片名", newName: "../覆盖", getTokenImpl: async () => "token" }),
    /single non-empty path segment/
  );
});
