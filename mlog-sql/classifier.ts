// Recovers per-stream identity when the real QUIC `stream_id` is unavailable.
//
// Stock moq-rs writes 0 for every stream id, so every stream in a capture
// collapses into one and track identity fails outright. This puts it back.
//
// BATCH ONLY, deliberately. The algorithm needs a whole bucket of objects
// before it can partition it, and it needs the file's header counts and track
// count first. A stream cannot supply either until it ends, so a `zeroed`
// capture is a batch input.
//
// Copied from a1/ts/src/classifier.ts, itself a port of a Rust crate. The only
// changes are for this package's stricter compiler options: every indexed read
// goes through at(). classifier.test.ts checks it against captures that carry
// a real stream_id.
//
// ## Approach: per-bucket globally-optimal chain partition
//
// Two structural facts, guaranteed by draft-ietf-moq-transport section 2.2
// rather than by moq-rs behaviour, carry most of the weight:
//
//  1. A QUIC stream never spans a (group_id, subgroup_id) bucket, so each
//     bucket is an independent partition problem.
//  2. One subgroup_header event is written per real stream, and those events
//     survive the corruption -- only their stream_id FIELD is zeroed. So
//     counting headers per bucket gives the EXACT number of real streams to
//     partition that bucket into. No guessing.
//
// Within a bucket each real stream's object_id sequence is strictly 0,1,2,...
// (a verified invariant, zero exceptions in ground truth), so the problem is:
// partition the bucket's time-ordered events into exactly `kb` strictly
// consecutive chains. That is solved GLOBALLY with dynamic programming over
// (event index, chain frontier state), scored against file-level k-means size
// clusters. An earlier greedy forward pass failed by letting cluster identity
// be hijacked by a locally plausible wrong step.
//
// A backward pass over the same state graph gives, for every decision on the
// optimal path, the cost of the best ALTERNATIVE completion -- a true
// min-marginal. An object whose best alternative is within the ambiguity
// margin is reported `uncertain`, honestly, rather than silently committed.

export type Certainty = "certain" | "uncertain" | "unresolved";

/** One subgroup object event, carrying only what a vanilla capture provides.
 *
 * There is deliberately no `stream_id` here. The classifier must not be able
 * to see the field it is reconstructing, so a test cannot leak ground truth
 * into the guess by accident. */
export interface ObjectInput {
  time: number;
  group_id: number;
  subgroup_id: number;
  object_id: number;
  payload_length: number;
}

export interface ClassifiedObject extends ObjectInput {
  /** Negative, so a recovered id can never be mistaken for a real one. */
  stream_id: number | null;
  certainty: Certainty;
  reason: string | null;
  kind_guess: string | null;
}

export interface ParsedHeader {
  time: number;
  group_id: number;
  subgroup_id: number;
  track_alias: number;
}

export interface ClassifiedHeader extends ParsedHeader {
  stream_id: number | null;
  certainty: Certainty;
  reason: string | null;
}

/** If an alternative full partition scores within this many z-units of the
 *  optimal one, the object decided there is `uncertain`, not `certain`. */
const AMBIGUITY_MARGIN_Z = 1.0;

/** Cost of opening a chain whose first observed object_id is not 0. Real -- a
 *  capture can start mid-stream, and a spec-legal mid-subgroup reset restarts
 *  a bucket on a fresh stream -- but rare, so a partition should pay this
 *  only when no cheaper explanation exists. */
const NONZERO_START_PENALTY = 8.0;

/** Safety valve on the DP state count per event. The reachable space is small
 *  for a realistic bucket of two or three chains; this bounds a pathological
 *  input, trading exactness for time. */
const BEAM_WIDTH = 8192;

/** xs[i], where the caller knows i is in range. Throws when it is not, so a
 *  bug here stops the run instead of putting `undefined` into the arithmetic. */
function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`classifier: index ${i} is outside 0..${xs.length - 1}`);
  return v;
}

interface Cluster { mean_log: number; std_log: number; }

const zscore = (c: Cluster, logSize: number) =>
  Math.abs(logSize - c.mean_log) / c.std_log;

