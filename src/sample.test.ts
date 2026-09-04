import { describe, expect, it } from 'vitest';
import { ChapterTrainer } from '../shared/trainer.js';
import { getSampleChapter } from './sample.js';

describe('sample repertoire integration', () => {
  it('uses the same graph trainer and repeats a mistaken route until clean', () => {
    const chapter = getSampleChapter('sample-ruy');
    expect(chapter).toBeDefined();
    expect(chapter!.repertoire.lines.length).toBe(2);
    const trainer = new ChapterTrainer(chapter!.repertoire);
    const initial = trainer.start(100);
    const rootFen = initial.snapshot.fen;

    const correction = trainer.submitUserMove('d2d4', 110);
    expect(correction.snapshot).toMatchObject({
      status: 'showing-correction',
      fen: rootFen,
      correction: { correctMove: { uci: 'e2e4' } },
    });
    let transition = trainer.acknowledgeCorrection(120);
    expect(transition.snapshot).toMatchObject({
      status: 'awaiting-user',
      fen: rootFen,
      prompt: { retry: true, target: { uci: 'e2e4' } },
    });

    let sawMistakeReview = false;
    let guard = 0;
    while (transition.snapshot.status !== 'complete' && guard++ < 100) {
      if (transition.snapshot.phase === 'mistake-review') sawMistakeReview = true;
      if (transition.snapshot.status === 'awaiting-user') {
        transition = trainer.submitUserMove(transition.snapshot.prompt!.target.uci, 130 + guard);
      } else if (transition.snapshot.status === 'line-complete') {
        transition = trainer.continue(130 + guard);
      } else {
        throw new Error(`Unexpected trainer status ${transition.snapshot.status}`);
      }
    }

    expect(guard).toBeLessThan(100);
    expect(sawMistakeReview).toBe(true);
    expect(transition.snapshot).toMatchObject({ phase: 'complete', status: 'complete' });
  });

  it('automatically plays White before prompting the black sample response', () => {
    const chapter = getSampleChapter('sample-najdorf');
    expect(chapter).toBeDefined();
    const start = new ChapterTrainer(chapter!.repertoire).start(100);

    expect(start.snapshot).toMatchObject({
      repertoireColor: 'black',
      status: 'awaiting-user',
      prompt: { target: { uci: 'c7c5' } },
    });
    expect(start.events.map((event) => event.type)).toEqual([
      'line-started',
      'opponent-move',
      'awaiting-user',
    ]);
  });
});
