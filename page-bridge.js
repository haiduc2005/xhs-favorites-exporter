(function bootstrapFavoritesExporterBridge() {
  if (window.__XHS_FAVORITES_EXPORTER_BRIDGE__) {
    return;
  }

  window.__XHS_FAVORITES_EXPORTER_BRIDGE__ = true;

  var BRIDGE_SOURCE = "xhs-favorites-exporter";
  var COLLECT_PATH = "/api/sns/web/v2/note/collect/page";
  var BOARD_NOTE_PATH = "/api/sns/web/v1/board/note";
  var initialSnapshotSent = false;
  var boardNameSent = false;
  var pollAttempts = 0;
  var maxPollAttempts = 60;
  var channelToken = null;

  function isTargetNoteRequest(url) {
    if (!url || typeof url !== "string") {
      return false;
    }

    if (url.indexOf(COLLECT_PATH) !== -1) {
      return true;
    }

    if (url.indexOf(BOARD_NOTE_PATH) !== -1 || url.indexOf("/board/note") !== -1) {
      return true;
    }

    var isBoardContext = /\/board\//.test(window.location.pathname);
    if (isBoardContext && url.indexOf("board") !== -1 && url.indexOf("note") !== -1) {
      return true;
    }

    return false;
  }

  try {
    var currentScript = document.currentScript;
    channelToken =
      (currentScript &&
        currentScript.dataset &&
        currentScript.dataset.xhsBridgeToken) ||
      null;
  } catch (readTokenError) {
    channelToken = null;
  }

  function emit(type, payload) {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        channel: channelToken,
        type: type,
        payload: payload || {}
      },
      "*"
    );
  }

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function unwrapReactive(value, depth) {
    var nextDepth = depth || 0;

    if (nextDepth > 8 || value == null) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(function mapArrayItem(item) {
        return unwrapReactive(item, nextDepth + 1);
      });
    }

    if (typeof value !== "object") {
      return value;
    }

    if (Object.prototype.hasOwnProperty.call(value, "_rawValue")) {
      return unwrapReactive(value._rawValue, nextDepth + 1);
    }

    if (Object.prototype.hasOwnProperty.call(value, "__v_raw")) {
      return unwrapReactive(value.__v_raw, nextDepth + 1);
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "value") &&
      Object.keys(value).length <= 4
    ) {
      return unwrapReactive(value.value, nextDepth + 1);
    }

    return value;
  }

  function pickFirst(values) {
    for (var index = 0; index < values.length; index += 1) {
      var candidate = values[index];

      if (candidate == null) {
        continue;
      }

      if (typeof candidate === "string" && candidate.trim() === "") {
        continue;
      }

      return candidate;
    }

    return null;
  }

  function resolveCover(noteCard) {
    var cover = noteCard && noteCard.cover ? unwrapReactive(noteCard.cover) : null;
    var infoList = cover && (cover.info_list || cover.infoList);

    if (Array.isArray(infoList)) {
      for (var index = 0; index < infoList.length; index += 1) {
        var item = unwrapReactive(infoList[index]);
        var itemUrl = pickFirst([item && item.url, item && item.urlDefault]);

        if (itemUrl) {
          return itemUrl;
        }
      }
    }

    return pickFirst([
      cover && cover.url,
      cover && cover.default,
      cover && cover.src
    ]);
  }

  function toStringOrNull(value) {
    return value == null ? null : String(value);
  }

  function buildNoteUrl(noteId, token) {
    var boardMatch = window.location.pathname.match(/^\/board\/([^/]+)/);
    var baseUrl = boardMatch
      ? "https://www.rednote.com/board/" +
        encodeURIComponent(boardMatch[1]) +
        "/" +
        encodeURIComponent(String(noteId))
      : "https://www.rednote.com/explore/" + encodeURIComponent(String(noteId));

    return token
      ? baseUrl + "?xsec_token=" + encodeURIComponent(String(token))
      : baseUrl;
  }

  function normalizeFavoriteItem(rawItem, source) {
    var item = unwrapReactive(rawItem) || {};
    var noteCard = unwrapReactive(item.noteCard) || item;
    var user = unwrapReactive(noteCard.user) || unwrapReactive(item.user) || {};
    var interactInfo =
      unwrapReactive(noteCard.interactInfo) ||
      unwrapReactive(noteCard.interact_info) ||
      unwrapReactive(item.interactInfo) ||
      unwrapReactive(item.interact_info) ||
      {};

    var noteId = pickFirst([
      item.id,
      item.noteId,
      item.note_id,
      noteCard.noteId,
      noteCard.note_id
    ]);

    if (!noteId) {
      return null;
    }

    var xsecToken = pickFirst([
      item.xsecToken,
      item.xsec_token,
      noteCard.xsecToken,
      noteCard.xsec_token
    ]);

    var title = pickFirst([
      noteCard.displayTitle,
      noteCard.display_title,
      item.displayTitle,
      item.display_title,
      item.title
    ]);

    var author = pickFirst([
      user.nickName,
      user.nick_name,
      user.nickname,
      user.name
    ]);

    var likedCount = pickFirst([
      interactInfo.likedCount,
      interactInfo.liked_count
    ]);

    var url = buildNoteUrl(noteId, xsecToken);

    return {
      note_id: String(noteId),
      xsec_token: toStringOrNull(xsecToken),
      url: url,
      title: toStringOrNull(title),
      author: toStringOrNull(author),
      cover: toStringOrNull(resolveCover(noteCard)),
      liked_count: toStringOrNull(likedCount),
      note_type: toStringOrNull(pickFirst([noteCard.type, item.type])),
      source: source,
      captured_at: new Date().toISOString()
    };
  }

  function normalizePageInfo(rawQuery) {
    var query = unwrapReactive(rawQuery) || {};

    return {
      cursor: toStringOrNull(pickFirst([query.cursor])),
      has_more: Boolean(
        pickFirst([query.hasMore, query.has_more, query.hasMore === false ? false : null])
      ),
      num: query.num == null ? null : Number(query.num),
      page: query.page == null ? null : Number(query.page)
    };
  }

  function extractFavoriteItems(rawCollection) {
    var collection = unwrapReactive(rawCollection);

    if (Array.isArray(collection)) {
      return collection;
    }

    if (!collection || !isPlainObject(collection)) {
      return [];
    }

    if (Array.isArray(collection.items)) {
      return collection.items;
    }

    if (Array.isArray(collection.notes)) {
      return collection.notes;
    }

    if (Array.isArray(collection.noteList)) {
      return collection.noteList;
    }

    if (Array.isArray(collection.list)) {
      return collection.list;
    }

    return [];
  }

  function collectBoardCandidates(rootState) {
    var boardMatch = window.location.pathname.match(/^\/board\/([^/]+)/);
    if (!boardMatch || !rootState) {
      return [];
    }

    var boardId = boardMatch[1];
    var boardState = unwrapReactive(rootState.board) || {};
    var feedsMap = unwrapReactive(boardState.boardFeedsMap) || {};
    var boardFeed = unwrapReactive(feedsMap[boardId]);

    if (!boardFeed) {
      return [];
    }

    var rawNotes = extractFavoriteItems(boardFeed);
    var normalizedItems = rawNotes
      .map(function mapFavoriteItem(item) {
        return normalizeFavoriteItem(item, "ssr");
      })
      .filter(Boolean);

    if (normalizedItems.length === 0 && !boardFeed.cursor && !boardFeed.hasMore) {
      return [];
    }

    return [{
      items: normalizedItems,
      page: normalizePageInfo({
        cursor: boardFeed.cursor,
        has_more: boardFeed.hasMore != null ? boardFeed.hasMore : boardFeed.has_more
      })
    }];
  }

  function readInitialSnapshot() {
    var rootState = unwrapReactive(window.__INITIAL_STATE__);

    if (!rootState) {
      return null;
    }

    var candidates = collectBoardCandidates(rootState);

    if (candidates.length === 0) {
      candidates = collectProfileCandidates(rootState);
    }

    if (candidates.length === 0) {
      candidates = scanStateForCandidates(rootState, 3);
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort(function sortCandidates(left, right) {
      return scoreCandidate(right) - scoreCandidate(left);
    });

    var best = candidates[0];

    return {
      items: best.items,
      page: best.page,
      board_name: extractBoardNameFromState(rootState)
    };
  }

  function collectProfileCandidates(rootState) {
    var userState = unwrapReactive(rootState.user) || {};
    var notesCollection = unwrapReactive(userState.notes);

    var keys = null;

    if (Array.isArray(notesCollection)) {
      keys = [];
      for (var index = 0; index < notesCollection.length; index += 1) {
        keys.push(String(index));
      }
    } else if (notesCollection && typeof notesCollection === "object") {
      keys = Object.keys(notesCollection);
    }

    if (!keys) {
      return [];
    }

    var candidates = [];

    keys.forEach(function buildCandidate(key) {
      var rawList = Array.isArray(notesCollection)
        ? notesCollection[Number(key)]
        : notesCollection[key];

      if (rawList == null) {
        return;
      }

      var normalizedItems = extractFavoriteItems(rawList)
        .map(function mapFavoriteItem(item) {
          return normalizeFavoriteItem(item, "ssr");
        })
        .filter(Boolean);

      var page = normalizePageInfo(
        resolveQueryAt(unwrapReactive(userState.noteQueries), key)
      );

      if (normalizedItems.length > 0 || page.cursor || page.has_more) {
        candidates.push({ items: normalizedItems, page: page });
      }
    });

    return candidates;
  }

  function scanStateForCandidates(rootState, maxDepth) {
    var candidates = [];
    var seen = new Set();

    function visit(value, depth) {
      if (value == null || depth > maxDepth) {
        return;
      }

      var unwrapped = unwrapReactive(value);

      if (typeof unwrapped !== "object" || seen.has(unwrapped)) {
        return;
      }

      seen.add(unwrapped);

      var normalizedItems = extractFavoriteItems(unwrapped)
        .map(function mapFavoriteItem(item) {
          return normalizeFavoriteItem(item, "ssr");
        })
        .filter(Boolean);

      if (normalizedItems.length > 0) {
        candidates.push({
          items: normalizedItems,
          page: normalizePageInfo(null)
        });
      }

      if (Array.isArray(unwrapped)) {
        for (var index = 0; index < unwrapped.length; index += 1) {
          visit(unwrapped[index], depth + 1);
        }
        return;
      }

      var ownKeys = Object.keys(unwrapped);
      for (var keyIndex = 0; keyIndex < ownKeys.length; keyIndex += 1) {
        visit(unwrapped[ownKeys[keyIndex]], depth + 1);
      }
    }

    visit(rootState, 0);
    return candidates;
  }

  function resolveQueryAt(queriesCollection, key) {
    if (Array.isArray(queriesCollection)) {
      return queriesCollection[Number(key)];
    }

    if (queriesCollection && typeof queriesCollection === "object") {
      return queriesCollection[key];
    }

    return null;
  }

  function scoreCandidate(candidate) {
    var score = 0;

    if (candidate.page.cursor) {
      score += 1000;
    }

    if (candidate.page.has_more) {
      score += 100;
    }

    score += Math.min(candidate.items.length, 500);

    return score;
  }

  function extractBoardNameFromState(rootState) {
    var boardMatch = window.location.pathname.match(/^\/board\/([^/]+)/);

    if (!boardMatch || !rootState) {
      return null;
    }

    var boardId = boardMatch[1];
    var visited = new Set();
    var budget = 20000;
    var steps = 0;
    var found = null;
    var nameKeys = [
      "name",
      "title",
      "boardName",
      "board_name",
      "collectionName",
      "collection_name",
      "displayName",
      "folderName"
    ];

    function plausibleName(text) {
      if (typeof text !== "string" || text.length < 1 || text.length > 60) {
        return false;
      }

      if (/^https?:\/\//i.test(text)) {
        return false;
      }

      if (/^[\d\s:.,\-+]+$/.test(text)) {
        return false;
      }

      return true;
    }

    function visit(value) {
      if (found || value == null || typeof value !== "object") {
        return;
      }

      var unwrapped = unwrapReactive(value);

      if (typeof unwrapped !== "object" || unwrapped == null || visited.has(unwrapped)) {
        return;
      }

      visited.add(unwrapped);
      steps += 1;

      if (steps > budget) {
        return;
      }

      if (!Array.isArray(unwrapped)) {
        var parentKeys = Object.keys(unwrapped);

        for (var index = 0; index < parentKeys.length; index += 1) {
          if (String(unwrapped[parentKeys[index]]) === boardId) {
            for (var nameIndex = 0; nameIndex < nameKeys.length; nameIndex += 1) {
              var nameValue = unwrapped[nameKeys[nameIndex]];

              if (plausibleName(nameValue)) {
                found = String(nameValue).trim();
                return;
              }
            }
          }
        }
      }

      var ownKeys = Object.keys(unwrapped);
      for (var keyIndex = 0; keyIndex < ownKeys.length; keyIndex += 1) {
        visit(unwrapped[ownKeys[keyIndex]]);
      }
    }

    visit(rootState);
    return found;
  }

  function tryEmitInitialSnapshot(force) {
    var snapshot = readInitialSnapshot();

    if (!snapshot) {
      return false;
    }

    if (!force && initialSnapshotSent && snapshot.items.length === 0) {
      return false;
    }

    if (snapshot.items.length > 0 || snapshot.page.cursor || snapshot.page.has_more) {
      emit("INITIAL_SNAPSHOT", snapshot);
      initialSnapshotSent = true;
      return true;
    }

    return false;
  }

  function startInitialStatePolling() {
    var timer = window.setInterval(function pollInitialState() {
      pollAttempts += 1;

      if (!boardNameSent) {
        var boardName = extractBoardNameFromState(
          unwrapReactive(window.__INITIAL_STATE__)
        );

        if (boardName) {
          boardNameSent = true;
          emit("BOARD_INFO", { board_name: boardName });
        }
      }

      if (tryEmitInitialSnapshot(false) || pollAttempts >= maxPollAttempts) {
        window.clearInterval(timer);
      }
    }, 500);
  }

  function parseCollectPayload(responseText) {
    try {
      return JSON.parse(responseText);
    } catch (error) {
      emit("XHR_PARSE_ERROR", {
        message: String(error)
      });
      return null;
    }
  }

  function installXmlHttpRequestHook() {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__xhsFavoritesExporterMeta = {
        method: method ? String(method) : "GET",
        url: url ? String(url) : ""
      };

      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend() {
      var meta = this.__xhsFavoritesExporterMeta;
      var startedAt = Date.now();

      var isCollectRequest = meta && isTargetNoteRequest(meta.url);

      if (isCollectRequest) {
        function emitError(stage, status, url) {
          emit("BRIDGE_XHR_ERROR", {
            stage: stage,
            status: status,
            url: url,
            message: stage === "http" ? "HTTP " + status : "请求" + stage
          });
        }

        this.addEventListener(
          "load",
          function onCollectPageLoaded() {
            var responseUrl = this.responseURL || meta.url || "";
            var isCollectResponse = isTargetNoteRequest(responseUrl);

            if (!isCollectResponse) {
              return;
            }

            var status = typeof this.status === "number" ? this.status : 0;

            if (status < 200 || status >= 300) {
              emitError("http", status, responseUrl);
              return;
            }

            var payload = parseCollectPayload(this.responseText);

            if (!payload) {
              return;
            }

            var data = unwrapReactive(payload.data) || {};
            var notes = Array.isArray(data.notes)
              ? data.notes
              : Array.isArray(data.note_list)
                ? data.note_list
                : [];

            emit("COLLECT_PAGE", {
              status: status,
              url: responseUrl,
              duration_ms: Date.now() - startedAt,
              page: {
                cursor: toStringOrNull(pickFirst([data.cursor])),
                has_more: Boolean(
                  pickFirst([
                    data.has_more,
                    data.hasMore,
                    data.has_more === false ? false : null
                  ])
                ),
                num: data.num == null ? null : Number(data.num)
              },
              items: notes
                .map(function mapApiItem(item) {
                  return normalizeFavoriteItem(item, "xhr");
                })
                .filter(Boolean)
            });
          },
          { once: true }
        );

        this.addEventListener(
          "error",
          function onCollectPageError() {
            emitError(
              "network",
              typeof this.status === "number" ? this.status : 0,
              meta.url
            );
          },
          { once: true }
        );

        this.addEventListener(
          "timeout",
          function onCollectPageTimeout() {
            emitError(
              "timeout",
              typeof this.status === "number" ? this.status : 0,
              meta.url
            );
          },
          { once: true }
        );

        this.addEventListener(
          "abort",
          function onCollectPageAbort() {
            emitError(
              "abort",
              typeof this.status === "number" ? this.status : 0,
              meta.url
            );
          },
          { once: true }
        );
      }

      return originalSend.apply(this, arguments);
    };
  }

  window.addEventListener("xhs-favorites-exporter:scan-now", function forceScan() {
    tryEmitInitialSnapshot(true);
  });

  installXmlHttpRequestHook();
  startInitialStatePolling();
  emit("BRIDGE_READY", {
    collect_path: COLLECT_PATH,
    board_note_path: BOARD_NOTE_PATH
  });
})();
