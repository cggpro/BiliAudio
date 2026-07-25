/**
 * BiliAudio - 轻量级B站音频播放器后端
 * 纯原生Node.js，零外部依赖，内存占用极小
 */
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

// ==================== 配置 ====================
const PORT = process.env.PORT || 7789;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BILIBILI_API = 'https://api.bilibili.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ==================== 内存缓存 ====================
const cache = new Map();
const CACHE_TTL = {
  videoInfo: 10 * 60 * 1000,   // 视频信息缓存10分钟
  collection: 10 * 60 * 1000,  // 合集缓存10分钟
  audioUrl: 3 * 60 * 1000,     // 音频URL缓存3分钟
  wbiKey: 60 * 60 * 1000,      // Wbi密钥缓存1小时
};

function getCache(key) {
  const item = cache.get(key);
  if (item && Date.now() < item.expireAt) return item.data;
  if (item) cache.delete(key);
  return null;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, expireAt: Date.now() + ttl });
  // 限制缓存大小，防止内存泄漏
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// ==================== HTTP请求工具 ====================
function fetchUrl(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...options.headers,
      },
      timeout: options.timeout || 15000,
    };

    const req = lib.request(reqOpts, (res) => {
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, reqUrl).href;
        }
        return fetchUrl(redirectUrl, options).then(resolve).catch(reject);
      }

      if (options.stream) {
        resolve(res);
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, headers: res.headers, body, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ==================== B站短链接解析 ====================
async function resolveShortUrl(shortUrl) {
  try {
    const result = await fetchUrl(shortUrl, { method: 'GET' });
    // b23.tv 短链接会返回一个包含目标URL的页面
    const match = result.body.match(/https?:\/\/www\.bilibili\.com\/video\/[^"'<\s]+/);
    if (match) return match[0];
    // 或者直接从重定向获取
    if (result.status === 302 && result.headers.location) {
      return result.headers.location;
    }
  } catch (e) {
    console.error('Short URL resolve error:', e.message);
  }
  return null;
}

// ==================== BV号/AV号提取 ====================
function extractVideoId(input) {
  // 去除首尾空白
  input = input.trim();

  // 直接匹配BV号
  const bvMatch = input.match(/BV[a-zA-Z0-9]{10}/);
  if (bvMatch) return { type: 'bvid', value: bvMatch[0] };

  // 匹配AV号
  const avMatch = input.match(/av(\d+)/i);
  if (avMatch) return { type: 'aid', value: parseInt(avMatch[1]) };

  // 纯数字视为AV号
  const numMatch = input.match(/^(\d+)$/);
  if (numMatch) return { type: 'aid', value: parseInt(numMatch[1]) };

  // 从URL中提取
  const urlMatch = input.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]{10})/);
  if (urlMatch) return { type: 'bvid', value: urlMatch[1] };

  const urlAvMatch = input.match(/bilibili\.com\/video\/av(\d+)/i);
  if (urlAvMatch) return { type: 'aid', value: parseInt(urlAvMatch[1]) };

  return null;
}

// ==================== Wbi签名 ====================
// 参考B站Wbi签名算法实现
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 52, 44, 34
];

function getMixinKey(rawKey) {
  const key = rawKey.slice(0, 32);
  return MIXIN_KEY_ENC_TAB.map(i => key[i]).join('');
}

async function getWbiKeys() {
  const cached = getCache('wbi_keys');
  if (cached) return cached;

  try {
    const result = await fetchUrl('https://api.bilibili.com/x/web-interface/nav');
    const data = result.json;
    if (data && data.data && data.data.wbi_img) {
      const imgUrl = data.data.wbi_img.img_url || '';
      const subUrl = data.data.wbi_img.sub_url || '';

      const imgKey = imgUrl.split('/').pop().split('.')[0];
      const subKey = subUrl.split('/').pop().split('.')[0];

      const keys = { imgKey, subKey, mixinKey: getMixinKey(imgKey + subKey) };
      setCache('wbi_keys', keys, CACHE_TTL.wbiKey);
      return keys;
    }
  } catch (e) {
    console.error('Get Wbi keys error:', e.message);
  }
  return null;
}

