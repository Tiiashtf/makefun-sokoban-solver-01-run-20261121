// Room-decomposed push-optimal Sokoban solver.
//
// Idea: a box can never leave its room (every room opens onto the hallway
// through a single door cell, and a box pushed out of it can never be pushed
// back), so the level's push-optimal count is the sum of the rooms' optima.
// The solver therefore
//   1. finds the rooms as the connected components of the floor outside
//      the hallway row, each with its single door cell onto the hallway,
//   2. solves each room push-optimally with A* over push states (player
//      reachability between pushes, an assignment heuristic, dead-square
//      pruning and 2x2 freeze pruning), and
//   3. stitches the rooms together with shortest player walks along the
//      hallway.
// Everything is budgeted by work (expansion caps), never by the clock, so
// two executions write identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right. Every search below uses
// this order, so all tie-breaking is deterministic.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];
const OPP = [1, 0, 3, 2]; // opposite direction of each entry above

// Per-room expansion cap and whole-level fallback caps (work, not time).
const ROOM_EXPANSION_CAP = 150_000;
const ROOM_STATE_CAP = 600_000;
const WHOLE_EXPANSION_CAP = 100_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

interface Room {
  door: number;
  entry: number; // hallway cell next to the door; the player enters from here
  floor: Uint8Array; // room cells (component + door)
  goals: number[];
  boxes: number[]; // sorted initial boxes
}

interface RoomSolution {
  moves: string;
  pushes: number;
  finalPlayer: number;
  finalBoxes: number[];
}

// Cell one step from `i` in direction `d`, or -1 when it leaves the board.
function stepCell(i: number, d: number, w: number, h: number): number {
  const x = i % w;
  const y = (i / w) | 0;
  const nx = x + DX[d]!;
  const ny = y + DY[d]!;
  if (nx < 0 || nx >= w || ny < 0 || ny >= h) return -1;
  return ny * w + nx;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goals: number[] = [];
  const goalSet = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < w; x++) {
      const ch = x < row.length ? row[x]! : '#';
      const i = y * w + x;
      if (ch === '#') {
        wall[i] = 1;
        continue;
      }
      if (ch === '.' || ch === '*' || ch === '+') {
        goals.push(i);
        goalSet[i] = 1;
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet, boxes, player };
}

// Flood fill from `start` over cells where `open[i]` is 1. Returns the
// component as a list of cells.
function flood(w: number, h: number, open: Uint8Array, start: number): number[] {
  const comp: number[] = [];
  const stack = [start];
  const seen = new Uint8Array(w * h);
  seen[start] = 1;
  while (stack.length > 0) {
    const u = stack.pop()!;
    comp.push(u);
    for (let d = 0; d < 4; d++) {
      const v = stepCell(u, d, w, h);
      if (v >= 0 && open[v] && !seen[v]) {
        seen[v] = 1;
        stack.push(v);
      }
    }
  }
  return comp;
}

