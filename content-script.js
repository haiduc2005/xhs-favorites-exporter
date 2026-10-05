(function bootstrapFavoritesExporterContentScript() {
  if (window.__XHS_FAVORITES_EXPORTER_CONTENT__) {
    return;
  }

  window.__XHS_FAVORITES_EXPORTER_CONTENT__ = true;

  var BRIDGE_SOURCE = "xhs-favorites-exporter";
  var SHADOW_HOST_ID = "xhs-favorites-exporter-host";
  var SCAN_EVENT = "xhs-favorites-exporter:scan-now";
  var AUTO_SCROLL_DELAY_MS = 1400;
  var MAX_IDLE_ROUNDS = 6;
  var MAX_COLLECT_ROUNDS = 200;
  var MAX_TITLE_LENGTH = 120;
  var STORAGE_KEY = "xhsFavoritesExportState";

  var state = {
    items: new Map(),
    running: false,
    idleRounds: 0,
    rounds: 0,
    channelToken: "",
    lastNetworkAt: 0,
    pageInfo: null,
    statusText: "等待页面就绪",
    timerId: null,
    saveTimerId: null,
    renderQueued: false,
    lastKnownPath: ""
  };

  var ui = {
    host: null,
    shadow: null,
    countValue: null,
    tokenValue: null,
    sourceValue: null,
    statusValue: null,
    startButton: null,
    stopButton: null,
    exportButton: null,
    resetButton: null,
    scanButton: null
  };

  function injectPageBridge() {
    var script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    script.dataset.xhsFavoritesExporter = "true";
    script.dataset.xhsBridgeToken = state.channelToken;
    script.addEventListener("load", function removeAfterLoad() {
      script.remove();
    });

    (document.head || document.documentElement).appendChild(script);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var restoreTried = false;

  function isCollectPage() {
    var path = window.location.pathname;
    return (
      /^\/user\/profile\/[^/]+(\/|$)/.test(path) ||
      /^\/board\/[^/]+\/?$/.test(path)
    );
  }

  function getBoardId() {
    var match = window.location.pathname.match(/^\/board\/([^/]+)/);
    return match ? match[1] : null;
  }

  var SITE_NAME_RE = /^(?:新版小红书|小红书|RedNote|rednote|Red Note|Xiaohongshu)$/i;
  var SITE_SUFFIX_RE = [
    "新版小红书",
    "小红书",
    "RedNote",
    "rednote",
    "Red Note",
    "Xiaohongshu"
  ];

  function stripSiteSuffix(title) {
    var clean = String(title || "")
      .trim()
      .replace(/\s+/g, " ");

    for (var round = 0; round < 4; round += 1) {
      var changed = false;

      SITE_SUFFIX_RE.forEach(function removeSiteName(siteName) {
        var pattern = new RegExp("\\s+[|·\\-–—]\\s*" + siteName + "\\s*$", "i");

        if (pattern.test(clean)) {
          clean = clean.replace(pattern, "").trim();
          changed = true;
        }
      });

      if (!changed) {
        break;
      }
    }

    if (SITE_NAME_RE.test(clean)) {
      return "";
    }

    return clean;
  }

  function sanitizeFileNamePart(text) {
    if (text == null) {
      return null;
    }

    var cleaned = String(text)
      .replace(/[\r\n\t]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, "");

    if (!cleaned) {
      return null;
    }

    if (cleaned.length > 60) {
      cleaned = cleaned.slice(0, 60);
    }

    return cleaned;
  }

  function getCollectionName() {
    if (!/^\/board\//.test(window.location.pathname)) {
      return null;
    }

    return sanitizeFileNamePart(stripSiteSuffix(document.title));
  }

  function getProfileKey() {
    return window.location.pathname.replace(/\/+$/, "");
  }

  function scheduleRender() {
    if (state.renderQueued) {
      return;
    }

    state.renderQueued = true;
    window.requestAnimationFrame(function flushRender() {
      state.renderQueued = false;
      render();
    });
  }

  function recordsEqual(left, right) {
    var fields = [
      "note_id",
      "xsec_token",
      "url",
      "title",
      "author",
      "cover",
      "liked_count",
      "note_type",
      "first_seen_at",
      "last_seen_at"
    ];

    for (var index = 0; index < fields.length; index += 1) {
      if (left[fields[index]] !== right[fields[index]]) {
        return false;
      }
    }

    var leftSources = (left.sources || []).slice().sort().join(",");
    var rightSources = (right.sources || []).slice().sort().join(",");

    return leftSources === rightSources;
  }

  function saveStateNow() {
    if (state.items.size === 0 || !chrome.storage || !chrome.storage.session) {
      return;
    }

    var payload = {
      version: 1,
      profile_key: getProfileKey(),
      page_info: state.pageInfo,
      saved_at: new Date().toISOString(),
      items: Array.from(state.items.values())
    };

    chrome.storage.session
      .set({ xhsFavoritesExportState: payload })
      .catch(function ignoreStorageError() {});
  }

  function scheduleSave() {
    if (state.items.size === 0 || !chrome.storage || !chrome.storage.session) {
      return;
    }

    if (state.saveTimerId) {
      window.clearTimeout(state.saveTimerId);
    }

    state.saveTimerId = window.setTimeout(function flushSave() {
      state.saveTimerId = null;
      saveStateNow();
    }, 600);
  }

  function restoreFromSession() {
    if (restoreTried || !isCollectPage() || !chrome.storage || !chrome.storage.session) {
      return;
    }

    restoreTried = true;

    chrome.storage.session
      .get(STORAGE_KEY)
      .then(function onRestored(result) {
        var saved = result[STORAGE_KEY];

        if (!saved || !Array.isArray(saved.items)) {
          return;
        }

        if (saved.profile_key && saved.profile_key !== getProfileKey()) {
          return;
        }

        var restoredCount = 0;

        saved.items.forEach(function putItem(item) {
          if (!item || !item.note_id) {
            return;
          }

          var current = state.items.get(item.note_id);
          state.items.set(item.note_id, mergeRecord(current, item));
          restoredCount += 1;
        });

        state.pageInfo = saved.page_info || state.pageInfo;
        setStatus("已恢复上次采集结果（" + restoredCount + " 条）");
        scheduleRender();
      })
      .catch(function ignoreRestoreError() {});
  }

  function hidePanel() {
    if (ui.host && ui.host.parentNode) {
      ui.host.parentNode.removeChild(ui.host);
    }

    ui.host = null;
    ui.shadow = null;
    ui.countValue = null;
    ui.tokenValue = null;
    ui.sourceValue = null;
    ui.statusValue = null;
    ui.startButton = null;
    ui.stopButton = null;
    ui.exportButton = null;
    ui.resetButton = null;
    ui.scanButton = null;

    state.lastKnownPath = window.location.pathname;
  }

  function watchPageChanges() {
    window.setInterval(function checkPagePath() {
      var path = window.location.pathname;

      if (path === state.lastKnownPath) {
        return;
      }

      state.lastKnownPath = path;

      if (isCollectPage()) {
        ensurePanel();
        restoreFromSession();
        scanDomCards();
        scheduleRender();
      } else {
        hidePanel();

        if (state.running) {
          stopCollection("已离开收藏页，停止采集");
        }
      }
    }, 1000);
  }

  function ensurePanel() {
    if (ui.host) {
      return;
    }

    var host = document.createElement("div");
    host.id = SHADOW_HOST_ID;
    host.style.position = "fixed";
    host.style.right = "16px";
    host.style.bottom = "16px";
    host.style.zIndex = "2147483647";

    var root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      '<style>' +
      '#panel{' +
      'width:320px;' +
      'background:linear-gradient(180deg,#fffef6 0%,#fff 100%);' +
      'border:1px solid rgba(34,34,34,0.14);' +
      'border-radius:14px;' +
      'box-shadow:0 18px 40px rgba(34,34,34,0.12);' +
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;' +
      'color:#222;' +
      'padding:14px;' +
      '}' +
      '.title{' +
      'font-size:15px;' +
      'font-weight:700;' +
      'margin-bottom:10px;' +
      '}' +
      '.meta{' +
      'display:grid;' +
      'grid-template-columns:1fr 1fr;' +
      'gap:8px;' +
      'margin-bottom:10px;' +
      '}' +
      '.card{' +
      'background:#fff;' +
      'border:1px solid rgba(34,34,34,0.08);' +
      'border-radius:10px;' +
      'padding:8px 10px;' +
      '}' +
      '.label{' +
      'font-size:11px;' +
      'color:#666;' +
      'margin-bottom:4px;' +
      '}' +
      '.value{' +
      'font-size:14px;' +
      'font-weight:600;' +
      'word-break:break-word;' +
      '}' +
      '.status{' +
      'font-size:12px;' +
      'line-height:1.5;' +
      'background:#fff;' +
      'border:1px solid rgba(34,34,34,0.08);' +
      'border-radius:10px;' +
      'padding:10px;' +
      'margin-bottom:10px;' +
      '}' +
      '.buttons{' +
      'display:grid;' +
      'grid-template-columns:repeat(2,minmax(0,1fr));' +
      'gap:8px;' +
      '}' +
      'button{' +
      'appearance:none;' +
      'border:none;' +
      'border-radius:10px;' +
      'padding:10px 12px;' +
      'font-size:13px;' +
      'font-weight:600;' +
      'cursor:pointer;' +
      'transition:transform .12s ease,opacity .12s ease;' +
      '}' +
      'button:hover{' +
      'transform:translateY(-1px);' +
      '}' +
      'button:disabled{' +
      'opacity:.55;' +
      'cursor:not-allowed;' +
      'transform:none;' +
      '}' +
      '.primary{background:#ff2442;color:#fff;}' +
      '.secondary{background:#222;color:#fff;}' +
      '.ghost{background:#f3f3f0;color:#222;}' +
      '.warn{background:#fff0df;color:#9f4c00;}' +
      '.hint{' +
      'font-size:11px;' +
      'line-height:1.5;' +
      'color:#666;' +
      'margin-top:10px;' +
      '}' +
      '</style>' +
      '<div id="panel">' +
      '<div class="title">小红书收藏导出器</div>' +
      '<div class="meta">' +
      '<div class="card"><div class="label">条目数</div><div class="value" data-role="count">0</div></div>' +
      '<div class="card"><div class="label">缺 token</div><div class="value" data-role="token-missing">0</div></div>' +
      '<div class="card" style="grid-column:1 / -1;"><div class="label">来源</div><div class="value" data-role="sources">尚未采集</div></div>' +
      '</div>' +
      '<div class="status" data-role="status">等待页面就绪</div>' +
      '<div class="buttons">' +
      '<button class="primary" data-action="start">开始采集</button>' +
      '<button class="secondary" data-action="stop">停止</button>' +
      '<button class="ghost" data-action="scan">补扫首屏</button>' +
      '<button class="ghost" data-action="export">导出 JSON</button>' +
      '<button class="warn" data-action="reset" style="grid-column:1 / -1;">清空本次结果</button>' +
      '</div>' +
      '<div class="hint">先打开小红书个人页的“收藏”Tab，再刷新一次页面。插件会读首屏 SSR，并拦截后续收藏分页的 XHR。</div>' +
      "</div>";

    ui.host = host;
    ui.shadow = root;
    ui.countValue = root.querySelector('[data-role="count"]');
    ui.tokenValue = root.querySelector('[data-role="token-missing"]');
    ui.sourceValue = root.querySelector('[data-role="sources"]');
    ui.statusValue = root.querySelector('[data-role="status"]');
    ui.startButton = root.querySelector('[data-action="start"]');
    ui.stopButton = root.querySelector('[data-action="stop"]');
    ui.exportButton = root.querySelector('[data-action="export"]');
    ui.resetButton = root.querySelector('[data-action="reset"]');
    ui.scanButton = root.querySelector('[data-action="scan"]');

    ui.startButton.addEventListener("click", startCollection);
    ui.stopButton.addEventListener("click", function handleStopClick() {
      stopCollection();
    });
    ui.exportButton.addEventListener("click", exportResults);
    ui.resetButton.addEventListener("click", resetResults);
    ui.scanButton.addEventListener("click", requestInitialSnapshot);

    (document.body || document.documentElement).appendChild(host);
    render();
  }

  function setStatus(text) {
    state.statusText = text;
    scheduleRender();
  }

  function normalizeText(value) {
    if (value == null) {
      return null;
    }

    var text = String(value).replace(/\s+/g, " ").trim();

    if (!text) {
      return null;
    }

    return text.slice(0, MAX_TITLE_LENGTH);
  }

  function buildNoteUrl(noteId, token) {
    var boardId = getBoardId();
    var baseUrl = boardId
      ? "https://www.rednote.com/board/" +
        encodeURIComponent(boardId) +
        "/" +
        encodeURIComponent(String(noteId))
      : "https://www.rednote.com/explore/" + encodeURIComponent(String(noteId));

    return token
      ? baseUrl + "?xsec_token=" + encodeURIComponent(String(token))
      : baseUrl;
  }

  function sanitizeRecord(input) {
    if (!input || !input.note_id) {
      return null;
    }

    var noteId = String(input.note_id);
    var token = input.xsec_token ? String(input.xsec_token) : null;
    var sources = Array.isArray(input.sources)
      ? input.sources.filter(Boolean)
      : input.source
        ? [String(input.source)]
        : [];

    return {
      note_id: noteId,
      xsec_token: token,
      url: input.url || buildNoteUrl(noteId, token),
      title: normalizeText(input.title),
      author: normalizeText(input.author),
      cover: input.cover || null,
      liked_count: input.liked_count == null ? null : String(input.liked_count),
      note_type: normalizeText(input.note_type),
      source: sources.join(","),
      sources: sources,
      first_seen_at: input.first_seen_at || input.captured_at || new Date().toISOString(),
      last_seen_at: input.last_seen_at || input.captured_at || new Date().toISOString()
    };
  }

  function mergeRecord(existing, incoming) {
    var now = new Date().toISOString();
    var base = existing
      ? {
          note_id: existing.note_id,
          xsec_token: existing.xsec_token,
          url: existing.url,
          title: existing.title,
          author: existing.author,
          cover: existing.cover,
          liked_count: existing.liked_count,
          note_type: existing.note_type,
          sources: Array.isArray(existing.sources) ? existing.sources.slice() : [],
          first_seen_at: existing.first_seen_at,
          last_seen_at: existing.last_seen_at
        }
      : {
          note_id: incoming.note_id,
          xsec_token: null,
          url: null,
          title: null,
          author: null,
          cover: null,
          liked_count: null,
          note_type: null,
          sources: [],
          first_seen_at: incoming.first_seen_at || now,
          last_seen_at: now
        };

    var fields = [
      "xsec_token",
      "url",
      "title",
      "author",
      "cover",
      "liked_count",
      "note_type"
    ];

    for (var index = 0; index < fields.length; index += 1) {
      var field = fields[index];
      var nextValue = incoming[field];

      if (nextValue != null && String(nextValue).trim() !== "") {
        base[field] = nextValue;
      }
    }

    if (!base.url && base.note_id) {
      base.url = buildNoteUrl(base.note_id, base.xsec_token);
    }

    var sourceList = new Set(base.sources);
    (incoming.sources || []).forEach(function appendSource(source) {
      if (source) {
        sourceList.add(source);
      }
    });
    base.sources = Array.from(sourceList);
    base.source = base.sources.join(",");
    base.last_seen_at = incoming.last_seen_at || incoming.captured_at || now;

    return base;
  }

  function mergeItems(rawItems) {
    var added = 0;
    var updated = 0;

    rawItems.forEach(function mergeItem(rawItem) {
      var item = sanitizeRecord(rawItem);

      if (!item) {
        return;
      }

      var current = state.items.get(item.note_id);
      var merged = mergeRecord(current, item);

      if (!current) {
        added += 1;
      } else if (!recordsEqual(current, merged)) {
        updated += 1;
      }

      state.items.set(item.note_id, merged);
    });

    if (added > 0 || updated > 0) {
      scheduleSave();
      scheduleRender();
    }

    return {
      added: added,
      updated: updated
    };
  }

  function parseNoteIdFromHref(href) {
    if (!href) {
      return null;
    }

    try {
      var url = new URL(href, window.location.origin);
      var exploreMatch = url.pathname.match(/\/explore\/([^/?#]+)/);
      var boardMatch = url.pathname.match(/\/board\/([^/?#]+)\/([^/?#]+)/);

      var noteId = exploreMatch
        ? decodeURIComponent(exploreMatch[1])
        : boardMatch
          ? decodeURIComponent(boardMatch[2])
          : null;

      if (!noteId) {
        return null;
      }

      return {
        note_id: noteId,
        board_id: boardMatch ? decodeURIComponent(boardMatch[1]) : null,
        xsec_token: url.searchParams.get("xsec_token"),
        url: url.toString()
      };
    } catch (error) {
      return null;
    }
  }

  function extractTitleFromAnchor(anchor) {
    var imageAlt = anchor.querySelector("img[alt]");

    if (imageAlt && normalizeText(imageAlt.alt)) {
      return normalizeText(imageAlt.alt);
    }

    return normalizeText(anchor.textContent);
  }

  function scanDomCards() {
    if (!isCollectPage()) {
      return { added: 0, updated: 0 };
    }

    var anchors = Array.from(
      document.querySelectorAll('a[href*="/board/"], a[href*="/explore/"]')
    );
    var payload = [];

    anchors.forEach(function collectAnchor(anchor) {
      var parsed = parseNoteIdFromHref(anchor.href || anchor.getAttribute("href"));

      if (!parsed || !parsed.note_id) {
        return;
      }

      payload.push({
        note_id: parsed.note_id,
        xsec_token: parsed.xsec_token,
        url: parsed.url,
        title: extractTitleFromAnchor(anchor),
        source: "dom",
        captured_at: new Date().toISOString()
      });
    });

    return mergeItems(payload);
  }

  function countMissingTokens() {
    var total = 0;

    state.items.forEach(function iterateItem(item) {
      if (!item.xsec_token) {
        total += 1;
      }
    });

    return total;
  }

  function summarizeSources() {
    var summary = {
      ssr: 0,
      xhr: 0,
      dom: 0
    };

    state.items.forEach(function countItem(item) {
      (item.sources || []).forEach(function countSource(source) {
        if (summary[source] != null) {
          summary[source] += 1;
        }
      });
    });

    return "SSR " + summary.ssr + " / XHR " + summary.xhr + " / DOM " + summary.dom;
  }

  function render() {
    if (!ui.host) {
      return;
    }

    ui.countValue.textContent = String(state.items.size);
    ui.tokenValue.textContent = String(countMissingTokens());
    ui.sourceValue.textContent = summarizeSources();
    ui.statusValue.innerHTML = escapeHtml(state.statusText);
    ui.startButton.disabled = state.running;
    ui.stopButton.disabled = !state.running;
    ui.exportButton.disabled = state.items.size === 0;
  }

  function requestInitialSnapshot() {
    window.dispatchEvent(new CustomEvent(SCAN_EVENT));
    setStatus("已请求补扫首屏数据");
  }

  function isNearBottom() {
    var scroller = document.scrollingElement || document.documentElement || document.body;

    if (!scroller) {
      return false;
    }

    return scroller.scrollTop + window.innerHeight >= scroller.scrollHeight - 120;
  }

  function scrollOnce() {
    var scroller = document.scrollingElement || document.documentElement || document.body;

    if (!scroller) {
      return;
    }

    scroller.scrollBy({
      top: Math.max(480, Math.floor(window.innerHeight * 0.82)),
      left: 0,
      behavior: "smooth"
    });
  }

  function stopCollection(reason) {
    state.running = false;

    if (state.timerId) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }

    setStatus(reason || "已停止采集");
  }

  function scheduleNextTick() {
    state.timerId = window.setTimeout(function autoCollectTick() {
      if (!state.running) {
        return;
      }

      if (!isCollectPage()) {
        stopCollection("已离开收藏页，停止采集");
        return;
      }

      state.rounds += 1;
      var before = state.items.size;
      scanDomCards();
      scrollOnce();

      state.timerId = window.setTimeout(function afterScrollTick() {
        if (!state.running) {
          return;
        }

        if (!isCollectPage()) {
          stopCollection("已离开收藏页，停止采集");
          return;
        }

        scanDomCards();

        var after = state.items.size;
        var grew = after > before || Date.now() - state.lastNetworkAt < AUTO_SCROLL_DELAY_MS;

        if (grew) {
          state.idleRounds = 0;
          setStatus("采集中，已收集 " + after + " 条");
        } else {
          state.idleRounds += 1;
          setStatus(
            "滚动中，最近没有新增数据（连续 " + state.idleRounds + " 轮）"
          );
        }

        if (state.idleRounds >= MAX_IDLE_ROUNDS && isNearBottom()) {
          stopCollection("已自动停止：滚动到底且连续多轮无新增");
          return;
        }

        if (state.rounds >= MAX_COLLECT_ROUNDS) {
          stopCollection("已自动停止：达到最大采集轮数 " + MAX_COLLECT_ROUNDS);
          return;
        }

        scheduleNextTick();
      }, AUTO_SCROLL_DELAY_MS);
    }, 120);
  }

  function startCollection() {
    if (state.running) {
      return;
    }

    if (!isCollectPage()) {
      setStatus("请先进入收藏页（个人主页收藏 Tab 或 /board 收藏夹）再开始采集");
      return;
    }

    state.running = true;
    state.idleRounds = 0;
    state.rounds = 0;
    scanDomCards();
    requestInitialSnapshot();
    setStatus("开始采集，准备滚动收藏页");
    scheduleNextTick();
  }

  function resetResults() {
    stopCollection("已清空本次结果");
    state.items.clear();
    state.pageInfo = null;
    state.idleRounds = 0;
    state.rounds = 0;
    state.lastNetworkAt = 0;

    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.remove(STORAGE_KEY).catch(function ignoreClearError() {});
    }

    scheduleRender();
  }

  function exportResults() {
    if (state.items.size === 0) {
      setStatus("当前没有可导出的结果");
      return;
    }

    var items = Array.from(state.items.values()).sort(function sortByTime(left, right) {
      return String(left.first_seen_at).localeCompare(String(right.first_seen_at));
    });

    var collectionName = getCollectionName();

    var payload = {
      exported_at: new Date().toISOString(),
      page_url: window.location.href,
      total_items: items.length,
      missing_token_count: countMissingTokens(),
      page_info: state.pageInfo,
      collection_name: collectionName || null,
      items: items
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[:.]/g, "-");
    var fileName = collectionName
      ? collectionName + "-" + stamp + ".json"
      : "xhs-favorites-" + stamp + ".json";

    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    setStatus("已导出 " + items.length + " 条到 " + fileName);
  }

  function handleBridgeMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== BRIDGE_SOURCE) {
      return;
    }

    var type = event.data.type;
    var payload = event.data.payload || {};

    if (type === "BRIDGE_READY") {
      if (event.data.channel === state.channelToken) {
        setStatus("注入完成。如果你是刚启用插件，现在刷新收藏页一次再开始采集");
      } else {
        setStatus("脚本注入未完成（通道校验失败），请刷新页面重试");
      }
      return;
    }

    if (event.data.channel !== state.channelToken) {
      return;
    }

    if (type === "BRIDGE_XHR_ERROR") {
      if (isCollectPage()) {
        setStatus("收藏分页请求" + (payload.stage || "失败") + "：" + (payload.message || "未知错误") + "，等待页面自动重试");
      }
      return;
    }

    if (type === "XHR_PARSE_ERROR") {
      if (isCollectPage()) {
        setStatus("分页响应解析失败：" + (payload.message || "未知错误"));
      }
      return;
    }

    if (!isCollectPage()) {
      return;
    }

    if (type === "INITIAL_SNAPSHOT") {
      state.pageInfo = payload.page || state.pageInfo;
      mergeItems(payload.items || []);
      setStatus(
        "已拿到首屏 SSR 数据，目前 " + state.items.size + " 条"
      );
      return;
    }

    if (type === "COLLECT_PAGE") {
      state.lastNetworkAt = Date.now();
      state.pageInfo = payload.page || state.pageInfo;
      mergeItems(payload.items || []);
      setStatus(
        "已捕获收藏分页 XHR，目前 " + state.items.size + " 条"
      );
      return;
    }
  }

  function bootstrap() {
    state.channelToken =
      "xhs-" +
      Math.random().toString(36).slice(2) +
      "-" +
      Date.now().toString(36);
    state.lastKnownPath = window.location.pathname;

    window.addEventListener("message", handleBridgeMessage, false);
    injectPageBridge();
    restoreFromSession();

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        function mountAfterDomReady() {
          if (isCollectPage()) {
            ensurePanel();
            restoreFromSession();
          }
          scanDomCards();
        },
        { once: true }
      );
    } else {
      if (isCollectPage()) {
        ensurePanel();
        restoreFromSession();
      }
      scanDomCards();
    }

    watchPageChanges();
  }

  bootstrap();
})();