async function signWbi(params) {
  const keys = await getWbiKeys();
  if (!keys) return params;

  // 添加wts时间戳
  params.wts = Math.floor(Date.now() / 1000);

  // 按key排序，过滤空值
  const sortedKeys = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();

  // 构建查询字符串
  const queryStr = sortedKeys.map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');

  // 计算签名
  const signStr = queryStr + keys.mixinKey;
  params.w_rid = crypto.createHash('md5').update(signStr).digest('hex');

  return params;
}

// ==================== B站API调用 ====================
async function callBiliApi(apiPath, params = {}, needSign = true) {
  let queryParams = { ...params };

  if (needSign) {
    queryParams = await signWbi(queryParams);
  }

  const queryStr = Object.keys(queryParams)
    .filter(k => queryParams[k] !== undefined && queryParams[k] !== null)
    .map(k => `${k}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const apiUrl = `${BILIBILI_API}${apiPath}?${queryStr}`;
  const result = await fetchUrl(apiUrl);
  return result.json;
}

// ==================== 获取视频信息 ====================
async function getVideoInfo(bvid) {
  const cacheKey = `video_${bvid}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // 解析函数
  const parseInfo = (info) => ({
    bvid: info.bvid,
    aid: info.aid,
    title: info.title,
    cover: info.pic,
    duration: info.duration,
    owner: {
      mid: info.owner?.mid,
      name: info.owner?.name,
      face: info.owner?.face,
    },
    pages: (info.pages || []).map(p => ({
      cid: p.cid,
      title: p.part,
      page: p.page,
      duration: p.duration,
    })),
    // 合集信息（直接从ugc_season提取完整剧集数据）
    collection: info.ugc_season ? (() => {
      const episodes = [];
      if (info.ugc_season.sections) {
        for (const section of info.ugc_season.sections) {
          if (section.episodes) {
            for (const ep of section.episodes) {
              episodes.push({
                bvid: ep.bvid,
                aid: ep.aid,
                cid: ep.cid,
                title: ep.title,
                cover: ep.arc?.pic || ep.cover || '',
                duration: ep.arc?.duration || ep.duration || 0,
                page: ep.page || 1,
                owner: {
                  mid: info.owner?.mid,
                  name: info.owner?.name || '',
                  face: info.owner?.face || '',
                },
              });
            }
          }
        }
      }
      return {
        id: info.ugc_season.id,
        title: info.ugc_season.title,
        cover: info.ugc_season.cover,
        episodeCount: episodes.length,
        episodes: episodes.length > 0 ? episodes : null,
      };
    })() : null,
    stat: {
      view: info.stat?.view,
      danmaku: info.stat?.danmaku,
      reply: info.stat?.reply,
      favorite: info.stat?.favorite,
    },
  });

  // 先尝试带签名请求
  try {
    const data = await callBiliApi('/x/web-interface/view', { bvid }, true);
    if (data && data.code === 0 && data.data) {
      const result = parseInfo(data.data);
      setCache(cacheKey, result, CACHE_TTL.videoInfo);
      return result;
    }
    throw new Error(data?.message || '获取视频信息失败');
  } catch (e1) {
    // 降级：尝试不使用签名
    try {
      const data = await callBiliApi('/x/web-interface/view', { bvid }, false);
      if (data && data.code === 0 && data.data) {
        const result = parseInfo(data.data);
        setCache(cacheKey, result, CACHE_TTL.videoInfo);
        return result;
      }
      throw new Error(data?.message || '获取视频信息失败');
    } catch (e2) {
      throw new Error(e1.message || e2.message || '获取视频信息失败');
    }
  }
}

// ==================== 获取音频流URL（返回所有可能的URL） ====================
async function getAudioUrls(bvid, cid) {
  const cacheKey = `audio_urls_${bvid}_${cid}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const allUrls = []; // [{url, mimeType, bandwidth, source}]

  // 分别请求MP4和DASH格式，收集所有URL
  // fnval=1: 传统MP4/FLV（浏览器<audio>兼容性最好）
  // fnval=4048: DASH+高画质（纯音频m4s，兼容性差但流量小）
  const fnvalOptions = [
    { fnval: 1, label: 'mp4' },
    { fnval: 4048, label: 'dash' },
  ];

  for (const { fnval, label } of fnvalOptions) {
    try {
      console.log(`[AudioURL] Trying fnval=${fnval} (${label}) for ${bvid}/${cid}`);
      const data = await callBiliApi('/x/player/wbi/playurl', {
        bvid, cid, fnval, fnver: 0, fourk: 1, platform: 'web',
      }, true);

      if (data?.code === 0 && data.data) {
        // DASH音频流
        const dash = data.data.dash;
        if (dash?.audio?.length > 0) {
          const audios = dash.audio.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
          for (const audio of audios) {
            const primaryUrl = audio.baseUrl || audio.base_url || audio.url || '';
            if (primaryUrl) {
              allUrls.push({
                url: primaryUrl,
                mimeType: audio.mimeType || audio.mime_type || 'audio/mp4',
                bandwidth: audio.bandwidth || 0,
                source: label + '_primary',
              });
            }
            const backups = audio.backupUrl || audio.backup_url || [];
            for (const bk of backups) {
              if (bk && bk !== primaryUrl) {
                allUrls.push({
                  url: bk,
                  mimeType: audio.mimeType || audio.mime_type || 'audio/mp4',
                  bandwidth: audio.bandwidth || 0,
                  source: label + '_backup',
                });
              }
            }
          }
        }

        // durl流（MP4/FLV，完整视频含音频，浏览器兼容性最好）
        if (data.data.durl?.length > 0) {
          for (const durl of data.data.durl) {
            if (durl.url) {
              allUrls.push({
                url: durl.url,
                mimeType: 'video/mp4',
                bandwidth: 0,
                source: label + '_durl',
              });
            }
            const backups = durl.backup_url || durl.backupUrl || [];
            for (const bk of backups) {
              if (bk) {
                allUrls.push({
                  url: bk,
                  mimeType: 'video/mp4',
                  bandwidth: 0,
                  source: label + '_durl_backup',
                });
              }
            }
          }
        }

        // 不再break，继续收集其他fnval格式的URL
      }
    } catch (e) {
      console.error(`[AudioURL] fnval=${fnval} error:`, e.message);
    }
  }

  if (allUrls.length > 0) {
    console.log(`[AudioURL] Found ${allUrls.length} URLs for ${bvid}/${cid}`);
    setCache(cacheKey, allUrls, CACHE_TTL.audioUrl);
    return allUrls;
  }

  throw new Error('无法获取音频流URL');
}

// ==================== 获取合集信息 ====================
async function getCollectionInfo(seasonId, mid) {
  const cacheKey = `collection_${seasonId}_${mid}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const allVideos = [];

  // 尝试多种API路径（B站合集API可能随版本变化）
  const apiPaths = [
    '/x/polymer/web-space/seasons_archives_list',
    '/x/space/wbi/arc/search',
  ];

  for (const apiPath of apiPaths) {
    try {
      let page = 1;
      let hasMore = true;
      console.log(`[Collection] Trying API: ${apiPath} season_id=${seasonId} mid=${mid}`);

      while (hasMore && page <= 10) {
        let data;
        if (apiPath === '/x/space/wbi/arc/search') {
          // UP主视频搜索（降级方案：获取UP主最近视频）
          data = await callBiliApi(apiPath, {
            mid,
            ps: 50,
            pn: page,
            order: 'pubdate',
          }, true);
        } else {
          data = await callBiliApi(apiPath, {
            mid,
            season_id: seasonId,
            page_num: page,
            page_size: 30,
          }, true);
        }

        if (data && data.code === 0 && data.data) {
          let archives = [];
          let total = 0;
          let pageSize = 30;

          if (apiPath === '/x/space/wbi/arc/search') {
            const list = data.data.list?.vlist || data.data.list?.archives || [];
            archives = list;
            total = data.data.page?.count || list.length;
            pageSize = data.data.page?.ps || 50;
          } else {
            archives = data.data.archives || [];
            total = data.data.page?.total || 0;
            pageSize = data.data.page?.page_size || 30;
          }

          for (const arch of archives) {
            // DEBUG: 打印第一个archive的keys帮助调试
            if (allVideos.length === 0) {
              console.log(`[Collection] First archive keys:`, Object.keys(arch).join(', '));
              console.log(`[Collection] First archive cid:`, arch.cid, 'pages:', JSON.stringify(arch.pages?.slice(0,2)));
            }

            // 构建分P信息：优先用pages数组，否则用arch.cid做单个分P
            let pages = [];
            if (arch.pages && arch.pages.length > 0) {
              pages = arch.pages.map(p => ({
                cid: p.cid,
                title: p.part,
                page: p.page,
                duration: p.duration,
              }));
            } else if (arch.cid) {
              // 合集API可能在archive级别返回cid
              pages = [{
                cid: arch.cid,
                title: '',
                page: 1,
                duration: arch.duration,
              }];
            }
            // 如果都没有cid，跳过这个视频（无法播放）
            if (pages.length === 0) {
              console.log(`[Collection] Skipping ${arch.bvid}: no cid available`);
              continue;
            }

            allVideos.push({
              bvid: arch.bvid,
              aid: arch.aid,
              title: arch.title,
              cover: arch.pic,
              duration: arch.duration,
              owner: {
                mid: arch.owner?.mid || mid,
                name: arch.owner?.name || '',
                face: arch.owner?.face || '',
              },
              pages,
            });
          }

          hasMore = page * pageSize < total;
          page++;

          if (apiPath === '/x/space/wbi/arc/search') {
            // 降级方案只获取3页
            if (page > 3) hasMore = false;
          }
        } else {
          console.log(`[Collection] API ${apiPath} returned code:`, data?.code, data?.message);
          hasMore = false;
        }
      }

      if (allVideos.length > 0) {
        console.log(`[Collection] Got ${allVideos.length} videos from ${apiPath}`);
        setCache(cacheKey, allVideos, CACHE_TTL.collection);
        return allVideos;
      }
    } catch (e) {
      console.error(`[Collection] Error with ${apiPath}:`, e.message);
      // 继续尝试下一个API路径
    }
  }

  // 如果所有API都失败，返回空数组
  console.log('[Collection] All APIs failed, returning empty');
  return [];
}

// ==================== 静态文件服务 ====================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

function serveStatic(reqPath, res) {
  // 安全：防止目录穿越
  let safePath = reqPath.replace(/\.\./g, '');
  safePath = safePath.replace(/\\/g, '/');

  if (safePath === '/' || safePath === '') safePath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, safePath);

  // 检查文件是否存在
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(302, { 'Location': '/' });
    res.end();
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
}