// Rooms from the level's structure: one hallway row (the player's row) with
// rooms above and below it, each opening onto the hallway through a single
// door cell. A room is a connected component of the floor outside the
// hallway; its door is the one cell of the component next to the hallway.
function findRooms(level: Level): Room[] {
  const { w, h, wall, boxes, goalSet, player } = level;
  const n = w * h;
  const floor = new Uint8Array(n);
  for (let i = 0; i < n; i++) floor[i] = wall[i] ? 0 : 1;
  const hy = (player / w) | 0;
  // The hallway: the contiguous run of floor in the player's row.
  const hall = new Uint8Array(n);
  for (let x = player % w; x >= 0 && floor[hy * w + x]; x--) hall[hy * w + x] = 1;
  for (let x = (player % w) + 1; x < w && floor[hy * w + x]; x++) hall[hy * w + x] = 1;
  // No box or goal may sit in the hallway: the rooms hold them all.
  for (const b of boxes) if (hall[b]) return [];
  for (const g of level.goals) if (hall[g]) return [];
  const boxSet = new Uint8Array(n);
  for (const b of boxes) boxSet[b] = 1;
  const open = floor.slice();
  for (let i = 0; i < n; i++) if (hall[i]) open[i] = 0;
  const seen = new Uint8Array(n);
  const rooms: Room[] = [];
  for (let s = 0; s < n; s++) {
    if (!open[s] || seen[s]) continue;
    const comp = flood(w, h, open, s);
    for (const c of comp) seen[c] = 1;
    let nb = 0;
    let ng = 0;
    for (const c of comp) {
      if (boxSet[c]) nb++;
      if (goalSet[c]) ng++;
    }
    if (nb === 0 && ng === 0) continue; // empty pocket, not a room
    if (nb === 0 || ng === 0 || nb !== ng) return [];
    // The door: the component's one cell next to the hallway.
    let door = -1;
    let entry = -1;
    for (const c of comp) {
      for (let d = 0; d < 4; d++) {
        const v = stepCell(c, d, w, h);
        if (v >= 0 && hall[v]) {
          if (door < 0) {
            door = c;
            entry = v;
          } else if (c !== door) {
            return []; // more than one cell touches the hallway: not one door
          }
        }
      }
    }
    if (door < 0 || entry < 0) return [];
    const roomFloor = new Uint8Array(n);
    for (const c of comp) roomFloor[c] = 1;
    const rGoals: number[] = [];
    const rBoxes: number[] = [];
    for (const c of comp) {
      if (goalSet[c]) rGoals.push(c);
      if (boxSet[c]) rBoxes.push(c);
    }
    rBoxes.sort((a, b) => a - b);
    rooms.push({ door, entry, floor: roomFloor, goals: rGoals, boxes: rBoxes });
  }
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// Shortest player walk from `from` to `to` over cells where `open[i]` is 1,
// or null when unreachable. Fixed direction order: deterministic.
function bfsWalk(
  w: number,
  h: number,
  open: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const n = w * h;
  const prev = new Int32Array(n).fill(-1);
  const prevDir = new Int8Array(n).fill(-1);
  const queue = [from];
  prev[from] = from;
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    for (let d = 0; d < 4; d++) {
      const v = stepCell(u, d, w, h);
      if (v < 0 || !open[v] || prev[v] !== -1) continue;
      prev[v] = u;
      prevDir[v] = d;
      if (v === to) {
        let moves = '';
        let cur = v;
        while (cur !== from) {
          moves = CH[prevDir[cur]!]! + moves;
          cur = prev[cur]!;
        }
        return moves;
      }
      queue.push(v);
    }
  }
  return null;
}

// Cells reachable from `from` over `open` (a Uint8Array reachability map).
function reachableSet(w: number, h: number, open: Uint8Array, from: number): Uint8Array {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = [from];
  seen[from] = 1;
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    for (let d = 0; d < 4; d++) {
      const v = stepCell(u, d, w, h);
      if (v >= 0 && open[v] && !seen[v]) {
        seen[v] = 1;
        queue.push(v);
      }
    }
  }
  return seen;
}

// All permutations of 0..k-1 (k <= 4 here).
function permutations(k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Uint8Array(k);
  const rec = (): void => {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < k; i++) {
      if (used[i]) continue;
      used[i] = 1;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = 0;
    }
  };
  rec();
  return out;
}

interface PushProblem {
  w: number;
  h: number;
  floor: Uint8Array; // cells a box may occupy
  stand: Uint8Array; // cells the player may stand on (floor + entry)
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[]; // sorted initial boxes
  entry: number; // player start cell
  expansionCap: number;
  stateCap: number;
}

