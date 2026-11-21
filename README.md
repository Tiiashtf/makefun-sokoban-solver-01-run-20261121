# Sokoban Solver — make.fun bounty entry

[![make.fun](https://img.shields.io/badge/make.fun-sokoban--solver--01--run--20261121-blue)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A push-optimal Sokoban solver for the
[make.fun bounty "Build the best Sokoban solver, 21 November 2026"](https://make.fun/c/sokoban-solver-01-run-20261121).
One program (`main.ts`, Node 22) answers all 5 instances of a set in a
single run, inside 60 seconds, deterministically.

## How it works

A box can never leave its room: every room opens onto the hallway through
a single door cell, and a box pushed out of it can never be pushed back.
So a level's push-optimal count is the sum of its rooms' optima, and the
solver:

1. finds the rooms as the connected components of the floor outside the
   hallway row, each with its single door cell onto the hallway;
2. solves each room push-optimally with A\* over push states — player
   reachability between pushes, a minimum-assignment heuristic, dead-square
   pruning and 2×2 freeze pruning;
3. stitches the rooms together with shortest player walks along the hallway.

Everything is budgeted by work (expansion caps), never by the wall clock,
so two executions write identical bytes. The output step never removes the
output directory itself, only writes into it.

## Practice score

On the kit's practice set the entry solves every room at its push-optimal
count (13 / 16 / 15+14 / 15+15+17 / 16+14+14+16 pushes), for a practice
score of **1,000,000** (the maximum), against the house baseline
plain-astar 1.0.0.

## Local run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
