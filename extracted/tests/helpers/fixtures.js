/**
 * helpers/fixtures.js
 * Shared fixture loaders and large-data generators.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dir, '..', 'fixtures');

// ── File-based loaders ────────────────────────────────────────────────────────

export function loadTextCoords()  { return JSON.parse(readFileSync(join(FIXTURES,'mock-text-coords.json'),'utf8')); }
export function loadNetwork()     { return JSON.parse(readFileSync(join(FIXTURES,'mock-network.json'),'utf8')); }
export function loadStateGraph()  { return JSON.parse(readFileSync(join(FIXTURES,'mock-state-graph.json'),'utf8')); }

// ── Programmatic generators ───────────────────────────────────────────────────

export function generateTextCoords(count = 1000, vpHeight = 800) {
  const cols = 12;
  const words = Array.from({ length: count }, (_, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = 80 + col * 100, y = 60 + row * 22;
    return {
      id: 'w' + i,
      text: ['Lorem','ipsum','dolor','sit','amet','consectetur','adipiscing','elit','sed','do','eiusmod','tempor'][i % 12],
      x, y, width: 60 + (i%5)*8, height: 16, fontSize: 12+(i%4)*2,
      color: ['#333','#555','#111','#666'][i%4],
      xpath: `/html/body/p[${row+1}]/span[${col+1}]`,
      inView: y < vpHeight,
    };
  });
  return { tabId:1, url:'http://localhost:17893/test-page.html',
    viewport:{width:1280,height:vpHeight,scrollX:0,scrollY:0}, timestamp:Date.now(), words };
}

export function generateNetworkRequests(count = 100) {
  const methods=['GET','POST','PUT','DELETE','PATCH'], statuses=[200,201,204,301,400,401,403,404,500];
  return Array.from({length:count},(_,i)=>({
    requestId:'req_'+i, url:`https://api.example.com/resource/${i}`,
    method:methods[i%5], status:statuses[i%9],
    requestBody:i%3===0?{key:'val_'+i}:null, responseBody:i%2===0?{id:i}:null,
    timestamp:Date.now()-(count-i)*1000, durationMs:50+(i%200),
    tokenHints:i%10===0?['Authorization']:[],
  }));
}

export function generateStateGraph(nodeCount = 10) {
  const nodes = new Map();
  for (let i = 0; i < nodeCount; i++) {
    const hash = `state_${i}`;
    const edges = [];
    if (i+1 < nodeCount) edges.push({to:`state_${i+1}`,action:{type:'click',selector:`#btn-${i}`}});
    if (i%5===0 && i+3 < nodeCount) edges.push({to:`state_${i+3}`,action:{type:'click',selector:`#shortcut-${i}`}});
    nodes.set(hash, {hash, label:`State ${i}`, edges});
  }
  return nodes;
}

export function defaultConfig() {
  return {
    mode:'auto', plugins:{textCoords:true,network:true,frameworkState:true},
    security:{allowExecuteJs:true}, debug:{verbose:false},
  };
}