// Push-optimal A* for one room (or, as a fallback, a whole small level).
// State: sorted box cells + player cell. Cost: pushes. Heuristic: the
// cheapest assignment of boxes to goals by shortest-path distance.
function solvePushes(prob: PushProblem): RoomSolution | null {
  const { w, h, floor, stand, goals, goalSet, boxes: boxes0, entry } = prob;
  const n = w * h;
  const k = goals.length;
  if (k === 0 || boxes0.length !== k) return null;

  // Dead squares: reverse pulls from the goals. A cell is live when a box on
  // it can be pushed (player standing on a `stand` cell) towards a live cell.
  const live = new Uint8Array(n);
  const liveQueue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    liveQueue.push(g);
  }
  let lhead = 0;
  while (lhead < liveQueue.length) {
    const y = liveQueue[lhead++]!;
    for (let d = 0; d < 4; d++) {
      const x = stepCell(y, OPP[d]!, w, h); // cell the box is pushed from
      if (x < 0 || !floor[x] || live[x]) continue;
      const p = stepCell(x, OPP[d]!, w, h); // where the player stands
      if (p < 0 || !stand[p]) continue;
      live[x] = 1;
      liveQueue.push(x);
    }
  }
  const dead = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (floor[i] && !live[i]) dead[i] = 1;

  // Shortest box-path distances from every goal, over the room floor.
  const distToGoal: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(n).fill(-1);
    dist[g] = 0;
    const queue = [g];
    let qh = 0;
    while (qh < queue.length) {
      const u = queue[qh++]!;
      for (let d = 0; d < 4; d++) {
        const v = stepCell(u, d, w, h);
        if (v >= 0 && floor[v] && dist[v] === -1) {
          dist[v] = dist[u]! + 1;
          queue.push(v);
        }
      }
    }
    distToGoal.push(dist);
  }
  const perms = k <= 5 ? permutations(k) : null;
  const heuristic = (bs: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const perm of perms) {
        let s = 0;
        for (let i = 0; i < k; i++) {
          const d = distToGoal[perm[i]!]![bs[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    // Safety net for unexpectedly many boxes: each box's nearest goal.
    // (Still admissible: it only drops the distinct-goal constraint.)
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let gi = 0; gi < k; gi++) {
        const d = distToGoal[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  const isGoalState = (bs: number[]): boolean => {
    for (const b of bs) if (!goalSet[b]) return false;
    return true;
  };

  // 2x2 freeze: a box in a 2x2 block of walls/boxes with no goal can never move.
  const frozen = (bs: number[]): boolean => {
    const boxSet = new Uint8Array(n);
    for (const b of bs) boxSet[b] = 1;
    for (const b of bs) {
      if (goalSet[b]) continue;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let cy = by - 1; cy <= by; cy++) {
        for (let cx = bx - 1; cx <= bx; cx++) {
          if (cx < 0 || cy < 0 || cx + 1 >= w || cy + 1 >= h) continue;
          let allBlocked = true;
          let hasGoal = false;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const c = (cy + dy) * w + (cx + dx);
              if (goalSet[c]) hasGoal = true;
              if (floor[c] && !boxSet[c]) allBlocked = false;
            }
          }
          if (allBlocked && !hasGoal) return true;
        }
      }
    }
    return false;
  };

  if (isGoalState(boxes0)) {
    return { moves: '', pushes: 0, finalPlayer: entry, finalBoxes: boxes0.slice() };
  }
  for (const b of boxes0) if (dead[b]) return null;

  // A* state store.
  const stBoxes: number[][] = [boxes0.slice()];
  const stPlayer: number[] = [entry];
  const stG: number[] = [0];
  const stParent: number[] = [-1];
  const stPushBox: number[] = [-1];
  const stPushDir: number[] = [-1];
  const keyOf = (bs: number[], p: number): string => bs.join(',') + '|' + p;
  const best = new Map<string, number>();
  best.set(keyOf(boxes0, entry), 0);
  const closed = new Set<string>();
  // Binary heap of [f, g, stateIndex]; ties: deeper first, then earlier index.
  const heap: number[][] = [];
  const h0 = heuristic(boxes0);
  if (h0 === Infinity) return null;
  const heapLess = (a: number[], b: number[]): boolean =>
    a[0]! < b[0]! || (a[0]! === b[0]! && (a[1]! > b[1]! || (a[1]! === b[1]! && a[2]! < b[2]!)));
  const heapPush = (e: number[]): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, 0, 0]);

  let expansions = 0;
  let goalState = -1;
  while (heap.length > 0) {
    const [, g, s] = heapPop();
    const bs = stBoxes[s]!;
    const p = stPlayer[s]!;
    const key = keyOf(bs, p);
    if (closed.has(key)) continue;
    if (best.get(key) !== g) continue;
    closed.add(key);
    if (isGoalState(bs)) {
      goalState = s;
      break;
    }
    if (++expansions > prob.expansionCap) return null;
    // Player reachability once per expansion; every push checks against it.
    const walkOpen = stand.slice();
    for (const b of bs) walkOpen[b] = 0;
    const reach = reachableSet(w, h, walkOpen, p);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      for (let d = 0; d < 4; d++) {
        const dest = stepCell(b, d, w, h);
        if (dest < 0 || !floor[dest]) continue;
        if (bs.indexOf(dest) >= 0) continue;
        const from = stepCell(b, OPP[d]!, w, h);
        if (from < 0 || !stand[from] || !reach[from]) continue;
        if (bs.indexOf(from) >= 0) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, bb) => a - bb);
        let bad = false;
        for (const x of nb) {
          if (dead[x]) {
            bad = true;
            break;
          }
        }
        if (bad) continue;
        if (frozen(nb)) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const ng = g + 1;
        const nkey = keyOf(nb, b);
        const prevBest = best.get(nkey);
        if (prevBest !== undefined && prevBest <= ng) continue;
        if (closed.has(nkey)) continue;
        if (stBoxes.length >= prob.stateCap) return null;
        best.set(nkey, ng);
        const t = stBoxes.length;
        stBoxes.push(nb);
        stPlayer.push(b);
        stG.push(ng);
        stParent.push(s);
        stPushBox.push(b);
        stPushDir.push(d);
        heapPush([ng + hh, ng, t]);
      }
    }
  }
  if (goalState < 0) return null;

  // Reconstruct the push list, then replay it with walks between pushes.
  const pushes: [number, number][] = [];
  for (let t = goalState; t > 0; t = stParent[t]!) {
    pushes.push([stPushBox[t]!, stPushDir[t]!]);
  }
  pushes.reverse();
  let moves = '';
  let curPlayer = entry;
  let curBoxes = boxes0.slice();
  for (const [b, d] of pushes) {
    const from = stepCell(b, OPP[d]!, w, h);
    const walkOpen = stand.slice();
    for (const x of curBoxes) walkOpen[x] = 0;
    const walk = bfsWalk(w, h, walkOpen, curPlayer, from);
    if (walk === null) return null; // cannot happen: reachability was checked
    moves += walk;
    moves += CH[d]!;
    const idx = curBoxes.indexOf(b);
    curBoxes[idx] = stepCell(b, d, w, h);
    curBoxes.sort((a, bb) => a - bb);
    curPlayer = b;
  }
  return { moves, pushes: pushes.length, finalPlayer: curPlayer, finalBoxes: curBoxes };
}

