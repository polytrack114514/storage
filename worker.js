/**
 * file-cloud-storage 上传后端（Cloudflare Worker）
 *
 * 作用：把 GitHub 令牌藏在这里，让网页端不需要任何令牌就能上传/删除/浏览。
 *
 * 需要配置的环境变量（在 Cloudflare 后台 Settings → Variables 里添加）：
 *   GH_TOKEN        （加密变量，必填）有该仓库 Contents 读写权限的 GitHub 令牌
 *   REPO_OWNER      （明文，必填）仓库所有者，例如 polytrack114514
 *   REPO_NAME       （明文，必填）仓库名称，例如 storage
 *   BRANCH          （明文，可选）分支，默认 main
 *   ALLOW_ORIGIN    （明文，可选）允许的来源，默认 https://polytrack114514.github.io
 *   UPLOAD_PASSWORD （加密变量，可选）如果设置，网页端必须带上同样的口令才能上传
 */

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });

/** 仓库根目录的基础文件：禁止被覆盖或删除，防止站点被破坏 */
const PROTECTED = ['backend.json', 'index.html', 'README.md'];
const MAX_BYTES = 100 * 1024 * 1024;

const isProtected = (p) => !String(p || '').includes('/') && PROTECTED.indexOf(p) >= 0;

/** 记录每个文件的上传时间，供列表排序与展示使用 */
const META_FILE = '.meta.json';

