import { balanceState, bump, nudgeTasks } from './balance';
const t = (size, ...assignees) => ({ effort_size: size, assignees, status: 'open' });

test('empty or single-member groups are balanced', () => {
  expect(balanceState(['a', 'b'], [])).toBe('balanced');
  expect(balanceState(['a'], [t('big', 'a')])).toBe('balanced');
});
test('even split is balanced, heavy skew is not', () => {
  expect(balanceState(['a', 'b'], [t('big', 'a'), t('big', 'b')])).toBe('balanced');
  expect(balanceState(['a', 'b'], [t('big', 'a'), t('big', 'a')])).toBe('lopsided');
  expect(balanceState(['a', 'b', 'c'], [t('big', 'a'), t('medium', 'b'), t('small', 'c')])).toBe('uneven');
});
test('bump respects limits', () => {
  expect(bump('small', 'more')).toBe('medium');
  expect(bump('big', 'more')).toBe('big');
  expect(bump('small', 'less')).toBe('small');
  expect(bump('medium', 'expected')).toBe('medium');
});
test('nudge needs imbalance and an open big task', () => {
  const open = { ...t('big'), assignees: [] };
  expect(nudgeTasks('balanced', [open])).toHaveLength(0);
  expect(nudgeTasks('uneven', [open])).toHaveLength(1);
  expect(nudgeTasks('uneven', [t('small')])).toHaveLength(0);
});
