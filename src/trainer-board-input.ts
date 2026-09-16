import type { TrainerSnapshot } from '../shared/trainer.js';

/** Reject input started on an annotation's historical board before grading it. */
export function canSubmitTrainerBoardInput(
  snapshot: Pick<TrainerSnapshot, 'fen' | 'status' | 'prompt'>,
  inputFen: string,
): boolean {
  return snapshot.status === 'awaiting-user'
    && Boolean(snapshot.prompt)
    && snapshot.fen === inputFen;
}
