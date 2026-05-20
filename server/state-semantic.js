/**
 * server/state-semantic.js
 *
 * Semantic label generation, tag extraction, and keyState extraction
 * for state graph nodes in browser-whiskor v3.
 *
 * Generates human-readable labels and machine-searchable tags from:
 *   - URL pathname
 *   - document.title
 *   - UI summary (buttons, links, inputs)
 *   - React state (Redux, Zustand, router, etc.)
 */
'use strict';

// ── Label Generation ─────────────────────────────────────────────────────────

function generateLabel(data, config = {}) {
  const { url, title, uiSummary, reactState, keyState } = data;
  const maxLength = config.labelMaxLength || 80;

  // Step 1: Root label from pathname or title
  let rootLabel = '';
  try {
    if (url) {
      const pathname = new URL(url, 'http://x').pathname;
      rootLabel = pathnameToLabel(pathname);
    }
  } catch (_) {}
  if (!rootLabel && title) {
    rootLabel = cleanTitle(title);
  }
  if (!rootLabel) rootLabel = 'Unknown page';

  // Step 2: State modifiers from keyState and reactState
  const modifiers = [];

  // Auth
  if (keyState?.['user.isLoggedIn'] === true) {
    if (keyState?.['user.email']) {
      modifiers.push('as ' + truncate(keyState['user.email'], 24));
    } else {
      modifiers.push('authenticated');
    }
  }

  // Cart
  if (keyState?.['cart.items.length'] > 0) {
    const n = keyState['cart.items.length'];
    const total = keyState['cart.total'];
    let cartStr = n + ' item' + (n > 1 ? 's' : '');
    if (total != null) cartStr += ', $' + Number(total).toFixed(2);
    modifiers.push(cartStr);
  }

  // Search
  if (keyState?.['filters.query'] || keyState?.['search.q']) {
    const q = keyState['filters.query'] || keyState['search.q'];
    modifiers.push('search: "' + truncate(q, 20) + '"');
  }
  if (keyState?.['results.count'] != null) {
    modifiers.push(keyState['results.count'] + ' results');
  }

  // Checkout
  if (keyState?.['checkout.step'] != null) {
    modifiers.push('step ' + keyState['checkout.step']);
  }

  // Form state
  if (keyState?.['formDirty'] === true) modifiers.push('unsaved');
  if (keyState?.['errors.length'] > 0) {
    modifiers.push(keyState['errors.length'] + ' error' + (keyState['errors.length'] > 1 ? 's' : ''));
  }

  // Modal
  if (keyState?.['modal.isOpen'] === true && keyState?.['modal.type']) {
    modifiers.push('modal: ' + keyState['modal.type']);
  } else if (keyState?.['modal.isOpen'] === true) {
    modifiers.push('modal open');
  }

  // Pagination
  if (keyState?.['pagination.page'] != null) {
    modifiers.push('page ' + keyState['pagination.page']);
  }

  // Loading
  if (keyState?.['isLoading'] === true) modifiers.push('loading');

  // Empty state
  if (keyState?.['isEmpty'] === true) modifiers.push('empty');

  // Step 3: Compose
  let label = rootLabel;
  if (modifiers.length > 0) {
    label += ' (' + modifiers.join(', ') + ')';
  }

  // Step 4: Truncate
  if (label.length > maxLength) {
    label = label.slice(0, maxLength - 3) + '...';
  }

  return label;
}

function pathnameToLabel(pathname) {
  if (!pathname || pathname === '/') return 'Home';

  const parts = pathname.split('/').filter(Boolean);
  const labels = [];

  for (const part of parts) {
    // Convert kebab-case and snake_case to Title Case
    const cleaned = part
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    // Numeric parts → "Step N", "Page N", etc.
    if (/^\d+$/.test(part)) {
      if (labels.length > 0 && labels[labels.length - 1].toLowerCase().includes('step')) {
        labels[labels.length - 1] += ' ' + part;
      } else {
        labels.push('#' + part);
      }
    } else {
      labels.push(cleaned);
    }
  }

  return labels.join(' / ');
}