// ==================== 音频流代理 ====================
// 尝试用https模块请求一个CDN URL，返回成功的响应流
function tryCdnUrl(cdnUrl, reqHeaders) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(cdnUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: reqHeaders,
      timeout: 15000,
      rejectUnauthorized: false, // 某些CDN节点证书可能不标准
    };

    const req = lib.request(options, (proxyRes) => {
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        let redirUrl = proxyRes.headers.location;
        if (!redirUrl.startsWith('http')) {
          redirUrl = new URL(redirUrl, cdnUrl).href;
        }
        proxyRes.destroy();
        tryCdnUrl(redirUrl, reqHeaders).then(resolve).catch(reject);
        return;
      }

      if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
        resolve(proxyRes);
      } else {
        proxyRes.destroy();
        reject(new Error(`CDN returned ${proxyRes.statusCode}`));
      }
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('CDN timeout')); });
    req.end();
  });
}

async function proxyAudioStream(params, req, res) {
  try {
    const { bvid, cid } = params;

    if (!bvid || !cid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing bvid or cid parameter' }));
      return;
    }

    // 获取所有可能的音频URL
    const cacheKey = `audio_urls_${bvid}_${cid}`;
    cache.delete(cacheKey);
    const audioUrls = await getAudioUrls(bvid, cid);

    if (!audioUrls || audioUrls.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No audio URLs found' }));
      return;
    }

    // 排序：优先 mp4_durl（浏览器<audio>兼容性最好），然后标准端口，最后其他
    const sortedUrls = [...audioUrls].sort((a, b) => {
      // mp4_durl优先（完整MP4，<audio>直接支持）
      if (a.source.includes('_durl') && !b.source.includes('_durl')) return -1;
      if (!a.source.includes('_durl') && b.source.includes('_durl')) return 1;
      // 标准端口优先
      const nonStdPorts = [':8080', ':8081', ':8082', ':8083', ':8084', ':8085'];
      const aStdPort = !nonStdPorts.some(p => a.url.includes(p));
      const bStdPort = !nonStdPorts.some(p => b.url.includes(p));
      if (aStdPort && !bStdPort) return -1;
      if (!aStdPort && bStdPort) return 1;
      return 0;
    });

    // 构建请求头
    const proxyHeaders = {
      'User-Agent': USER_AGENT,
      'Referer': 'https://www.bilibili.com',
      'Origin': 'https://www.bilibili.com',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
    };

    // 转发Range头（支持seek）
    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    }

    // 逐个尝试URL
    let lastError = null;
    let cdnRes = null;

    for (let i = 0; i < sortedUrls.length; i++) {
      const item = sortedUrls[i];
      console.log(`[Audio] Try ${i + 1}/${sortedUrls.length}: ${item.source} ${item.url.substring(0, 80)}...`);
      try {
        cdnRes = await tryCdnUrl(item.url, proxyHeaders);
        console.log(`[Audio] Success with ${item.source}!`);
        break;
      } catch (e) {
        lastError = e;
        console.log(`[Audio] Failed: ${e.message}`);
        // 继续尝试下一个
      }
    }

    if (!cdnRes) {
      throw new Error(`所有CDN节点均失败: ${lastError?.message || '未知错误'}`);
    }

    // 设置响应头并pipe
    const respHeaders = {
      'Content-Type': cdnRes.headers['content-type'] || 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    };

    if (cdnRes.headers['content-length']) {
      respHeaders['Content-Length'] = cdnRes.headers['content-length'];
    }
    if (cdnRes.headers['content-range']) {
      respHeaders['Content-Range'] = cdnRes.headers['content-range'];
    }

    res.writeHead(cdnRes.statusCode, respHeaders);
    cdnRes.pipe(res);

    cdnRes.on('error', (e) => {
      console.error('[Audio] CDN stream error:', e.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });

    req.on('close', () => {
      if (cdnRes && !cdnRes.destroyed) {
        cdnRes.destroy();
      }
    });

  } catch (e) {
    console.error('[Audio] Proxy error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '音频代理失败' }));
    }
  }
}