const logSize = (size: number) => Math.log(Math.max(size, 1));

/** 1-D k-means on log(payload_length), with `k` fixed in advance rather than
 *  guessed from the sizes. `k` must come from a signal the corruption does
 *  not touch: the count of distinct track aliases in SUBSCRIBE_OK. */
export function fitClusters(sizes: number[], k: number, iters = 25): Cluster[] {
  k = Math.min(Math.max(k, 1), Math.max(sizes.length, 1));
  const sorted = [...sizes].sort((a, b) => a - b);

  // No sizes at all leaves one cluster that nothing is ever scored against.
  const centers = Array.from({ length: k }, (_, i) => {
    const idx = Math.floor(((i + 0.5) / k) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
  });

  const assign = new Array<number>(sizes.length).fill(0);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < sizes.length; i++) {
      const size = at(sizes, i);
      let best = 0;
      let bestDist = Math.abs(size - at(centers, 0));
      for (let c = 1; c < k; c++) {
        const d = Math.abs(size - at(centers, c));
        if (d < bestDist) { bestDist = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = new Array<number>(k).fill(0);
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < sizes.length; i++) {
      const c = at(assign, i);
      sums[c] = at(sums, c) + at(sizes, i);
      counts[c] = at(counts, c) + 1;
    }
    for (let c = 0; c < k; c++) if (at(counts, c) > 0) centers[c] = at(sums, c) / at(counts, c);
  }

  const sqsum = new Array<number>(k).fill(0);
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < sizes.length; i++) {
    const c = at(assign, i);
    sqsum[c] = at(sqsum, c) + (at(sizes, i) - at(centers, c)) ** 2;
    counts[c] = at(counts, c) + 1;
  }
  return Array.from({ length: k }, (_, c) => {
    // A one-member cluster gets a generic, non-zero spread; a near-constant
    // one is floored so the z-score is not a divide by almost nothing.
    const n = at(counts, c);
    const varc = n > 1 ? at(sqsum, c) / (n - 1) : 1.0;
    return { mean_log: at(centers, c), std_log: Math.max(Math.sqrt(varc), 0.05) };
  });
}

/** One chain frontier: the next object_id it expects, and its size cluster.
 *  A state is the SORTED list of every open chain's frontier, so orderings
 *  that are interchangeable collide in the memo table instead of multiplying. */
type Frontier = [number, number];
type State = Frontier[];

const stateKey = (s: State) => s.map((f) => f[0] + ":" + f[1]).join(",");
const sortState = (s: State) => s.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const copyState = (s: State): State => s.map((f): Frontier => [f[0], f[1]]);

type Action = { kind: "extend"; frontier: number; label: number }
            | { kind: "open"; label: number };

interface Transition { next: State; cost: number; action: Action; }

/** Every legal successor of one state for one event.
 *
 * Two chains with the same (frontier, label) are genuinely interchangeable,
 * so they produce ONE transition rather than two. Exploring both would
 * double-count symmetric states -- and it also hides a real tie, which is why
 * the walk below re-flags that case as ambiguous. */
function transitions(
  state: State, oid: number, lsize: number, kb: number, clusters: Cluster[],
): Transition[] {
  const out: Transition[] = [];
  const seen = new Set<string>();
  for (let idx = 0; idx < state.length; idx++) {
    const [frontier, label] = at(state, idx);
    const k = frontier + ":" + label;
    if (frontier !== oid || seen.has(k)) continue;
    seen.add(k);
    const next = copyState(state);
    at(next, idx)[0] = oid + 1;
    sortState(next);
    out.push({ next, cost: zscore(at(clusters, label), lsize), action: { kind: "extend", frontier, label } });
  }
  if (state.length < kb) {
    const openCost = oid === 0 ? 0.0 : NONZERO_START_PENALTY;
    // Prefer one track per stream: labels stay distinct inside a bucket while
    // that is possible. Only a bucket that provably holds more streams than
    // tracks -- a spec-legal reset split -- may reuse a label.
    const injective = kb <= clusters.length;
    for (let label = 0; label < clusters.length; label++) {
      if (injective && state.some((f) => f[1] === label)) continue;
      const next = copyState(state);
      next.push([oid + 1, label]);
      sortState(next);
      out.push({
        next, cost: openCost + zscore(at(clusters, label), lsize),
        action: { kind: "open", label },
      });
    }
  }
  return out;
}

