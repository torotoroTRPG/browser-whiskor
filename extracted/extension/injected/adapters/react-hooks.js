/**
 * adapters/react-hooks.js  –  MAIN world
 *
 * React hook classification helpers extracted from react.js.
 * Depends on: window.__SI_REACT_SAFE_VAL__ (set by react.js)
 */
'use strict';

function safeVal(v, depth, seen) {
  return window.__SI_REACT_SAFE_VAL__(v, depth, seen);
}

function classifyHook(hook) {
  if (!hook) return { type: 'unknown' };
  var q   = hook.queue;
  var val = hook.memoizedState;

  // useEffect / useLayoutEffect / useInsertionEffect
  if (val && typeof val === 'object' && 'tag' in val && 'create' in val) {
    var t = val.tag;
    if (t === 4) return { type: 'useLayoutEffect' };
    if (t === 8) return { type: 'useInsertionEffect' };
    return { type: 'useEffect' };
  }

  // useRef
  if (val && typeof val === 'object' && 'current' in val && !q) {
    return { type: 'useRef', value: safeVal(val.current) };
  }

  // useState / useReducer
  if (q && typeof q.dispatch === 'function') {
    var fn   = q.lastRenderedReducer;
    var name = fn ? (fn.name || fn.toString().slice(0, 30)) : '';
    var isState = name.indexOf('basicState') !== -1 ||
                  name.indexOf('identity')   !== -1 ||
                  (fn && fn.length === 1);
    return { type: isState ? 'useState' : 'useReducer', value: safeVal(val) };
  }

  // useContext
  if (q === null && hook.dependencies) {
    return { type: 'useContext', value: safeVal(val) };
  }

  // useMemo (queue null, val は [value, deps])
  if (q == null && Array.isArray(val)) {
    return { type: 'useMemo', value: safeVal(val[0]) };
  }

  return { type: 'hook', value: safeVal(val) };
}

function getHooks(fiber, maxHooks) {
  maxHooks = maxHooks || 25;
  var hooks = [];
  var node  = fiber.memoizedState;
  var i     = 0;
  while (node && i < maxHooks) {
    hooks.push(classifyHook(node));
    node = node.next;
    i++;
  }
  return hooks;
}

window.__SI_REACT_HOOKS__ = { classifyHook, getHooks };
