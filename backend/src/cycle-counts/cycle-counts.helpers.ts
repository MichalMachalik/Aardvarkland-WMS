import { CycleCountPlanStatus } from './cycle-counts.types';

export const MAX_COUNT_QUANTITY = 2_147_483_647;

export function countSubmissionPlanUpdate(planId: string, variance: number) {
  const accepted: CycleCountPlanStatus[] = [CycleCountPlanStatus.RELEASED, CycleCountPlanStatus.COUNTING];
  if (variance !== 0) accepted.push(CycleCountPlanStatus.RECONCILING);
  return {
    where: { id: planId, status: { in: accepted } },
    data: { status: variance === 0 ? CycleCountPlanStatus.COUNTING : CycleCountPlanStatus.RECONCILING },
  };
}

export function calculateCountVariance(
  expectedQuantity: number | null,
  countedQuantity: number,
): number {
  return countedQuantity - (expectedQuantity ?? 0);
}

export function shouldAutoReconcileCount(
  expectedQuantity: number | null,
  countedQuantity: number,
): boolean {
  return calculateCountVariance(expectedQuantity, countedQuantity) === 0;
}

export function makeCycleCountPlanCode(date = new Date()): string {
  const compact = date
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  return `CC-${compact}`;
}
