import { describe, expect, it } from 'vitest';

import {
  ChapterTrainer,
  importLichessStudyPgn,
  type TrainerSnapshot,
} from '../shared/index.js';
import {
  createRootStudyAnnotationMoment,
  extractStudyAnnotationMoments,
} from './study-annotations.js';
import { canSubmitTrainerBoardInput } from './trainer-board-input.js';

function makeChapter(moves: string, orientation: 'white' | 'black' = 'white') {
  return importLichessStudyPgn(`[Event "Board input fixture"]
[Site "https://lichess.org/study/board-input/chapter"]
[ChapterURL "https://lichess.org/study/board-input/chapter"]
[Orientation "${orientation}"]
[Result "*"]

${moves}`).chapters[0];
}

describe('canSubmitTrainerBoardInput', () => {
  it('allows a move directly from White\'s current root note', () => {
    const chapter = makeChapter('{Develop the pieces. [%cal Ge2e4]} 1. e4 e5 *');
    const rootNote = createRootStudyAnnotationMoment(chapter.rootFen, chapter.rootAnnotations);
    const trainer = new ChapterTrainer(chapter);
    const { snapshot } = trainer.start(100);

    expect(rootNote).not.toBeNull();
    expect(canSubmitTrainerBoardInput(snapshot, rootNote!.fen)).toBe(true);
    expect(trainer.submitUserMove('e2e4', 200).snapshot.status).toBe('line-complete');
    expect(trainer.getAttempts()).toHaveLength(1);
    expect(trainer.getSessionCardGrades()[0].grade).toBe('good');
  });

  it('blocks Black\'s historical root note without an attempt, but allows the current opponent note', () => {
    const chapter = makeChapter('{Choose a defence.} 1. e4 {White occupies the centre.} c5 *', 'black');
    const rootNote = createRootStudyAnnotationMoment(chapter.rootFen, chapter.rootAnnotations);
    const trainer = new ChapterTrainer(chapter);
    const transition = trainer.start(100);
    const [opponentNote] = extractStudyAnnotationMoments(transition);

    expect(rootNote).not.toBeNull();
    expect(canSubmitTrainerBoardInput(transition.snapshot, rootNote!.fen)).toBe(false);
    expect(trainer.getAttempts()).toEqual([]);
    expect(trainer.getSessionCardGrades()).toEqual([]);
    expect(canSubmitTrainerBoardInput(transition.snapshot, opponentNote.fen)).toBe(true);
    expect(trainer.submitUserMove('c7c5', 200).snapshot.status).toBe('line-complete');
  });

  it('distinguishes historical user notes from current opponent notes in the same queue', () => {
    const chapter = makeChapter('1. e4 {Take space.} e5 {Challenge the centre.} 2. Nf3 Nc6 *');
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    const transition = trainer.submitUserMove('e2e4', 200);
    const [userNote, opponentNote] = extractStudyAnnotationMoments(transition);

    expect(transition.snapshot.prompt?.target.uci).toBe('g1f3');
    expect(canSubmitTrainerBoardInput(transition.snapshot, userNote.fen)).toBe(false);
    expect(canSubmitTrainerBoardInput(transition.snapshot, opponentNote.fen)).toBe(true);
    expect(trainer.getAttempts()).toHaveLength(1);
    expect(trainer.submitUserMove('g1f3', 300).snapshot.status).toBe('line-complete');
    expect(trainer.getAttempts()).toHaveLength(2);
  });

  it('rejects a drag started before the trainer advanced, even if the source piece is unchanged', () => {
    const trainer = new ChapterTrainer(makeChapter('1. e4 e5 2. Nf3 Nc6 *'));
    const inputFen = trainer.start(100).snapshot.fen;
    const currentSnapshot = trainer.submitUserMove('e2e4', 200).snapshot;

    expect(canSubmitTrainerBoardInput(currentSnapshot, inputFen)).toBe(false);
    expect(canSubmitTrainerBoardInput(currentSnapshot, currentSnapshot.fen)).toBe(true);
    expect(trainer.getAttempts()).toHaveLength(1);
  });

  it('never submits from a terminal line note and permits only the next active prompt', () => {
    const chapter = makeChapter('1. e4 {First line.} (1. d4 {Second line.}) e5 {Line finished.} *');
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    const finished = trainer.submitUserMove('e2e4', 200);
    const notes = extractStudyAnnotationMoments(finished);

    expect(finished.snapshot.status).toBe('line-complete');
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(canSubmitTrainerBoardInput(finished.snapshot, note.fen)).toBe(false);
    expect(canSubmitTrainerBoardInput(finished.snapshot, finished.snapshot.fen)).toBe(false);
    const next = trainer.continue(300).snapshot;
    expect(next.prompt?.target.uci).toBe('d2d4');
    expect(canSubmitTrainerBoardInput(next, next.fen)).toBe(true);
  });

  it('preserves historical/current note input policy after saving and restoring a session', () => {
    const chapter = makeChapter('1. e4 {Take space.} e5 {Develop next.} 2. Nf3 Nc6 *');
    const trainer = new ChapterTrainer(chapter);
    trainer.start(100);
    const transition = trainer.submitUserMove('e2e4', 200);
    const [historicalNote, currentNote] = extractStudyAnnotationMoments(transition);
    const restored = ChapterTrainer.restoreSession(chapter, trainer.exportSession(250), 1_000);
    const snapshot = restored.getSnapshot();

    expect(canSubmitTrainerBoardInput(snapshot, historicalNote.fen)).toBe(false);
    expect(canSubmitTrainerBoardInput(snapshot, currentNote.fen)).toBe(true);
    expect(restored.getAttempts()).toHaveLength(1);
    expect(restored.submitUserMove('g1f3', 1_100).snapshot.status).toBe('line-complete');
  });

  it('allows current-position validation without turning an illegal move into an SRS failure', () => {
    const trainer = new ChapterTrainer(makeChapter('{Play the first move.} 1. e4 e5 *'));
    const snapshot = trainer.start(100).snapshot;

    expect(canSubmitTrainerBoardInput(snapshot, snapshot.fen)).toBe(true);
    const illegal = trainer.submitUserMove('e2e5', 200);
    expect(illegal.events).toEqual([{ type: 'illegal-move', playedUci: 'e2e5' }]);
    expect(trainer.getSessionCardGrades()).toEqual([]);
    expect(illegal.snapshot.mistakeLineIds).toEqual([]);
    expect(canSubmitTrainerBoardInput(illegal.snapshot, snapshot.fen)).toBe(true);
    trainer.submitUserMove('e2e4', 300);
    expect(trainer.getSessionCardGrades()[0].grade).toBe('good');
  });

  it('preserves known-avoid correction and direct-retry grading for current-position input', () => {
    const trainer = new ChapterTrainer(makeChapter('{Remember the main line.} 1. e4 (1. d4 $2 {Avoid this.}) e5 *'));
    const snapshot = trainer.start(100).snapshot;

    expect(canSubmitTrainerBoardInput(snapshot, snapshot.fen)).toBe(true);
    const wrong = trainer.submitUserMove('d2d4', 200).snapshot;
    expect(wrong.correction?.knownAvoidMove?.annotations.comments).toEqual(['Avoid this.']);
    expect(canSubmitTrainerBoardInput(wrong, snapshot.fen)).toBe(false);
    const retry = trainer.acknowledgeCorrection(250).snapshot;
    expect(retry.prompt?.retry).toBe(true);
    expect(canSubmitTrainerBoardInput(retry, snapshot.fen)).toBe(true);
    trainer.submitUserMove('e2e4', 300);
    expect(trainer.getSessionCardGrades()[0].grade).toBe('again');
  });

  it('requires an active prompt and the exact current FEN', () => {
    const trainer = new ChapterTrainer(makeChapter('1. e4 e5 *'));
    const idle = trainer.getSnapshot();
    expect(canSubmitTrainerBoardInput(idle, idle.fen)).toBe(false);
    const snapshot = trainer.start(100).snapshot;
    expect(canSubmitTrainerBoardInput({ ...snapshot, prompt: undefined }, snapshot.fen)).toBe(false);
    const oppositeTurnFen = snapshot.fen.replace(' w ', ' b ');
    expect(canSubmitTrainerBoardInput(snapshot, oppositeTurnFen)).toBe(false);
    for (const status of ['idle', 'showing-correction', 'line-complete', 'complete'] as const) {
      const nonActive: Pick<TrainerSnapshot, 'fen' | 'status' | 'prompt'> = { ...snapshot, status };
      expect(canSubmitTrainerBoardInput(nonActive, snapshot.fen)).toBe(false);
    }
    trainer.submitUserMove('e2e4', 200);
    const complete = trainer.continue(300).snapshot;
    expect(complete.status).toBe('complete');
    expect(canSubmitTrainerBoardInput(complete, complete.fen)).toBe(false);
  });
});
