const fs = require('fs');
const vm = require('vm');

URL.createObjectURL = () => 'blob:fake';
URL.revokeObjectURL = () => {};

let createdScripts = [];
let lastBlob = null;
let lastAnchorDownload = null;

function FakeBlob(parts, opts) {
  this._text = String(parts && parts.length ? parts.join('') : '');
  this._type = opts && opts.type ? opts.type : '';
  lastBlob = this;
}

function makeNode(tag, shadowRoot) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    id: '',
    href: '',
    download: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    remove() {},
    click() { (this._listeners.click || []).forEach((fn) => fn.call(this)); },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; }
  };
  if (tag === 'script') createdScripts.push(node);
  if (tag === 'div' && shadowRoot) node.attachShadow = () => shadowRoot;
  if (tag === 'a') {
    const origClick = node.click;
    node.click = function clickAndRecord() {
      lastAnchorDownload = this.download;
      origClick.call(this);
    };
  }
  return node;
}

function makeShadowRoot() {
  const nodes = {};
  return {
    innerHTML: '',
    querySelector(sel) { if (!nodes[sel]) nodes[sel] = makeNode('span', null); return nodes[sel]; }
  };
}

const shadowRoot = makeShadowRoot();
const windowObj = {
  __XHS_FAVORITES_EXPORTER_CONTENT__: false,
  location: { origin: 'https://www.rednote.com', href: 'https://www.rednote.com/board/6363a278000000000100ab6e', pathname: '/board/6363a278000000000100ab6e' },
  addEventListener(type, fn) { if (type === 'message') this._msg = fn; },
  requestAnimationFrame(cb) { cb(); return 1; },
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
  setInterval() { return 0; },
  clearInterval() {},
  postMessage() {},
  CustomEvent: function CustomEvent(type) { this.type = type; }
};
const sandbox = {
  window: windowObj,
  document: {
    readyState: 'complete',
    title: '小红书',
    documentElement: makeNode('html', null),
    body: makeNode('body', null),
    head: makeNode('head', null),
    createElement: (t) => makeNode(t, shadowRoot),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    dispatchEvent() {}
  },
  chrome: {
    runtime: { getURL: (p) => 'chrome-extension://test/' + p },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } }
  },
  URL, Blob: FakeBlob, console,
  setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
  setInterval: () => 0, clearInterval() {}
};

vm.runInNewContext(fs.readFileSync('content-script.js', 'utf8'), sandbox);

const token = createdScripts[0].dataset.xhsBridgeToken;
const post = (type, payload) =>
  windowObj._msg({ source: windowObj, data: { source: 'xhs-favorites-exporter', channel: token, type, payload } });

post('BOARD_INFO', { board_name: '技术' });
post('COLLECT_PAGE', {
  page: {},
  items: [
    {
      note_id: 'n1',
      xsec_token: 'tok,n1',
      url: 'https://www.rednote.com/board/6363a278000000000100ab6e/n1',
      title: '标题"带引号,和逗号',
      author: '=SUM(A1:A9)',
      cover: 'https://img.example/a.jpg',
      liked_count: '12',
      note_type: 'normal',
      sources: ['ssr', 'xhr'],
      source: 'ssr,xhr',
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-01-02T00:00:00.000Z'
    }
  ]
});

(async () => {
  await new Promise((r) => setTimeout(r, 700));
  const host = sandbox.document.body.children.find((c) => c.id === 'xhs-favorites-exporter-host');
  const root = host.attachShadow();

  // ---- JSON export
  lastBlob = null; lastAnchorDownload = null;
  root.querySelector('[data-action="export"]').click();
  await new Promise((r) => setTimeout(r, 10));
  if (!/^技术-\d{8}\.json$/.test(lastAnchorDownload)) {
    throw new Error('FAIL json filename: ' + lastAnchorDownload);
  }
  const parsed = JSON.parse(lastBlob._text);
  if (parsed.collection_name !== '技术' || parsed.items.length !== 1) {
    throw new Error('FAIL json content: ' + lastBlob._text.slice(0, 120));
  }
  console.log('PASS JSON export:', lastAnchorDownload);

  // ---- CSV export
  lastBlob = null; lastAnchorDownload = null;
  root.querySelector('[data-action="export-csv"]').click();
  await new Promise((r) => setTimeout(r, 10));
  if (!/^技术-\d{8}\.csv$/.test(lastAnchorDownload)) {
    throw new Error('FAIL csv filename: ' + lastAnchorDownload);
  }
  if (lastBlob._type.indexOf('text/csv') !== 0) {
    throw new Error('FAIL csv mime: ' + lastBlob._type);
  }
  const csv = lastBlob._text;
  if (csv.charCodeAt(0) !== 0xfeff) {
    throw new Error('FAIL: CSV missing UTF-8 BOM');
  }
  const body = csv.slice(1);
  if (body.indexOf('"note_id","title","author"') === -1) {
    throw new Error('FAIL: CSV header wrong: ' + body.split('\r\n')[0]);
  }
  if (body.indexOf('标题""带引号,和逗号') === -1) {
    throw new Error('FAIL: CSV title not escaped: ' + body.split('\r\n')[1]);
  }
  if (body.indexOf('"\'=SUM(A1:A9)"') === -1) {
    throw new Error('FAIL: CSV formula injection not neutralized: ' + body.split('\r\n')[1]);
  }
  if (body.indexOf('ssr/xhr') === -1) {
    throw new Error('FAIL: CSV sources not joined: ' + body.split('\r\n')[1]);
  }
  if (body.indexOf('"tok,n1"') === -1) {
    throw new Error('FAIL: CSV token quote handling: ' + body.split('\r\n')[1]);
  }
  console.log('PASS CSV export:', lastAnchorDownload);
  console.log('CSV 第二行:', body.split('\r\n')[1]);

  // ---- Test disabled state after reset
  root.querySelector('[data-action="reset"]').click();
  await new Promise((r) => setTimeout(r, 20));
  if (root.querySelector('[data-action="export"]').disabled !== true) {
    throw new Error('FAIL: export button should be disabled when empty');
  }
  if (root.querySelector('[data-action="export-csv"]').disabled !== true) {
    throw new Error('FAIL: export-csv button should be disabled when empty');
  }
  console.log('PASS disabled state: both export buttons disabled when empty');
  process.exit(0);
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});