function cleanTitle(title) {
  // Remove common suffixes: " - SiteName", " | SiteName"
  return title.replace(/\s*[-|]\s*[^-|]+$/, '').trim();
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── Tag Extraction ───────────────────────────────────────────────────────────

function extractTags(data, config = {}) {
  if (!config.autoTagging) return [];

  const { url, uiSummary, reactState, keyState } = data;
  const tags = [];

  // Auth tags
  if (keyState?.['user.isLoggedIn'] === true) tags.push('authenticated');
  else if (keyState?.['auth.isLoggedIn'] === false) tags.push('anonymous');

  // Page type from URL
  try {
    if (url) {
      const pathname = new URL(url, 'http://x').pathname;
      if (pathname === '/') tags.push('home');
      else if (pathname.includes('/cart')) tags.push('cart');
      else if (pathname.includes('/checkout')) tags.push('checkout');
      else if (pathname.includes('/login') || pathname.includes('/signin')) tags.push('login');
      else if (pathname.includes('/signup') || pathname.includes('/register')) tags.push('signup');
      else if (pathname.includes('/profile') || pathname.includes('/account')) tags.push('profile');
      else if (pathname.includes('/settings') || pathname.includes('/preferences')) tags.push('settings');
      else if (pathname.includes('/dashboard') || pathname.includes('/admin')) tags.push('dashboard');
      else if (pathname.includes('/product') || pathname.includes('/item') || pathname.includes('/detail')) tags.push('detail');
      else if (pathname.includes('/search') || pathname.includes('/results')) tags.push('search');
      else if (pathname.includes('/404') || pathname.includes('/not-found')) tags.push('404');
      else if (pathname.includes('/error')) tags.push('error');
      else if (pathname.split('/').filter(Boolean).length >= 2) tags.push('listing');
    }
  } catch (_) {}

  // UI overlay tags
  if (keyState?.['modal.isOpen'] === true) tags.push('modal-open');
  if (keyState?.['drawer.isOpen'] === true) tags.push('drawer-open');
  if (keyState?.['dropdown.isOpen'] === true) tags.push('dropdown-open');

  // Form tags
  if (keyState?.['formDirty'] === true) tags.push('form-dirty');
  if (keyState?.['errors.length'] > 0) tags.push('form-error');
  if (keyState?.['formSubmitted'] === true) tags.push('form-submitted');

  // Data state
  if (keyState?.['isLoading'] === true) tags.push('loading');
  if (keyState?.['isEmpty'] === true) tags.push('empty-state');
  if (keyState?.['isComplete'] === true) tags.push('complete');

  // Navigation
  if (keyState?.['pagination.page'] != null) tags.push('paginated');
  if (keyState?.['filters.query']) tags.push('searched');
  if (keyState?.['filters.sort']) tags.push('sorted');

  // Cart-specific
  if (keyState?.['cart.items.length'] > 0) tags.push('cart-open');
  if (keyState?.['cart.items.length'] === 0 && tags.includes('cart')) tags.push('cart-empty');

  // Custom tags from config
  if (config.customTags) {
    for (const [tag, patterns] of Object.entries(config.customTags)) {
      for (const pattern of patterns) {
        if (url?.includes(pattern) && !tags.includes(tag)) {
          tags.push(tag);
          break;
        }
      }
    }
  }

  return tags;
}

// ── keyState Extraction ──────────────────────────────────────────────────────

function extractKeyState(reactState, config = {}) {
  if (!reactState) return {};

  const keyState = {};

  // Priority 1: Router
  if (reactState.router) {
    if (reactState.router.location?.pathname) {
      keyState['route'] = reactState.router.location.pathname;
    }
    if (reactState.router.location?.search) {
      keyState['route.search'] = reactState.router.location.search;
    }
  }

  // Priority 1: Auth / User
  const userSource = reactState.redux?.user || reactState.redux?.auth ||
                     findInZustand(reactState.zustand, 'user') ||
                     findInZustand(reactState.zustand, 'auth');
  if (userSource) {
    if (userSource.isLoggedIn != null) keyState['user.isLoggedIn'] = userSource.isLoggedIn;
    if (userSource.isAuthenticated != null) keyState['user.isAuthenticated'] = userSource.isAuthenticated;
    if (userSource.email) keyState['user.email'] = userSource.email;
    if (userSource.name) keyState['user.name'] = userSource.name;
    if (userSource.role) keyState['user.role'] = userSource.role;
    if (userSource.id) keyState['user.id'] = userSource.id;
  }

  // Priority 2: Cart
  const cartSource = reactState.redux?.cart ||
                     findInZustand(reactState.zustand, 'cart');
  if (cartSource) {
    if (Array.isArray(cartSource.items)) {
      keyState['cart.items.length'] = cartSource.items.length;
    }
    if (cartSource.total != null) keyState['cart.total'] = cartSource.total;
    if (cartSource.currency) keyState['cart.currency'] = cartSource.currency;
  }

  // Priority 2: Checkout
  const checkoutSource = reactState.redux?.checkout ||
                         findInZustand(reactState.zustand, 'checkout');
  if (checkoutSource) {
    if (checkoutSource.step != null) keyState['checkout.step'] = checkoutSource.step;
    if (checkoutSource.paymentMethod) keyState['checkout.paymentMethod'] = checkoutSource.paymentMethod;
  }

  // Priority 3: Search / Filters
  const searchSource = reactState.redux?.search || reactState.redux?.filters ||
                       findInZustand(reactState.zustand, 'search') ||
                       findInZustand(reactState.zustand, 'filters');
  if (searchSource) {
    if (searchSource.query) keyState['filters.query'] = searchSource.query;
    if (searchSource.q) keyState['search.q'] = searchSource.q;
    if (searchSource.results?.count != null) keyState['results.count'] = searchSource.results.count;
    if (searchSource.sort) keyState['filters.sort'] = searchSource.sort;
  }

  // Priority 3: Boolean flags (scan all stores)
  scanBooleanFlags(reactState, keyState);

  // Priority 3: Count/length/total values
  scanCountValues(reactState, keyState);

  // Priority 3: Top-level short strings
  scanShortStrings(reactState, keyState);

  return keyState;
}

function findInZustand(zustand, key) {
  if (!Array.isArray(zustand)) return null;
  for (const store of zustand) {
    if (store && typeof store === 'object') {
      if (store[key] !== undefined) return store[key];
      // Deep search (depth 1)
      for (const subKey of Object.keys(store)) {
        const sub = store[subKey];
        if (sub && typeof sub === 'object' && sub[key] !== undefined) {
          return sub[key];
        }
      }
    }
  }
  return null;
}

function scanBooleanFlags(reactState, keyState) {
  const sources = [];
  if (reactState.redux) sources.push(reactState.redux);
  if (Array.isArray(reactState.zustand)) sources.push(...reactState.zustand);

  const boolKeys = ['isOpen', 'isVisible', 'isLoading', 'isDirty', 'isComplete',
                    'isEmpty', 'isAuthenticated', 'isLoggedIn', 'formDirty',
                    'formSubmitted', 'hasError', 'modalOpen', 'drawerOpen'];

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of boolKeys) {
      if (keyState[key] !== undefined) continue; // already set
      const val = deepFind(source, key);
      if (typeof val === 'boolean') {
        keyState[key] = val;
      }
    }
  }
}

