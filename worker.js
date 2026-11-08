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
const PROTECTED = ['backend.json', 'index.html', 'README.md', 'worker.js'];
const MAX_BYTES = 100 * 1024 * 1024;
const ZIP_MAX = 80 * 1024 * 1024;

const isProtected = (p) => !String(p || '').includes('/') && PROTECTED.indexOf(p) >= 0;

/** 回收站目录：删除的文件先挪到这里，可以再恢复 */
const TRASH_DIR = '.trash';

/** ---------- ZIP 打包（STORE 无压缩） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

const b64ToBytes = (b64) => {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** entries: [{ name, data: Uint8Array }] */
const buildZip = (entries) => {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach((e) => {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);

    chunks.push(lh, e.data);
    central.push(ch);
    offset += lh.length + size;
  });

  const centralStart = offset;
  let centralSize = 0;
  central.forEach((c) => { chunks.push(c); centralSize += c.length; });

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  chunks.forEach((c) => { out.set(c, pos); pos += c.length; });
  return out;
};

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

    /** 读取文件内容（大文件走 blobs 接口），返回 { b64, sha } 或 null */
    const readFileB64 = async (path) => {
      const r = await gh(contentsPath(path));
      if (!r.ok) return null;
      const j = await r.json();
      if (Array.isArray(j)) return null;
      if (j.content) return { b64: String(j.content).replace(/\s/g, ''), sha: j.sha };
      const br = await gh('/repos/' + owner + '/' + repo + '/git/blobs/' + j.sha);
      if (!br.ok) return null;
      const bj = await br.json();
      if (!bj.content) return null;
      return { b64: String(bj.content).replace(/\s/g, ''), sha: j.sha };
    };

    const putFile = async (path, b64, message) => {
      const head = await gh(contentsPath(path));
      let sha = null;
      if (head.ok) {
        const j = await head.json();
        if (j && j.sha) sha = j.sha;
      }
      const payload = { message, content: b64, branch };
      if (sha) payload.sha = sha;
      return gh(contentsPath(path, false), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    };

    const removeFile = async (path, sha) => {
      let s = sha;
      if (!s) {
        const h = await gh(contentsPath(path));
        if (!h.ok) return h;
        const j = await h.json();
        s = j && j.sha;
      }
      return gh(contentsPath(path, false), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'delete: ' + path, sha: s, branch }),
      });
    };

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ---------- 全局搜索（跨目录，按文件名/路径匹配） ----------
      if (request.method === 'GET' && route === '/search') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        if (!q) return json([], 200, cors);
        const r = await gh(
          '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
        );
        if (!r.ok) return json({ error: '读取仓库失败' }, r.status, cors);
        const j = await r.json();
        const meta = (await readMeta()).data;
        const items = (j.tree || [])
          .filter((it) =>
            it.type === 'blob' &&
            it.path !== META_FILE &&
            it.path !== TRASH_DIR &&
            it.path.indexOf(TRASH_DIR + '/') !== 0 &&
            it.path.split('/').pop() !== '.keep')
          .filter((it) => it.path.toLowerCase().indexOf(q) >= 0)
          .slice(0, 200)
          .map((it) => ({
            path: it.path,
            name: it.path.split('/').pop(),
            size: it.size || 0,
            uploadedAt: meta[it.path] || null,
          }));
        return json(items, 200, cors);
      }

      // ---------- 列出目录 ----------
      if (request.method === 'GET' && route === '/list') {
        const path = url.searchParams.get('path') || '';
        const r = await gh(contentsPath(path));
        if (r.status === 404) return json([], 200, cors);
        const data = await r.json();
        if (!Array.isArray(data)) return json(data, r.status, cors);

        const meta = (await readMeta()).data;
        const withTime = data
          .filter((it) => it.name !== META_FILE && it.name !== '.keep' && it.path !== TRASH_DIR)
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
        const blobs = (j.tree || []).filter(
          (it) => it.type === 'blob' && it.path !== META_FILE && it.path.indexOf(TRASH_DIR + '/') !== 0
        );
        const bytes = blobs.reduce((sum, it) => sum + (it.size || 0), 0);
        return json({ files: blobs.length, bytes, passwordRequired: !!env.UPLOAD_PASSWORD }, 200, cors);
      }

      // ---------- 回收站列表 ----------
      if (request.method === 'GET' && route === '/trash') {
        const r = await gh(
          '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
        );
        if (!r.ok) return json({ error: '读取回收站失败' }, r.status, cors);
        const j = await r.json();
        const meta = (await readMeta()).data;
        const items = (j.tree || [])
          .filter((it) => it.type === 'blob' && it.path.indexOf(TRASH_DIR + '/') === 0)
          .map((it) => ({
            path: it.path.slice(TRASH_DIR.length + 1),
            size: it.size || 0,
            deletedAt: meta[it.path] || null,
          }));
        return json(items, 200, cors);
      }

      // ---------- 目录打包下载 ----------
      if (request.method === 'GET' && route === '/zip') {
        const dir = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
        const namesRaw = url.searchParams.get('names') || '';
        const wanted = namesRaw ? namesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const r = await gh(
          '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
        );
        if (!r.ok) return json({ error: '读取目录失败' }, r.status, cors);
        const j = await r.json();
        const prefix = dir ? dir + '/' : '';
        let files;
        if (wanted.length) {
          const hit = {};
          wanted.forEach((n) => { hit[prefix + n] = true; });
          files = (j.tree || []).filter((it) => it.type === 'blob' && hit[it.path]);
        } else {
          files = (j.tree || []).filter(
            (it) =>
              it.type === 'blob' &&
              it.path.indexOf(prefix) === 0 &&
              it.path !== META_FILE &&
              it.path.indexOf(TRASH_DIR + '/') !== 0 &&
              it.path !== TRASH_DIR
          );
        }
        if (!files.length) return json({ error: '目录为空或不存在' }, 404, cors);

        const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
        if (total > ZIP_MAX) return json({ error: '该目录超过 80 MB，请分批下载' }, 413, cors);

        const entries = [];
        for (const f of files) {
          const src = await readFileB64(f.path);
          if (!src) continue;
          entries.push({
            name: f.path.slice(prefix.length) || f.path.split('/').pop(),
            data: b64ToBytes(src.b64),
          });
        }
        if (!entries.length) return json({ error: '没有可打包的文件' }, 404, cors);

        const zip = buildZip(entries);
        const name = (dir ? dir.split('/').pop() : repo) + '.zip';
        return new Response(zip, {
          status: 200,
          headers: {
            ...cors,
            'Content-Type': 'application/zip',
            'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
          },
        });
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

      // ---------- 新建文件夹（Git 仓库没有空目录，用 .keep 占位） ----------
      if (route === '/mkdir') {
        const parent = String(body.path || '').replace(/^\/+|\/+$/g, '');
        const name = String(body.name || '')
          .replace(/[\\/]+/g, '-')
          .replace(/[\u0000-\u001f<>:"|?*]/g, '')
          .replace(/^\.+/, '')
          .trim()
          .slice(0, 60);
        if (!name) return json({ error: '文件夹名不合法' }, 400, cors);

        const dir = parent ? parent + '/' + name : name;
        const head = await gh(contentsPath(dir));
        if (head.ok) return json({ error: '「' + dir + '」已存在', exists: true }, 409, cors);

        const out = await putFile(dir + '/.keep', b64encode('# keep\n'), 'mkdir: ' + dir);
        if (!out.ok) {
          const t = await out.text();
          return json({ error: '创建文件夹失败（HTTP ' + out.status + '）', detail: t.slice(0, 200) }, out.status, cors);
        }
        return json({ ok: true, path: dir }, 201, cors);
      }

      // ---------- 移动 / 重命名 ----------
      if (route === '/move') {
        const from = String(body.from || '').replace(/^\/+|\/+$/g, '');
        const to = String(body.to || '').replace(/^\/+|\/+$/g, '');
        if (!from || !to) return json({ error: '缺少 from 或 to' }, 400, cors);
        if (from === to) return json({ ok: true, path: to, count: 0 }, 200, cors);
        if (isProtected(from) || isProtected(to)) {
          return json({ error: '基础文件不能移动或改名', protected: true }, 403, cors);
        }
        if (to.indexOf(from + '/') === 0) return json({ error: '不能移动到自己的子目录里' }, 400, cors);

        const head = await gh(contentsPath(from));
        if (!head.ok) return json({ error: '「' + from + '」不存在' }, 404, cors);
        const info = await head.json();
        const isDir = Array.isArray(info);

        const target = await gh(contentsPath(to));
        if (target.ok) return json({ error: '「' + to + '」已存在', exists: true }, 409, cors);

        let toMove;
        if (isDir) {
          const r = await gh('/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1');
          if (!r.ok) return json({ error: '读取目录失败' }, r.status, cors);
          const j = await r.json();
          toMove = (j.tree || [])
            .filter((it) => it.type === 'blob' && it.path.indexOf(from + '/') === 0)
            .map((it) => it.path);
        } else {
          toMove = [from];
        }
        if (!toMove.length) return json({ error: '目录是空的' }, 404, cors);

        // 先把文件全部复制到新位置，都成功后再删旧的，避免中途失败丢文件
        const meta = (await readMeta()).data;
        const now = new Date().toISOString();
        const done = [];
        for (const p of toMove) {
          const src = await readFileB64(p);
          if (!src) continue;
          const np = isDir ? to + p.slice(from.length) : to;
          const w = await putFile(np, src.b64, 'move: ' + p + ' -> ' + np);
          if (!w.ok) {
            return json({ error: '移动失败（复制阶段 HTTP ' + w.status + '）', moved: done }, 500, cors);
          }
          done.push({ from: p, to: np });
        }

        const patch = {};
        for (const d of done) {
          await removeFile(d.from);
          patch[d.from] = null;
          patch[d.to] = meta[d.from] || meta[d.to] || now;
        }
        await writeMeta(patch);

        return json({ ok: true, from, to, isDir, count: done.length }, 200, cors);
      }

      // ---------- 删除（移入回收站） ----------
      if (route === '/delete') {
        const path = body.path;
        if (!path) return json({ error: '缺少 path' }, 400, cors);
        if (isProtected(path)) {
          return json({ error: '「' + path + '」是基础文件，不允许删除', protected: true }, 403, cors);
        }

        const src = await readFileB64(path);
        if (!src) return json({ error: '文件不存在（文件夹请逐个删除）' }, 404, cors);

        const trashPath = TRASH_DIR + '/' + path;
        const moved = await putFile(trashPath, src.b64, 'trash: ' + path);
        if (!moved.ok) return json({ error: '移入回收站失败，文件未被删除' }, 500, cors);

        const del = await removeFile(path, body.sha || src.sha);
        if (!del.ok) return json({ error: '原文件删除失败，回收站已保留副本' }, del.status, cors);

        await writeMeta({ [path]: null, [trashPath]: new Date().toISOString() });
        return json({ ok: true, trashedTo: trashPath }, 200, cors);
      }

      // ---------- 回收站操作：恢复 / 彻底删除 / 清空 ----------
      if (route === '/trash') {
        if (body.action === 'restore') {
          const path = body.path;
          if (!path) return json({ error: '缺少 path' }, 400, cors);
          if (isProtected(path)) {
            return json({ error: '「' + path + '」是基础文件，无需恢复', protected: true }, 403, cors);
          }

          const exists = await gh(contentsPath(path));
          if (exists.ok) {
            return json({ error: '「' + path + '」已存在，请先删除或改名后再恢复' }, 409, cors);
          }

          const trashPath = TRASH_DIR + '/' + path;
          const src = await readFileB64(trashPath);
          if (!src) return json({ error: '回收站中没有该文件' }, 404, cors);

          const back = await putFile(path, src.b64, 'restore: ' + path);
          if (!back.ok) return json({ error: '恢复失败' }, 500, cors);
          await removeFile(trashPath, src.sha);

          const meta = (await readMeta()).data;
          await writeMeta({ [trashPath]: null, [path]: meta[path] || new Date().toISOString() });
          return json({ ok: true, restored: path }, 200, cors);
        }

        if (body.action === 'purge') {
          const path = body.path;
          if (!path) return json({ error: '缺少 path' }, 400, cors);
          const trashPath = TRASH_DIR + '/' + path;
          const out = await removeFile(trashPath);
          if (!out.ok) return json({ error: '回收站中没有该文件' }, out.status, cors);
          await writeMeta({ [trashPath]: null });
          return json({ ok: true }, 200, cors);
        }

        if (body.action === 'empty') {
          const r = await gh(
            '/repos/' + owner + '/' + repo + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1'
          );
          if (!r.ok) return json({ error: '读取回收站失败' }, r.status, cors);
          const j = await r.json();
          const files = (j.tree || []).filter(
            (it) => it.type === 'blob' && it.path.indexOf(TRASH_DIR + '/') === 0
          );
          const patch = {};
          let n = 0;
          for (const f of files) {
            const out = await removeFile(f.path);
            if (out.ok) {
              n++;
              patch[f.path] = null;
            }
          }
          if (Object.keys(patch).length) await writeMeta(patch);
          return json({ ok: true, removed: n }, 200, cors);
        }

        return json({ error: '未知操作' }, 400, cors);
      }

      return json({ error: '未知接口' }, 404, cors);
    } catch (e) {
      return json({ error: '后端异常：' + String(e && e.message ? e.message : e) }, 500, cors);
    }
  },
};
