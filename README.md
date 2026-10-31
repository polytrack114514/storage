# file-cloud-storage

云端文件中转站 —— 打开网页拖拽上传，任何设备随时下载，**无需注册、无需令牌**。

## 在线地址

**https://polytrack114514.github.io/file-cloud-storage/**

## 怎么用

1. 打开上面的网址
2. 把文件拖进「上传文件」区域（也可点「选择文件」或「选择整个文件夹」）
3. 文件会直接提交到本仓库，并出现在「云端文件」列表里
4. 换任何设备打开同一网址，都能看到并下载

支持多文件、整个文件夹上传，可指定目标子目录，带进度条和逐文件状态提示。全部文件操作都通过 Cloudflare Worker 中转，网页本身不保存、不接触任何 GitHub 令牌。

## 后端部署（仅仓库所有者需要做一次）

上传能力依赖一个 Cloudflare Worker，它替你持有 GitHub 令牌。部署步骤见仓库根目录的 `worker.js` 文件开头注释，摘要如下：

1. 注册免费 Cloudflare 账号，进入 Workers & Pages，新建一个 Worker
2. 把 `worker.js` 的全部内容粘贴进去并部署
3. 在 Worker 的 Settings → Variables 添加：
   - `GH_TOKEN`（加密变量）：有本仓库 Contents 读写权限的 GitHub 令牌
   - `REPO_OWNER`：`polytrack114514`
   - `REPO_NAME`：`file-cloud-storage`
   - `BRANCH`：`main`
   - 可选 `UPLOAD_PASSWORD`：设了之后网页端必须带上同样口令才能上传
4. 复制 Worker 地址（形如 `https://xxx.workers.dev`），填进本仓库的 `backend.json`：

```json
{ "workerUrl": "https://xxx.workers.dev", "password": "" }
```

保存提交后，刷新网页即可上传。

## 说明

- 本仓库是**公开仓库**，上传的文件任何人都能看到，请勿存放敏感内容
- 单文件最大 100 MB
- 如果不想让陌生人随意上传，在 Worker 里设置 `UPLOAD_PASSWORD`，并把同样的口令填进 `backend.json` 的 `password` 字段
- 适合文档、图片、代码等小文件，不适合当网盘存放大量大文件

## 仓库文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 上传器页面（GitHub Pages 托管） |
| `backend.json` | 上传后端地址配置 |
| `worker.js` | Cloudflare Worker 源码，令牌保存在它里面 |
| `README.md` | 本说明 |