interface Decision { chain: number; ambiguous: boolean; }
interface BucketSolution { decisions: Decision[]; chain_labels: number[]; }

/** Partition one bucket into exactly `kb` strictly consecutive chains, or
 *  refuse. Forward DP for reachability, backward DP for the min-marginal. */
function solveBucket(
  idxs: number[], records: ObjectInput[], sizes: number[],
  kb: number, clusters: Cluster[],
): BucketSolution | null {
  const n = idxs.length;

  // Forward: layers[i] is every state reachable after i events, best cost.
  const layers: Map<string, { state: State; cost: number }>[] = [];
  layers.push(new Map([["", { state: [], cost: 0 }]]));
  for (let pos = 0; pos < n; pos++) {
    const rec = at(records, at(idxs, pos));
    const lsize = at(sizes, at(idxs, pos));
    const next = new Map<string, { state: State; cost: number }>();
    for (const { state, cost } of at(layers, pos).values()) {
      for (const t of transitions(state, rec.object_id, lsize, kb, clusters)) {
        const key = stateKey(t.next);
        const total = cost + t.cost;
        const seen = next.get(key);
        if (seen === undefined || total < seen.cost) next.set(key, { state: t.next, cost: total });
      }
    }
    if (next.size > BEAM_WIDTH) {
      const costs = [...next.values()].map((v) => v.cost).sort((a, b) => a - b);
      const cutoff = at(costs, BEAM_WIDTH - 1);
      for (const [key, v] of next) if (v.cost > cutoff) next.delete(key);
    }
    if (next.size === 0) return null;
    layers.push(next);
  }

  // Backward over the same layers: best completion cost from each state. A
  // final state must have opened exactly kb chains.
  const completion: Map<string, number>[] = Array.from({ length: n + 1 }, () => new Map());
  for (const { state } of at(layers, n).values()) {
    if (state.length === kb) at(completion, n).set(stateKey(state), 0);
  }
  if (at(completion, n).size === 0) return null;

  for (let pos = n - 1; pos >= 0; pos--) {
    const rec = at(records, at(idxs, pos));
    const lsize = at(sizes, at(idxs, pos));
    const back = new Map<string, number>();
    for (const { state } of at(layers, pos).values()) {
      let best = Infinity;
      for (const t of transitions(state, rec.object_id, lsize, kb, clusters)) {
        const rest = at(completion, pos + 1).get(stateKey(t.next));
        if (rest !== undefined) best = Math.min(best, t.cost + rest);
      }
      if (Number.isFinite(best)) back.set(stateKey(state), best);
    }
    if (back.size === 0) return null;
    completion[pos] = back;
  }

  // Walk the optimal path, tracking chain instances so an event maps to a
  // stable identity, and scoring each decision's margin.
  let state: State = [];
  const instances: { frontier: number; label: number; instance: number }[] = [];
  const chain_labels: number[] = [];
  const decisions: Decision[] = [];

  for (let pos = 0; pos < n; pos++) {
    const rec = at(records, at(idxs, pos));
    const lsize = at(sizes, at(idxs, pos));
    const opts = transitions(state, rec.object_id, lsize, kb, clusters);
    const ranked: { total: number; t: Transition }[] = [];
    for (const t of opts) {
      const rest = at(completion, pos + 1).get(stateKey(t.next));
      if (rest !== undefined) ranked.push({ total: t.cost + rest, t });
    }
    // A stable sort, so a tie keeps the order `transitions` produced: extends
    // in state order, then opens by label. The Rust does the same.
    ranked.sort((a, b) => a.total - b.total);
    const best = ranked[0];
    if (best === undefined) return null;
    const second = ranked[1];
    let ambiguous = second !== undefined && second.total - best.total < AMBIGUITY_MARGIN_Z;

    let chain: number;
    if (best.t.action.kind === "open") {
      chain = chain_labels.length;
      chain_labels.push(best.t.action.label);
      instances.push({ frontier: rec.object_id + 1, label: best.t.action.label, instance: chain });
    } else {
      const { frontier, label } = best.t.action;
      // Two identical (frontier, label) instances are interchangeable: the
      // cost model cannot tell their futures apart, and `transitions` folded
      // them into one edge, so the margin check could not see the tie. The
      // pick is arbitrary and must be flagged here instead.
      const matching = instances.filter((inst) => inst.frontier === frontier && inst.label === label);
      const first = matching[0];
      if (first === undefined) return null;
      if (matching.length > 1) ambiguous = true;
      first.frontier = frontier + 1;
      chain = first.instance;
    }
    decisions.push({ chain, ambiguous });
    state = best.t.next;
  }

  return { decisions, chain_labels };
}