const b64encode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const b64decode = (s) => {
  const bin = atob(String(s || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const encPath = (p) =>
  String(p || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const owner = env.REPO_OWNER;
    const repo = env.REPO_NAME;
    const branch = env.BRANCH || 'main';

    if (!env.GH_TOKEN || !owner || !repo) {
      return json({ error: '后端未配置：缺少 GH_TOKEN / REPO_OWNER / REPO_NAME' }, 500, cors);
    }

    const gh = (path, opts = {}) =>
      fetch('https://api.github.com' + path, {
        ...opts,
        headers: {
          Authorization: 'Bearer ' + env.GH_TOKEN,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'file-cloud-storage-worker',
          ...(opts.headers || {}),
        },
      });

    const contentsPath = (p, withRef) => {
      let u = '/repos/' + owner + '/' + repo + '/contents';
      const enc = encPath(p);
      if (enc) u += '/' + enc;
      if (withRef !== false) u += '?ref=' + encodeURIComponent(branch);
      return u;
    };

    const readMeta = async () => {
      try {
        const r = await gh(contentsPath(META_FILE));
        if (!r.ok) return { data: {}, sha: null };
        const j = await r.json();
        const parsed = JSON.parse(b64decode(j.content) || '{}');
        return { data: parsed && typeof parsed === 'object' ? parsed : {}, sha: j.sha };
      } catch (e) {
        return { data: {}, sha: null };
      }
    };

    /** patch 里值为 null 表示删除该条记录 */
    const writeMeta = async (patch) => {
      const cur = await readMeta();
      const data = Object.assign({}, cur.data, patch);
      Object.keys(data).forEach((k) => { if (data[k] === null) delete data[k]; });
      const payload = {
        message: 'meta: 更新时间索引',
        content: b64encode(JSON.stringify(data, null, 2)),
        branch,
      };
      if (cur.sha) payload.sha = cur.sha;
      return gh(contentsPath(META_FILE, false), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    };

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ---------- 列出目录 ----------
      if (request.method === 'GET' && route === '/list') {
        const path = url.searchParams.get('path') || '';
        const r = await gh(contentsPath(path));
        if (r.status === 404) return json([], 200, cors);
        const data = await r.json();
        if (!Array.isArray(data)) return json(data, r.status, cors);

        const meta = (await readMeta()).data;
        const withTime = data
          .filter((it) => it.name !== META_FILE)
          .map((it) => Object.assign({}, it, { uploadedAt: meta[it.path] || null }));
        return json(withTime, 200, cors);
      }

      // ---------- 仓库统计 ----------
      if (request.method === 'GET' && route === '/stats') {
        const r = await gh(
          '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
        );
        if (!r.ok) return json({ error: '读取仓库信息失败' }, r.status, cors);
        const j = await r.json();
        const blobs = (j.tree || []).filter((it) => it.type === 'blob' && it.path !== META_FILE);
        const bytes = blobs.reduce((sum, it) => sum + (it.size || 0), 0);
        return json({ files: blobs.length, bytes, passwordRequired: !!env.UPLOAD_PASSWORD }, 200, cors);
      }

      // ---------- 下载文件 ----------
      if (request.method === 'GET' && route === '/download') {
        const path = url.searchParams.get('path') || '';
        if (!path) return json({ error: '缺少 path' }, 400, cors);

        const r = await gh(contentsPath(path));
        if (!r.ok) return json({ error: '文件不存在或无权限' }, r.status, cors);
        const meta = await r.json();
        if (Array.isArray(meta)) return json({ error: '这是一个目录' }, 400, cors);

        let b64 = meta.content || '';
        if (!b64 && meta.sha) {
          const br = await gh('/repos/' + owner + '/' + repo + '/git/blobs/' + meta.sha);
          if (!br.ok) return json({ error: '读取文件内容失败' }, br.status, cors);
          const bj = await br.json();
          b64 = bj.content || '';
        }
        if (!b64) return json({ error: '无法读取文件内容（可能超过 100 MB）' }, 415, cors);

        const bin = atob(b64.replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const name = meta.name || 'download';
        return new Response(bytes, {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition':
              "attachment; filename*=UTF-8''" + encodeURIComponent(name),
          },
        });
      }

      // ---------- 以下为写入操作 ----------
      if (request.method !== 'POST') {
        return json({ error: '方法不被允许' }, 405, cors);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: '请求体不是合法 JSON' }, 400, cors);
      }

      if (env.UPLOAD_PASSWORD && body.password !== env.UPLOAD_PASSWORD) {
        return json({ error: '口令错误' }, 403, cors);
      }

      // ---------- 上传 / 覆盖 ----------
      if (route === '/upload') {
        const path = body.path;
        if (!path || typeof body.content !== 'string') {
          return json({ error: '缺少 path 或 content' }, 400, cors);
        }
        if (isProtected(path)) {
          return json({ error: '「' + path + '」是基础文件，不允许覆盖', protected: true }, 403, cors);
        }

        const b64 = body.content.replace(/\s/g, '');
        const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
        if (size > MAX_BYTES) {
          return json({ error: '文件超过 100 MB 上限' }, 413, cors);
        }

        const head = await gh(contentsPath(path));
        if (head.ok) {
          return json({ error: '「' + path + '」已存在，不能覆盖上传；如需替换请先删除旧文件' }, 409, cors);
        }

        const payload = {
          message: body.message || 'upload: ' + path,
          content: body.content,
          branch,
        };

        const out = await gh(contentsPath(path, false), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await out.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { error: text.slice(0, 300) }; }

        if (out.ok) {
          const at = new Date().toISOString();
          await writeMeta({ [path]: at });
          if (data && typeof data === 'object') data.uploadedAt = at;
        }
        return json(data, out.status, cors);
      }

      // ---------- 删除 ----------
      if (route === '/delete') {
        const path = body.path;
        if (!path) return json({ error: '缺少 path' }, 400, cors);
        if (isProtected(path)) {
          return json({ error: '「' + path + '」是基础文件，不允许删除', protected: true }, 403, cors);
        }

        let sha = body.sha;
        if (!sha) {
          const head = await gh(contentsPath(path));
          if (!head.ok) return json({ error: '文件不存在' }, head.status, cors);
          const meta = await head.json();
          sha = meta && meta.sha;
        }

        const out = await gh(contentsPath(path, false), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: body.message || 'delete: ' + path,
            sha,
            branch,
          }),
        });
        const text = await out.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { error: text.slice(0, 300) }; }
        if (out.ok) await writeMeta({ [path]: null });
        return json(data, out.status, cors);
      }

      return json({ error: '未知接口' }, 404, cors);
    } catch (e) {
      return json({ error: '后端异常：' + String(e && e.message ? e.message : e) }, 500, cors);
    }
  },
};
