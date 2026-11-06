// Pure balance logic. Cutoffs are proposals: tune them with sample events.
export const SIZES = ['small', 'medium', 'big'];
export const WEIGHT = { small: 1, medium: 2, big: 3 };
export const LABEL = { balanced: 'Looking balanced', uneven: 'A little uneven', lopsided: 'Quite lopsided' };
export const CUTOFFS = { uneven: 1.25, lopsided: 1.75 };

// members: [userId]; tasks: [{effort_size, assignees: [userId]}]
export function loads(members, tasks) {
  const out = {};
  members.forEach((id) => (out[id] = { small: 0, medium: 0, big: 0, weight: 0 }));
  tasks.forEach((t) => t.assignees.forEach((u) => {
    if (out[u]) { out[u][t.effort_size] += 1; out[u].weight += WEIGHT[t.effort_size]; }
  }));
  return out;
}

export function balanceState(members, tasks) {
  if (members.length < 2) return 'balanced';
  const w = Object.values(loads(members, tasks)).map((l) => l.weight);
  const total = w.reduce((a, b) => a + b, 0);
  if (!total) return 'balanced';
  const ratio = Math.max(...w) / (total / w.length);
  return ratio <= CUTOFFS.uneven ? 'balanced' : ratio <= CUTOFFS.lopsided ? 'uneven' : 'lopsided';
}

export const bump = (size, rating) => {
  const i = SIZES.indexOf(size) + (rating === 'more' ? 1 : rating === 'less' ? -1 : 0);
  return SIZES[Math.min(2, Math.max(0, i))];
};

export function nudgeTasks(state, tasks) {
  if (state === 'balanced') return [];
  return tasks.filter((t) => t.status === 'open' && t.assignees.length === 0 && t.effort_size === 'big').slice(0, 2);
}