/** Rank clusters by mean+spread in log space. Both rise together for video --
 *  I-frames against P-frames give a higher mean and a wider spread than
 *  audio's tight, near-constant sample size. A naming convenience, not a
 *  guarantee: verify against a labelled file before trusting it. */
function labelClusters(clusters: Cluster[]): string[] {
  const rank = (i: number) => at(clusters, i).mean_log + at(clusters, i).std_log;
  const order = clusters.map((_, i) => i).sort((a, b) => rank(b) - rank(a));
  const labels = clusters.map(() => "unknown");
  const top = order[0];
  const bottom = order[order.length - 1];
  if (top !== undefined) labels[top] = "video";
  if (order.length > 1 && bottom !== undefined) labels[bottom] = "audio";
  return labels;
}

/** Classify object events into inferred stream groups.
 *
 * `k` is the file's distinct track count, from SUBSCRIBE_OK track aliases --
 * a signal the corruption does not touch. `bucketStreams` is the per-bucket
 * count of subgroup_header events, the exact number of real streams in each.
 * A missing entry falls back to a structural lower bound: an object_id seen
 * m times in a bucket needs at least m chains, since one chain holds each
 * object_id at most once.
 */
export function classify(
  records: ObjectInput[], k: number, bucketStreams: Map<string, number>,
): ClassifiedObject[] {
  const sizes = records.map((r) => logSize(r.payload_length));
  const clusters = fitClusters(sizes, k, 25);
  const kindLabels = labelClusters(clusters);

  interface Bucket { key: string; group_id: number; subgroup_id: number; idxs: number[]; }
  const byKey = new Map<string, Bucket>();
  records.forEach((r, i) => {
    const key = r.group_id + "/" + r.subgroup_id;
    const b = byKey.get(key);
    if (b) b.idxs.push(i);
    else byKey.set(key, { key, group_id: r.group_id, subgroup_id: r.subgroup_id, idxs: [i] });
  });

  const out = new Array<ClassifiedObject | null>(records.length).fill(null);
  let nextSynthetic = -1;

  // A deterministic bucket order: numeric by group, then subgroup.
  const buckets = [...byKey.values()]
    .sort((a, b) => a.group_id - b.group_id || a.subgroup_id - b.subgroup_id);

  for (const { key, idxs } of buckets) {
    idxs.sort((a, b) => at(records, a).time - at(records, b).time || a - b);

    const multiplicity = new Map<number, number>();
    for (const i of idxs) {
      const oid = at(records, i).object_id;
      multiplicity.set(oid, (multiplicity.get(oid) ?? 0) + 1);
    }
    const structural = Math.max(1, ...multiplicity.values());
    const kb = Math.max(bucketStreams.get(key) ?? 0, structural);

    const solution = solveBucket(idxs, records, sizes, kb, clusters);
    if (solution === null) {
      // No partition into the header-counted number of streams exists, or the
      // beam pruned into a dead end. Refuse the whole bucket rather than
      // fabricate a split.
      for (const i of idxs) {
        out[i] = finish(at(records, i), null, "unresolved",
          "no valid partition into the header-counted number of streams", null);
      }
      continue;
    }

    const chainIds = solution.chain_labels.map(() => nextSynthetic--);
    for (let pos = 0; pos < idxs.length; pos++) {
      const i = at(idxs, pos);
      const d = at(solution.decisions, pos);
      out[i] = finish(
        at(records, i), at(chainIds, d.chain),
        d.ambiguous ? "uncertain" : "certain",
        d.ambiguous ? "an alternative partition scores within the ambiguity margin" : null,
        at(kindLabels, at(solution.chain_labels, d.chain)));
    }
  }
  return out.map((o, i) => {
    if (o === null) throw new Error(`classifier: object ${i} was never classified`);
    return o;
  });
}