function scanCountValues(reactState, keyState) {
  const sources = [];
  if (reactState.redux) sources.push(reactState.redux);
  if (Array.isArray(reactState.zustand)) sources.push(...reactState.zustand);

  const countSuffixes = ['Count', 'Length', 'Total', 'Size'];

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    scanForCountKeys(source, '', keyState, countSuffixes, 0);
  }
}

function scanForCountKeys(obj, prefix, keyState, suffixes, depth) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const fullKey = prefix ? prefix + '.' + key : key;
    for (const suffix of suffixes) {
      if (key.endsWith(suffix) && typeof val === 'number' && keyState[fullKey] === undefined) {
        keyState[fullKey] = val;
      }
    }
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      scanForCountKeys(val, fullKey, keyState, suffixes, depth + 1);
    }
  }
}

function scanShortStrings(reactState, keyState) {
  const sources = [];
  if (reactState.redux) sources.push({ redux: reactState.redux });
  if (Array.isArray(reactState.zustand)) sources.push({ zustand: reactState.zustand });

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const topKey of Object.keys(source)) {
      const val = source[topKey];
      if (typeof val === 'string' && val.length < 50 && !keyState[topKey]) {
        keyState[topKey] = val;
      }
    }
  }
}

function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = deepFind(obj[k], key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ── Search States ────────────────────────────────────────────────────────────

function searchStates(graph, query, options = {}) {
  const { searchIn = 'all', limit = 10 } = options;
  if (!graph || !query) return [];

  const q = query.toLowerCase().trim();
  const results = [];

  for (const node of Object.values(graph.nodes || {})) {
    if (node.evicted) continue;
    let score = 0;
    const matchedIn = [];

    // Label search (weight: 2.0)
    if (searchIn === 'all' || searchIn === 'label') {
      if (node.label?.toLowerCase().includes(q)) {
        score += 2.0;
        matchedIn.push('label');
      }
    }

    // Tags search (weight: 1.5)
    if (searchIn === 'all' || searchIn === 'tags') {
      if (node.tags?.some(t => t.toLowerCase().includes(q))) {
        score += 1.5;
        matchedIn.push('tags');
      }
    }

    // URL search (weight: 1.0)
    if (searchIn === 'all' || searchIn === 'url') {
      if (node.url?.toLowerCase().includes(q)) {
        score += 1.0;
        matchedIn.push('url');
      }
    }

    // keyState search (weight: 0.5)
    if (searchIn === 'all' || searchIn === 'keyState') {
      for (const [k, v] of Object.entries(node.keyState || {})) {
        if (String(v).toLowerCase().includes(q)) {
          score += 0.5;
          matchedIn.push('keyState');
          break;
        }
      }
    }

    // Bigram similarity bonus (0-1.0)
    if (score > 0 && node.label) {
      const bigramSim = computeBigramSimilarity(q, node.label.toLowerCase());
      score += bigramSim;
    }

    if (score > 0) {
      results.push({
        hash: node.hash,
        label: node.label,
        url: node.url,
        tags: node.tags || [],
        score: Math.round(score * 100) / 100,
        matchedIn,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function computeBigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const getBigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
    return set;
  };
  const aBigrams = getBigrams(a);
  const bBigrams = getBigrams(b);
  if (!aBigrams.size && !bBigrams.size) return 1;
  if (!aBigrams.size || !bBigrams.size) return 0;
  let inter = 0;
  for (const x of aBigrams) { if (bBigrams.has(x)) inter++; }
  return inter / (aBigrams.size + bBigrams.size - inter);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateLabel,
  extractTags,
  extractKeyState,
  searchStates,
  pathnameToLabel,
  computeBigramSimilarity,
};
