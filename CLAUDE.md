@AGENTS.md

## Claude Code

项目指引统一写在上面导入的 AGENTS.md，供所有 agent 共用。这里只放 Claude Code 专属的工作流，通用知识（架构、不变量、测试约定）改 AGENTS.md，不要在这里重复。

### 开始工作前

- 改哪块代码，先 grep 对应函数名，再读 AGENTS.md「关键不变量」里的相关条目和对应测试文件。
- 以下改动先用 plan mode 与用户确认方案：拆分 `app.js`、改动任何一条「关键不变量」涉及的逻辑、引入运行时 npm 依赖、修改 release.yml。

### 验证

- 完成改动前必须跑 `npm run check`、`npm run lint`、`npm test`，Node 22 和 24 都要通过。
- 本机没有 Node 时用 Docker 跑（两个版本各一次，把 `24` 换成 `22`）：

  ```sh
  docker run --rm -v "$PWD":/src:ro node:24 \
    bash -c 'cp -r /src /work && cd /work && npm ci --no-audit --no-fund && npm run check && npm run lint && npm test'
  ```

  Node 24 的 `node --test` 默认用 spec 报告格式，汇总行是 `ℹ tests N`，不是 TAP 的 `# tests N`，过滤输出时别漏掉。
- 汇报时写明通过的用例数和 Node 版本；有失败就贴出失败用例，不要只说「测试通过」。

### Git 与发布

- 提交信息沿用现有风格：`fix:` / `feat:` / `perf:` / `docs:` / `test:` / `release: vX.Y.Z — 摘要`，正文用中文。
- 只在用户要求时才 commit。推送、打 tag、`gh workflow run release.yml`、发 release 都是对外操作，每次执行前都要用户确认。
- 发版前按 AGENTS.md「发布流程」逐项检查，尤其是 `RELEASE_NOTES.md` 顶部的段落，缺了它发布会失败。
