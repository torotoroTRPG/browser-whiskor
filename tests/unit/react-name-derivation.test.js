/**
 * tests/unit/react-name-derivation.test.js
 * Section 17.x — React adapter name resolution ("Unknown" root fix, T6)
 *
 * Loads the REAL shared/injected/adapters/react.js in a vm sandbox (with a minimal
 * window + Bippy mock) and exercises the actual deriveReactName / typeName /
 * reactKindLabel it exposes — no browser needed.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, '../../shared/injected/adapters/react.js');

let NAME;      // { reactKindLabel, typeName, deriveReactName }
let SERIALIZE; // (fiber, maxNodes) -> { tree, nodes, truncated }

// Build a linear fiber chain of n composite nodes (each named "C").
function chain(n) {
  const root = { tag: 1, type: { __dn: 'C' }, child: null, sibling: null };
  let cur = root;
  for (let i = 1; i < n; i++) {
    const c = { tag: 1, type: { __dn: 'C' }, child: null, sibling: null };
    cur.child = c; cur = c;
  }
  return root;
}

// deriveReactName returns objects built inside the vm realm, so deepStrictEqual
// would trip on the cross-realm prototype. Compare the fields directly.
function assertName(fiber, name, weak) {
  const r = NAME.deriveReactName(fiber);
  assert.strictEqual(r.name, name);
  assert.strictEqual(!!r.weak, weak);
}

before(() => {
  const src = readFileSync(SRC, 'utf8');
  // Minimal Bippy: getDisplayName reads a tagged field; host = string type.
  const Bippy = {
    getDisplayName: (t) => (t && typeof t === 'object' && t.__dn) || null,
    isHostFiber: (f) => typeof f.type === 'string',
    isCompositeFiber: () => false,
    getTimings: () => ({ totalTime: 0, selfTime: 0 }),
  };
  const win = {
    Bippy,
    __SI_REGISTRY__: { register: () => {} },
    __SI_REACT_HOOKS__: { classifyHook: () => ({}), getHooks: () => [] },
    __SI_REACT_STATE_MANAGERS__: { detectStateManagers: () => ({}) },
    console,
  };
  win.window = win;
  const sandbox = { window: win, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  NAME = win.__SI_REACT_NAME__;
  SERIALIZE = win.__SI_REACT_SERIALIZE__;
  assert.ok(NAME && NAME.deriveReactName, 'adapter exposed __SI_REACT_NAME__');
  assert.ok(typeof SERIALIZE === 'function', 'adapter exposed __SI_REACT_SERIALIZE__');
});

describe('17.x React name derivation', () => {
  it('maps fiber tags to readable kind labels', () => {
    assert.strictEqual(NAME.reactKindLabel(7), 'Fragment');
    assert.strictEqual(NAME.reactKindLabel(10), 'Context.Provider');
    assert.strictEqual(NAME.reactKindLabel(11), 'ForwardRef');
    assert.strictEqual(NAME.reactKindLabel(13), 'Suspense');
    assert.strictEqual(NAME.reactKindLabel(16), 'Lazy');
    assert.strictEqual(NAME.reactKindLabel(999), null);
  });

  it('unwraps forwardRef / memo / context / function name', () => {
    assert.strictEqual(NAME.typeName(function LoginForm() {}), 'LoginForm');
    assert.strictEqual(NAME.typeName({ $$typeof: 'ref', render: function Inner() {} }), 'Inner');
    assert.strictEqual(NAME.typeName({ $$typeof: 'memo', type: function Card() {} }), 'Card');
    assert.strictEqual(NAME.typeName({ _context: { displayName: 'ThemeContext' } }), 'ThemeContext');
    assert.strictEqual(NAME.typeName({ displayName: 'Explicit' }), 'Explicit');
  });

  it('prefers bippy displayName, then unwrapped name', () => {
    assertName({ type: { __dn: 'NavBar' }, tag: 1 }, 'NavBar', false);
    assertName({ type: function UserCard() {}, tag: 0 }, 'UserCard', false);
  });

  it('keeps host elements as their tag name', () => {
    assertName({ type: 'div', tag: 5 }, 'div', false);
  });

  it('derives a weak name from the source file in dev builds', () => {
    assertName({ type: {}, tag: 0, _debugSource: { fileName: '/app/src/widgets/LoginForm.tsx' } }, 'LoginForm', true);
  });

  it('falls back to a kind label (weak), never bare "Unknown"', () => {
    assertName({ type: {}, tag: 14 }, 'Memo', true);       // anonymous memo wrapper → its kind
    assertName({ type: {}, tag: 1 }, 'Anonymous', true);   // truly nothing → Anonymous (dimmed), not Unknown
  });
});

describe('17.y React snapshot node budget (size cap)', () => {
  it('caps the node count and flags truncation when the tree is large', () => {
    const r = SERIALIZE(chain(50), 10);
    assert.strictEqual(r.truncated, true, 'hitting the cap marks truncated');
    assert.strictEqual(r.nodes, 10, 'exactly the budget of nodes is serialized');
  });

  it('serializes a small tree whole, without truncation', () => {
    const r = SERIALIZE(chain(5), 100);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.nodes, 5);
    // Depth chain is intact: root → c → c → c → c
    let depth = 0, n = r.tree;
    while (n && n.c) { n = n.c[0]; depth++; }
    assert.strictEqual(depth, 4);
  });
});