// ==================== API路由 ====================
async function handleApi(pathname, query, req, res) {
  const sendJson = (data, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  };

  try {
    // GET /api/video-info?url=xxx 或 ?bvid=xxx
    if (pathname === '/api/video-info' || pathname === '/api/video-info/') {
      let { url: inputUrl, bvid } = query;

      if (inputUrl) {
        inputUrl = decodeURIComponent(inputUrl);

        // 检查是否是短链接
        if (inputUrl.includes('b23.tv') || inputUrl.includes('b23.ink')) {
          const resolved = await resolveShortUrl(inputUrl);
          if (resolved) inputUrl = resolved;
        }

        // 提取视频ID
        const videoId = extractVideoId(inputUrl);
        if (!videoId) {
          sendJson({ error: '无法识别的B站链接，请检查URL或直接输入BV号' }, 400);
          return;
        }
        bvid = videoId.value;
      }

      if (!bvid) {
        sendJson({ error: '请提供视频URL或BV号' }, 400);
        return;
      }

      const info = await getVideoInfo(bvid);
      sendJson(info);
      return;
    }

    // GET /api/audio-stream?bvid=xxx&cid=xxx
    if (pathname === '/api/audio-stream' || pathname === '/api/audio-stream/') {
      await proxyAudioStream(query, req, res);
      return;
    }

    // GET /api/image?url=xxx  (代理B站图片，解决ORB拦截)
    if (pathname === '/api/image' || pathname === '/api/image/') {
      let { url: imgUrl } = query;
      if (!imgUrl) {
        sendJson({ error: 'Missing url parameter' }, 400);
        return;
      }
      imgUrl = decodeURIComponent(imgUrl);

      try {
        const imgResp = await fetch(imgUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': 'https://www.bilibili.com',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(10000),
        });

        const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
        const contentLength = imgResp.headers.get('content-length');
        const cacheControl = 'public, max-age=86400'; // 图片缓存24小时

        const respHeaders = {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': cacheControl,
        };
        if (contentLength) respHeaders['Content-Length'] = contentLength;

        res.writeHead(imgResp.status, respHeaders);
        if (imgResp.body) {
          const nodeStream = Readable.fromWeb(imgResp.body);
          nodeStream.pipe(res);
          nodeStream.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
        } else {
          res.end();
        }
      } catch (e) {
        console.error('[Image] Proxy error:', e.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Image proxy failed');
      }
      return;
    }

    // GET /api/collection?season_id=xxx&mid=xxx
    if (pathname === '/api/collection' || pathname === '/api/collection/') {
      const { season_id, mid } = query;
      if (!season_id || !mid) {
        sendJson({ error: 'Missing season_id or mid' }, 400);
        return;
      }
      const videos = await getCollectionInfo(season_id, mid);
      sendJson(videos);
      return;
    }

    // GET /api/resolve?url=xxx
    if (pathname === '/api/resolve' || pathname === '/api/resolve/') {
      let { url: inputUrl } = query;
      if (!inputUrl) {
        sendJson({ error: 'Missing url parameter' }, 400);
        return;
      }
      inputUrl = decodeURIComponent(inputUrl);

      // 短链接解析
      if (inputUrl.includes('b23.tv') || inputUrl.includes('b23.ink')) {
        const resolved = await resolveShortUrl(inputUrl);
        if (resolved) {
          const videoId = extractVideoId(resolved);
          sendJson({ resolved_url: resolved, video_id: videoId });
          return;
        }
      }

      const videoId = extractVideoId(inputUrl);
      sendJson({ video_id: videoId });
      return;
    }

    // 404 for unknown API routes
    sendJson({ error: 'Unknown API endpoint' }, 404);

  } catch (e) {
    console.error('API error:', e.message);
    if (!res.headersSent) {
      sendJson({ error: e.message || 'Internal server error' }, 500);
    }
  }
}

// ==================== 主服务器 ====================
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // 处理CORS预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // API路由
  if (pathname.startsWith('/api/')) {
    handleApi(pathname, query, req, res);
    return;
  }

  // 静态文件服务
  if (req.method === 'GET') {
    serveStatic(pathname, res);
    return;
  }

  // 其他请求
  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`🎵 BiliAudio 服务已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   按 Ctrl+C 停止服务`);
  console.log('');
  console.log('💡 使用说明:');
  console.log('   1. 在浏览器中打开上面的地址');
  console.log('   2. 粘贴B站视频链接或BV号');
  console.log('   3. 点击解析，享受纯音频播放');
});