function solveRoom(room: Room, level: Level): RoomSolution | null {
  const { w, h } = level;
  const stand = room.floor.slice();
  stand[room.entry] = 1;
  return solvePushes({
    w,
    h,
    floor: room.floor,
    stand,
    goals: room.goals,
    goalSet: level.goalSet,
    boxes: room.boxes,
    entry: room.entry,
    expansionCap: ROOM_EXPANSION_CAP,
    stateCap: ROOM_STATE_CAP,
  });
}

// Whole-level fallback for small levels (boxes <= 5): the same push A*
// without decomposition.
function solveWhole(level: Level): string | null {
  if (level.boxes.length > 5) return null;
  const { w, h } = level;
  const floor = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) floor[i] = level.wall[i] ? 0 : 1;
  const sol = solvePushes({
    w,
    h,
    floor,
    stand: floor,
    goals: level.goals,
    goalSet: level.goalSet,
    boxes: level.boxes,
    entry: level.player,
    expansionCap: WHOLE_EXPANSION_CAP,
    stateCap: ROOM_STATE_CAP,
  });
  return sol === null ? null : sol.moves;
}

function solveLevel(level: Level): string {
  const { w, h } = level;
  const rooms = findRooms(level);
  // The decomposition must cover every box and every goal exactly once.
  const coveredBoxes = new Set<number>();
  const coveredGoals = new Set<number>();
  for (const r of rooms) {
    for (const b of r.boxes) coveredBoxes.add(b);
    for (const g of r.goals) coveredGoals.add(g);
  }
  const covered =
    rooms.length > 0 &&
    level.boxes.every((b) => coveredBoxes.has(b)) &&
    level.goals.every((g) => coveredGoals.has(g)) &&
    coveredBoxes.size === level.boxes.length &&
    coveredGoals.size === level.goals.length;
  if (covered) {
    let player = level.player;
    let boxes = level.boxes.slice();
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const sol = solveRoom(room, level);
      if (sol === null) {
        ok = false;
        break;
      }
      // Walk from the current player position to this room's entry.
      const walkOpen = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) walkOpen[i] = level.wall[i] ? 0 : 1;
      for (const b of boxes) walkOpen[b] = 0;
      const walk = bfsWalk(w, h, walkOpen, player, room.entry);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      moves += sol.moves;
      player = sol.finalPlayer;
      const nextBoxes: number[] = [];
      const roomBoxSet = new Set(room.boxes);
      for (const b of boxes) if (!roomBoxSet.has(b)) nextBoxes.push(b);
      for (const b of sol.finalBoxes) nextBoxes.push(b);
      nextBoxes.sort((a, b) => a - b);
      boxes = nextBoxes;
    }
    if (ok) return moves;
  }
  const whole = solveWhole(level);
  return whole === null ? '' : whole;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level);
  } catch {
    moves = '';
  }
  // Harden the output step: never remove the output directory itself, only
  // write into it (the grader may run with a root-owned /output inside a
  // sticky parent, where removing the directory fails with EPERM).
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