function finish(
  rec: ObjectInput, stream_id: number | null, certainty: Certainty,
  reason: string | null, kind_guess: string | null,
): ClassifiedObject {
  return { ...rec, stream_id, certainty, reason, kind_guess };
}

/** Pair each subgroup_header with the chain the classifier recovered.
 *
 * WHY THIS IS NEEDED. Track resolution runs object -> stream_id -> header ->
 * track_alias -> track name. An object carries no track_alias, so the header
 * is the only link. Giving objects synthetic ids without giving the SAME ids
 * to their headers leaves nothing to join: the object reads -1 while every
 * header still reads 0, and track resolution yields nothing at all.
 *
 * THE RULE. Inside one bucket, sort headers by time and chains by the time of
 * their first object, then zip. A stream's header is written when the stream
 * opens, so it always precedes that stream's first object, which makes the
 * two orderings agree.
 *
 * Checked in the Rust against the 14 capture files that carry a real
 * stream_id: 210 of 210 pairings correct. It is not PROVABLY forced, though.
 * Swapping two adjacent pairs is also time-feasible whenever
 * header[i+1] <= first_object[i], and 2 of those 210 had that property. Those
 * are reported uncertain rather than silently committed.
 */
export function assignHeaders(
  classified: ClassifiedObject[], headers: ParsedHeader[],
): ClassifiedHeader[] {
  const chainStart = new Map<string, Map<number, number>>();
  for (const o of classified) {
    if (o.stream_id === null) continue;
    const key = o.group_id + "/" + o.subgroup_id;
    const m = chainStart.get(key) ?? new Map<number, number>();
    const seen = m.get(o.stream_id);
    if (seen === undefined || o.time < seen) m.set(o.stream_id, o.time);
    chainStart.set(key, m);
  }

  const byBucket = new Map<string, number[]>();
  headers.forEach((h, i) => {
    const key = h.group_id + "/" + h.subgroup_id;
    const b = byBucket.get(key);
    if (b) b.push(i); else byBucket.set(key, [i]);
  });

  const out = new Array<ClassifiedHeader | null>(headers.length).fill(null);
  for (const [bucket, idxs] of byBucket) {
    idxs.sort((a, b) => at(headers, a).time - at(headers, b).time || a - b);
    const chains = [...(chainStart.get(bucket) ?? new Map<number, number>())]
      .map(([sid, t]) => ({ sid, t }))
      .sort((a, b) => a.t - b.t || a.sid - b.sid);

    if (chains.length !== idxs.length) {
      // The classifier resolved a different number of streams than there are
      // headers. Refuse the whole bucket rather than pair part of it
      // arbitrarily.
      for (const i of idxs) {
        out[i] = { ...at(headers, i), stream_id: null, certainty: "unresolved",
                   reason: "header count and recovered chain count disagree" };
      }
      continue;
    }

    for (let pos = 0; pos < idxs.length; pos++) {
      const i = at(idxs, pos);
      const header = at(headers, i);
      const swapNext = pos + 1 < idxs.length &&
                       at(headers, at(idxs, pos + 1)).time <= at(chains, pos).t;
      const swapPrev = pos > 0 && header.time <= at(chains, pos - 1).t;
      const ambiguous = swapNext || swapPrev;
      out[i] = {
        ...header, stream_id: at(chains, pos).sid,
        certainty: ambiguous ? "uncertain" : "certain",
        reason: ambiguous ? "an adjacent header/chain swap is also time-feasible" : null,
      };
    }
  }
  return out.map((h, i) => h ?? ({
    ...at(headers, i), stream_id: null, certainty: "unresolved",
    reason: "no chain in this bucket",
  }));
}
